"""Restore checksum-verified public historical seeds after an empty first fetch.

No source is fetched and no observation date, publication time, acquisition time
or revision is manufactured here. Live observations always have priority. A
manifest is an explicit file/id allow-list, not permission to create new data.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from datetime import date, datetime
from pathlib import Path

DEFAULT_BOOTSTRAP_DIR = Path(__file__).resolve().parents[1] / 'data' / 'industry' / 'bootstrap'
BOOTSTRAP_NOTE = '已核验历史缓存；等待当前官方来源检查。保留原观测、发布时间、获取时间与版本，未生成新数据。'


def _numeric(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def _load_json(raw, label):
    try:
        value = json.loads(raw.decode('utf-8-sig'))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f'{label}不是有效UTF-8 JSON') from error
    if not isinstance(value, dict):
        raise ValueError(f'{label}必须是JSON对象')
    return value


def _allowed_ids(entry, key):
    values = entry.get(key, [])
    if not isinstance(values, list) or any(not isinstance(value, str) or not value for value in values) or len(set(values)) != len(values):
        raise ValueError(f'bootstrap manifest {key}必须是无重复的ID列表')
    return set(values)


def _series_shape(series, label):
    if not isinstance(series, dict):
        raise ValueError(f'{label} series必须是JSON对象')
    for metric_id, record in series.items():
        if not isinstance(metric_id, str) or not metric_id or not isinstance(record, dict):
            raise ValueError(f'{label} series条目必须是指标ID与对象')
        observations = record.get('observations', [])
        if not isinstance(observations, list) or any(not isinstance(point, dict) for point in observations):
            raise ValueError(f'{label} observations必须是对象列表')


def _identified_list(records, label):
    if not isinstance(records, list) or any(not isinstance(record, dict) or not isinstance(record.get('id'), str) or not record['id'] for record in records):
        raise ValueError(f'{label}必须是带ID的对象列表')
    ids = [record['id'] for record in records]
    if len(set(ids)) != len(ids):
        raise ValueError(f'{label}包含重复ID')
    return {record['id']: record for record in records}


def _timestamp(value, label, nullable=False):
    if value is None and nullable:
        return
    if not isinstance(value, str) or not value:
        raise ValueError(f'{label}缺少原始日期或时间')
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError(f'{label}日期或时间无效') from error


def _source_fields(record, label):
    for key in ('sourceUrl', 'version'):
        if not isinstance(record.get(key), str) or not record[key]:
            raise ValueError(f'{label}缺少原始{key}')
    if not re.match(r'^https?://', record['sourceUrl']):
        raise ValueError(f'{label} sourceUrl必须是公开网页链接')
    _timestamp(record.get('fetchedAt'), label + ' fetchedAt')
    _timestamp(record.get('publishedAt'), label + ' publishedAt', nullable=True)


def _validate_seed(seed, series_ids, report_ids):
    series = seed.get('series', {})
    _series_shape(series, 'bootstrap')
    if set(series) - series_ids:
        raise ValueError('bootstrap包含manifest未允许的series ID')
    definitions = _identified_list(seed.get('definitions', []), 'bootstrap definitions')
    if set(definitions) - series_ids:
        raise ValueError('bootstrap包含manifest未允许的definition ID')
    for metric_id, record in series.items():
        definition = definitions.get(metric_id)
        if definition is None:
            raise ValueError('bootstrap series缺少对应definition')
        if definition.get('valueType') in {'forecast', 'estimate', 'guidance', 'demo'} or definition.get('observationNature') in {'forecast', 'estimate'}:
            raise ValueError('预测或估算只能保存在researchReports，不能注入实际series')
        seen = set()
        for point in record.get('observations', []):
            if point.get('metricId') != metric_id:
                raise ValueError('bootstrap observation的metricId与series不一致')
            if point.get('isEstimated') or point.get('nature') in {'forecast', 'estimate'} or point.get('observationNature') in {'forecast', 'estimate'}:
                raise ValueError('预测或估算只能保存在researchReports，不能注入实际series')
            if 'value' not in point or point['value'] is not None and not _numeric(point['value']):
                raise ValueError('bootstrap observation value必须是有限数值或null')
            end = point.get('periodEnd')
            try:
                if not isinstance(end, str) or date.fromisoformat(end).isoformat() != end:
                    raise ValueError()
            except ValueError as error:
                raise ValueError('bootstrap observation观测日期无效') from error
            if end > date.today().isoformat():
                raise ValueError('未来预测日期不能注入实际series')
            if end in seen:
                raise ValueError('bootstrap observation包含重复观测日期')
            seen.add(end)
            _source_fields(point, f'bootstrap {metric_id}/{end}')
    reports = _identified_list(seed.get('researchReports', []), 'bootstrap researchReports')
    if set(reports) - report_ids:
        raise ValueError('bootstrap包含manifest未允许的report ID')
    for report_id, report in reports.items():
        facts = report.get('facts', [])
        if not isinstance(facts, list) or any(not isinstance(fact, dict) for fact in facts):
            raise ValueError('bootstrap report facts必须是对象列表')
        if facts:
            if report.get('modelRole') != 'scenario_only' or report.get('modelUseAllowed') is not True:
                raise ValueError('bootstrap report必须明确获准使用且仅作情景背景')
            _source_fields(report, 'bootstrap report ' + report_id)
        for fact in facts:
            if not _numeric(fact.get('value')) or fact.get('nature') not in {'actual', 'estimate', 'forecast'}:
                raise ValueError('bootstrap report fact缺少数值或actual/estimate/forecast身份')
    return definitions, reports


def _cached(record, current_record, filename, checksum):
    result = copy.deepcopy(record)
    result['status'] = 'cached'
    result['note'] = BOOTSTRAP_NOTE + (' 原说明：' + str(record['note']) if record.get('note') else '')
    result['bootstrapFile'] = filename
    result['bootstrapSha256'] = checksum
    # Store the latest failed attempt separately; none of the seed's provenance
    # timestamps are overwritten by today's bootstrap operation.
    if current_record:
        if current_record.get('error'):
            result['error'] = current_record['error']
        if current_record.get('checkedAt'):
            result['bootstrapSourceCheckAt'] = current_record['checkedAt']
    return result


def restore_bootstrap(filename, current, bootstrap_dir=None, backfill_history=False):
    """Return a copied dataset with permitted empty series/reports restored.

    Manifest shape: {"schemaVersion":"1","files":{"file.json":{
      "sha256":"<64 hexadecimal characters>","seriesIds":["metric.id"],
      "reportIds":["report.id"]}}}. The checksum covers the exact snapshot bytes.
    Unknown files, unsafe paths, schema mismatches and checksums raise ValueError;
    the caller may log that error while retaining its current failure dataset.
    """
    if not isinstance(filename, str) or not re.fullmatch(r'[^/\\:]+\.json', filename) or filename == 'manifest.json':
        raise ValueError('bootstrap文件名无效或包含路径')
    if not isinstance(current, dict):
        raise ValueError('current必须是JSON对象')
    folder = Path(bootstrap_dir) if bootstrap_dir is not None else DEFAULT_BOOTSTRAP_DIR
    try:
        manifest = _load_json((folder / 'manifest.json').read_bytes(), 'bootstrap manifest')
    except OSError as error:
        raise ValueError('bootstrap manifest不可读取') from error
    files = manifest.get('files')
    if manifest.get('schemaVersion') != '1' or not isinstance(files, dict):
        raise ValueError('bootstrap manifest schema无效')
    entry = files.get(filename)
    if not isinstance(entry, dict):
        raise ValueError('bootstrap未知文件：manifest未允许该文件')
    expected = entry.get('sha256')
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', expected):
        raise ValueError('bootstrap manifest sha256无效')
    series_ids = _allowed_ids(entry, 'seriesIds')
    report_ids = _allowed_ids(entry, 'reportIds')
    snapshot_path = folder / filename
    if snapshot_path.resolve().parent != folder.resolve():
        raise ValueError('bootstrap快照路径超出目录')
    try:
        raw = snapshot_path.read_bytes()
    except OSError as error:
        raise ValueError('bootstrap快照不可读取') from error
    checksum = hashlib.sha256(raw).hexdigest()
    if checksum != expected.lower():
        raise ValueError('bootstrap快照sha256校验失败')
    seed = _load_json(raw, 'bootstrap snapshot')
    seed_definitions, seed_reports = _validate_seed(seed, series_ids, report_ids)
    _series_shape(current.get('series', {}), 'current')
    current_definitions = _identified_list(current.get('definitions', []), 'current definitions')
    current_reports = _identified_list(current.get('researchReports', []), 'current researchReports')
    for report in current_reports.values():
        if 'facts' in report and not isinstance(report['facts'], list):
            raise ValueError('current researchReports facts必须是列表')
    result = copy.deepcopy(current)
    for metric_id, record in seed.get('series', {}).items():
        existing = current.get('series', {}).get(metric_id, {})
        if any(_numeric(point.get('value')) for point in existing.get('observations', [])):
            if backfill_history:
                seed_points={point['periodEnd']:copy.deepcopy(point) for point in record.get('observations', []) if _numeric(point.get('value'))}
                live_points={point['periodEnd']:copy.deepcopy(point) for point in existing.get('observations', [])}
                added=set(seed_points)-set(live_points)
                if added:
                    seed_points.update(live_points)
                    result['series'][metric_id]={**existing,'observations':sorted(seed_points.values(),key=lambda point:point['periodEnd']),'bootstrapFile':filename,'bootstrapSha256':checksum,'note':str(existing.get('note',''))+' 已从核验缓存补回缺少的历史期，当前来源数值优先。'}
            continue
        if not any(_numeric(point.get('value')) for point in record.get('observations', [])):
            continue
        result.setdefault('series', {})[metric_id] = _cached(record, existing, filename, checksum)
        if metric_id not in current_definitions:
            result.setdefault('definitions', []).append(copy.deepcopy(seed_definitions[metric_id]))
    restored_reports = {}
    for report_id, record in seed_reports.items():
        existing = current_reports.get(report_id, {})
        if existing.get('facts') or not record.get('facts'):
            continue
        restored_reports[report_id] = _cached(record, existing, filename, checksum)
    if restored_reports:
        result['researchReports'] = [restored_reports.pop(report['id'], report) for report in result.get('researchReports', [])]
        result['researchReports'].extend(restored_reports.values())
    return result

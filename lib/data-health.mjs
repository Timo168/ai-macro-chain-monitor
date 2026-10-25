const minute = 60_000;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function macroCacheVersion(manifest) {
  const macro = manifest?.macro?.version || manifest?.macro?.generatedAt || '';
  const audit = manifest?.sourceAudit?.version || manifest?.sourceAudit?.generatedAt || '';
  return macro ? `${macro}|${audit}` : '';
}

export function latestObservation(series) {
  return (series?.observations ?? []).filter(point => Number.isFinite(point.value)).reduce((last, point) => !last || point.date > last.date ? point : last, null);
}

// Publication state comes from the source calendar, never from the age of a
// monthly observation. A recent successful fetch is not a new observation.
export function seriesHealth(series) {
  const observation = latestObservation(series);
  const publication = series?.publication?.state;
  let state = 'ready', label = '已获取';
  if (!series || series.status === 'not_configured') { state = 'not_configured'; label = '来源未配置'; }
  else if (['cached', 'fetch_failed'].includes(series.status)) { state = observation ? 'cached' : 'fetch_failed'; label = observation ? '获取失败 · 缓存' : '获取失败'; }
  else if (publication === 'delayed') { state = 'delayed'; label = observation ? '来源延迟 · 保留数据' : '来源发布延迟'; }
  else if (publication === 'awaiting_source' || ['not_published', 'awaiting_release'].includes(series.status)) { state = 'awaiting_source'; label = '等待来源发布'; }
  else if (!observation) { state = 'not_published'; label = '尚未发布'; }
  return { state, label, observationDate: observation?.date ?? null, warning: ['cached', 'fetch_failed', 'delayed'].includes(state) };
}

export function schedulerHealth(scheduler, now = Date.now()) {
  const targetMinutes = Number(scheduler?.targetIntervalMinutes) > 0 ? Number(scheduler.targetIntervalMinutes) : 15;
  const active = ['scheduled', 'github_actions'].includes(scheduler?.mode);
  const completed = timestamp(scheduler?.lastCompletedAt);
  const started = timestamp(scheduler?.lastRunAt);
  const reference = completed ?? started;
  const ageMinutes = reference === null ? null : Math.max(0, (Number(now) - reference) / minute);
  const overdueMinutes = Math.max(60, targetMinutes * 4);
  const overdue = active && ageMinutes !== null && ageMinutes > overdueMinutes;
  const state = !active ? 'snapshot' : reference === null ? 'unknown' : overdue ? 'delayed' : completed === null ? 'unconfirmed' : scheduler.failed?.length ? 'partial_failure' : 'current';
  const label = { snapshot: '采集快照', unknown: '后台运行时间待确认', delayed: '后台检查延迟', unconfirmed: '后台已启动 · 完成时间待确认', partial_failure: '后台检查完成 · 部分来源失败', current: '后台检查正常' }[state];
  return { state, label, warning: ['delayed', 'unknown', 'unconfirmed', 'partial_failure'].includes(state), targetMinutes, overdueMinutes, ageMinutes, lastCompletedAt: completed === null ? null : scheduler.lastCompletedAt, lastRunAt: started === null ? null : scheduler.lastRunAt };
}

export function sourceForSeries(id, registry) {
  const item = registry[id];
  if (id.startsWith('EIA_') || id.startsWith('MKT_') || item?.source?.includes('世界银行')) {
    return item?.release?.startsWith('https://') ? item.release : null;
  }
  return `https://fred.stlouisfed.org/series/${encodeURIComponent(id)}`;
}

/** @param {readonly [number, number]} bounds @returns {[number, number]} */
export function barDomain(bounds) {
  const [minimum, maximum] = bounds;
  return [Math.min(0, minimum), Math.max(0, maximum)];
}

export function seriesUpdate(series) {
  const change = series?.lastChange;
  const labels = { initial_import: '首次导入', new_observation: '新增观测', revision: '来源数据修订', new_and_revised: '新增观测与来源修订', history_backfill: '历史补齐' };
  const changeAt = labels[change?.kind] ? timestamp(change.at) : null;
  const status = series?.statusChange;
  const statusAt = timestamp(status?.at);
  const recovery = ['cached', 'fetch_failed'].includes(status?.from) && status?.to === 'ready';
  const failure = ['cached', 'fetch_failed'].includes(status?.to);
  if (statusAt !== null && (recovery || failure) && (changeAt === null || statusAt > changeAt)) {
    return { at: status.at, label: recovery ? '来源恢复' : '获取失败', kind: recovery ? 'recovery' : 'failure', known: true };
  }
  return changeAt === null ? { at: null, label: '历史变更时间未记录', kind: 'unknown', known: false } : { at: change.at, label: labels[change.kind], kind: change.kind, known: true };
}

export function auditHealth(audit, now = Date.now()) {
  const completed = timestamp(audit?.completedAt);
  if (!audit || completed === null) return { label: '尚无审计记录', warning: true, stale: false };
  const stale = Number(now) - completed > 48 * 60 * minute;
  const label = audit.status === 'passed' ? (stale ? '上次审计通过 · 等待新检查' : '最近审计通过') : '最近审计失败';
  return { label, warning: stale || audit.status !== 'passed', stale };
}

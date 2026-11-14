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
export function seriesHealth(series, now = Date.now()) {
  const observation = latestObservation(series);
  const publication = series?.publication?.state;
  let state = 'ready', label = '已获取';
  if (!series || series.status === 'not_configured') { state = 'not_configured'; label = '来源未配置'; }
  else if (['cached', 'fetch_failed'].includes(series.status)) { state = observation ? 'cached' : 'fetch_failed'; label = observation ? '获取失败 · 缓存' : '获取失败'; }
  else if (publication === 'delayed') { state = 'delayed'; label = observation ? '来源延迟 · 保留数据' : '来源发布延迟'; }
  else if (publication === 'awaiting_source' || ['not_published', 'awaiting_release'].includes(series.status)) { state = 'awaiting_source'; label = '等待来源发布'; }
  else if (!observation) { state = 'not_published'; label = '尚未发布'; }
  else if (publication === 'waiting_release' && timestamp(series?.publication?.nextReleaseAt) !== null && Number(now) > timestamp(series.publication.nextReleaseAt)) { state = 'calendar_stale'; label = '发布日历待更新'; }
  return { state, label, observationDate: observation?.date ?? null, warning: ['cached', 'fetch_failed', 'delayed', 'calendar_stale'].includes(state) };
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
  // cadenceStatus records the interval between two past starts. The latest
  // completed check and its source results determine the current status.
  const previousIntervalLate = scheduler?.cadenceStatus === 'delayed';
  const state = !active ? 'snapshot' : reference === null ? 'unknown' : overdue ? 'delayed' : completed === null ? 'unconfirmed' : scheduler.failed?.length ? 'partial_failure' : 'current';
  const label = { snapshot: '采集快照', unknown: '后台运行时间待确认', delayed: '后台检查延迟', unconfirmed: '后台已启动 · 完成时间待确认', partial_failure: '后台检查完成 · 部分来源失败', current: '后台检查正常' }[state];
  return { state, label, warning: ['delayed', 'unknown', 'unconfirmed', 'partial_failure'].includes(state), previousIntervalLate, targetMinutes, overdueMinutes, ageMinutes, lastCompletedAt: completed === null ? null : scheduler.lastCompletedAt, lastRunAt: started === null ? null : scheduler.lastRunAt };
}

export function sourceForSeries(id, registry) {
  const item = registry[id];
  if (id === 'EBP' || id.startsWith('EIA_') || id.startsWith('MKT_') || item?.source?.includes('世界银行')) {
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
  const count = key => {
    const value = audit?.sampleCounts?.[key];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const failedSamples = count('failedSamples'), unavailableSamples = count('unavailableSamples');
  const automatic = count('automaticSamples'), manual = count('manualFactLedgerSamples');
  const verifiedSamples = automatic === null || manual === null ? null : automatic + manual;
  const stale = completed !== null && Number(now) - completed > 48 * 60 * minute;
  function result(state, label, warning) {
    return { state, label, warning, stale, failedSamples, unavailableSamples, verifiedSamples };
  }
  if (!audit || audit.status === 'not_run') return result('missing', '尚无审计记录', true);
  if (audit.status === 'running' && completed === null) {
    const started = timestamp(audit.startedAt);
    // The hosted audit job has a 25-minute timeout. An old start alone cannot
    // establish that the run is still active or that any sample actually failed.
    if (started !== null && Number(now) >= started && Number(now) - started <= 25 * minute) {
      return result('running', '行业抽查进行中', false);
    }
    return result('unconfirmed', '行业抽查结果待确认', true);
  }
  if (audit.status === 'failed' || failedSamples > 0) {
    const label = failedSamples > 0 ? `行业抽查 · ${failedSamples} 个样本未通过` : '行业抽查未通过';
    return result('failed', label, true);
  }
  if (audit.status === 'partial' && completed !== null) {
    const label = unavailableSamples > 0 ? `行业抽查 · ${unavailableSamples} 个样本待复核` : '部分来源待复核';
    return result('partial', label, true);
  }
  if (audit.status === 'passed' && completed !== null && !unavailableSamples) {
    if (stale) return result('stale', '上次审计通过 · 等待新检查', true);
    return result('passed', '最近审计通过', false);
  }
  return result('unconfirmed', '行业抽查结果待确认', true);
}

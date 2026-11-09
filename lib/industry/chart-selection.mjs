// The chart window, interval statistics and CSV share the displayed rows.
// Never replace missing observations with zero or recompute from raw frequency.
export function industryChartSelection(rows, zoom, {unit = '', mode = 'value'} = {}) {
 const lastIndex = Math.max(0, rows.length - 1);
 const index = (value, fallback) => Number.isInteger(value) ? Math.max(0, Math.min(lastIndex, value)) : fallback;
 const startIndex = index(zoom?.startIndex, 0);
 const endIndex = Math.max(startIndex, index(zoom?.endIndex, lastIndex));
 const zoomed = rows.length > 0 && (startIndex !== 0 || endIndex !== lastIndex);
 const visibleRows = zoomed ? rows.slice(startIndex, endIndex + 1) : rows;
 const valid = visibleRows.filter(row => typeof row.value === 'number' && Number.isFinite(row.value));
 const first = valid[0], last = valid.at(-1);
 const changeUnit = mode !== 'value' || unit === '%' ? '个百分点' : '%';
 const change = valid.length < 2 ? null : changeUnit === '个百分点' ? last.value - first.value : first.value > 0 ? (last.value / first.value - 1) * 100 : null;
 return {visibleRows, startIndex, endIndex, zoomed, first, last, change, changeUnit};
}

export function eventsInIndustrySelection(events, rows) {
 const start = rows[0]?.periodEnd, end = rows.at(-1)?.periodEnd;
 return start && end ? events.filter(event => event.date >= start && event.date <= end) : [];
}

export function industrySelectionCsv(def, rows, {mode = 'value', frequency = def.frequency} = {}) {
 const unit = mode === 'value' ? def.unit : def.unit === '%' ? '个百分点' : '%';
 const header = ['metric','period_start','period_end','fiscal_period','value','unit','display_mode','display_frequency','value_type','source','published_at','fetched_at','observation_version','formula','original_items','resolved_source','source_document_version'];
 const cells = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
 return '\ufeff' + [header, ...rows.map(row => [def.id,row.periodStart,row.periodEnd,row.fiscalPeriod,row.value,unit,mode,frequency,def.valueType,row.sourceUrl,row.publishedAt,row.fetchedAt,row.version,row.formula,JSON.stringify(row.originalItems ?? {}),row.resolvedSourceUrl,row.sourceDocumentVersion])].map(row => row.map(cells).join(',')).join('\r\n');
}

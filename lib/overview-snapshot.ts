import { groups } from './groups';
import { firstValues, makeChart, type Dataset } from './data';
import { metrics } from './calculations.mjs';
import { seriesUpdate } from './data-health.mjs';

function calculateOverview(data: Dataset) {
  const rows = groups.map(g => {
    const chart = makeChart(g, data);
    const points = firstValues(chart.rows);
    const m = metrics(points, g.category === 2 || g.changeKind === 'percent');
    const s = data.series[chart.ids[0]];
    function weeksAgo(weeks: number) {
      if (g.id !== 'nfci' || !m.last) return null;
      const date = new Date(Date.parse(m.last.date) - weeks * 7 * 86400000).toISOString().slice(0, 10);
      return points.find(point => point.date === date);
    }
    return { g, m, s, update: seriesUpdate(s), sparkline: points.slice(-24), priorWeek: weeksAgo(1), four: weeksAgo(4) };
  });
  const changes = rows.filter(row => row.m.last).sort((a, b) =>
    (Date.parse(b.update.at ?? '') || 0) - (Date.parse(a.update.at ?? '') || 0)
    || b.m.last.date.localeCompare(a.m.last.date)
  );
  return { byId: new Map(rows.map(row => [row.g.id, row])), changes };
}

// A successful refresh supplies a new snapshot object; revisiting the overview
// can reuse the series calculations while publication status follows the clock.
const snapshots = new WeakMap<Dataset, ReturnType<typeof calculateOverview>>();
export function getOverviewSnapshot(data: Dataset) {
  const cached = snapshots.get(data);
  if (cached) return cached;
  const next = calculateOverview(data);
  snapshots.set(data, next);
  return next;
}

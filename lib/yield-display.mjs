/**
 * One source of truth for the ten-year Treasury yield headline.
 *
 * DGS10 is the nominal ten-year yield.  DFII10 remains in the chart as the
 * inflation-adjusted comparison series, but should never become the headline
 * merely because it happens to be first in a configuration array.
 */
export const yieldDisplay = Object.freeze({
  primarySeriesId: 'DGS10',
  overviewLabel: '十年期名义收益率',
  chartSubtitle: '名义收益率 · 实际收益率',
});

export function orderYieldSeries(series) {
  const unique = [...new Set(series)];
  return [
    yieldDisplay.primarySeriesId,
    ...unique.filter((id) => id !== yieldDisplay.primarySeriesId),
  ];
}

// Build-time only: decode the published Census-derived topology into SVG paths.
// No map library or third-party tile request is needed by the browser.
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sourceUrl = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-albers-10m.json';
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`Geometry download failed: ${response.status}`);
const raw = await response.text();
const topology = JSON.parse(raw);
const codes = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE',
  '11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA',
  '20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN',
  '28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM',
  '36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
  '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA',
  '54':'WV','55':'WI','56':'WY',
};
const arcs = topology.arcs.map(arc => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => {
    x += dx; y += dy;
    return [x * topology.transform.scale[0] + topology.transform.translate[0],
      y * topology.transform.scale[1] + topology.transform.translate[1]];
  });
});
const all = arcs.flat();
const minX = Math.min(...all.map(p => p[0])), maxX = Math.max(...all.map(p => p[0]));
const minY = Math.min(...all.map(p => p[1])), maxY = Math.max(...all.map(p => p[1]));
const width = 975, height = 610, padding = 12;
const scale = Math.min((width - padding * 2) / (maxX - minX), (height - padding * 2) / (maxY - minY));
const offsetX = (width - (maxX - minX) * scale) / 2;
const offsetY = (height - (maxY - minY) * scale) / 2;
const round = value => Math.round(value * 10) / 10;
const point = ([x, y]) => [round((x - minX) * scale + offsetX), round((y - minY) * scale + offsetY)];
function ring(indices) {
  const points = [];
  indices.forEach(index => {
    const segment = index >= 0 ? arcs[index] : [...arcs[~index]].reverse();
    // Adjacent topology arcs share the joining vertex.
    points.push(...(points.length ? segment.slice(1) : segment));
  });
  return points.map(point);
}
function centroid(points) {
  let twiceArea = 0, sumX = 0, sumY = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross; sumX += (a[0] + b[0]) * cross; sumY += (a[1] + b[1]) * cross;
  }
  // A very small coastal islet can collapse at display precision. It contributes
  // no label weight; the largest mainland polygon must still have positive area.
  if (!twiceArea) return { area: 0, point: points[0] };
  return { area: Math.abs(twiceArea / 2), point: [round(sumX / (3 * twiceArea)), round(sumY / (3 * twiceArea))] };
}
const states = topology.objects.states.geometries.map(geometry => {
  if (!codes[geometry.id]) throw new Error(`Unexpected FIPS code: ${geometry.id}`);
  const polygons = (geometry.type === 'Polygon' ? [geometry.arcs] : geometry.arcs).map(polygon => polygon.map(ring));
  const coordinates = polygons.flat(2);
  const largest = polygons.map(polygon => centroid(polygon[0])).sort((a, b) => b.area - a.area)[0];
  if (!largest?.area) throw new Error(`Degenerate state geometry: ${geometry.id}`);
  return {
    code: codes[geometry.id], fips: geometry.id, nameEnglish: geometry.properties.name,
    path: polygons.flat().map(points => `M${points.map(p => p.join(',')).join('L')}Z`).join(''),
    centroid: largest.point,
    bounds: [[Math.min(...coordinates.map(p => p[0])), Math.min(...coordinates.map(p => p[1]))],
      [Math.max(...coordinates.map(p => p[0])), Math.max(...coordinates.map(p => p[1]))]],
  };
}).sort((a, b) => a.code.localeCompare(b.code));
if (states.length !== 51 || new Set(states.map(s => s.code)).size !== 51) throw new Error('Expected 50 states and DC');
const asset = {
  viewBox: `0 0 ${width} ${height}`, width, height,
  source: {
    name: 'U.S. Census Bureau / us-atlas',
    url: 'https://github.com/topojson/us-atlas', sourceUrl,
    censusUrl: 'https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html',
    edition: '2017', packageVersion: '3.0.1', projection: 'Albers USA; Alaska and Hawaii insets',
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    precision: 'Rounded to 0.1 SVG unit after a uniform fit; shared source topology retained.',
    license: 'ISC', licenseFile: 'docs/us-atlas-LICENSE.txt',
  },
  states,
};
const output = JSON.stringify(asset) + '\n';
if (Buffer.byteLength(output) > 150000) throw new Error('Geometry asset exceeds 150 KB');
await writeFile(new URL('../lib/industry/us-state-geometry.json', import.meta.url), output);
console.log(`Generated ${states.length} regions, ${Buffer.byteLength(output)} bytes; source SHA-256 ${asset.source.sourceSha256}`);

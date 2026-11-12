import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
let loaded;
async function component() {
  if (loaded) return loaded;
  const result = await build({
    entryPoints: [resolve('app/industry/infrastructure-map.tsx')], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'map-observer-fixture', setup(builder) {
      builder.onResolve({ filter: /observer-context$/ }, () => ({ path: 'observer', namespace: 'map-fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'map-fixture' }, () => ({ contents: 'export const useObserver=()=>globalThis.__infrastructureObserver;' }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  loaded = module.exports.default;
  return loaded;
}
const eiaUrl = 'https://www.eia.gov/electricity/data/browser/';
const projectUrl = 'https://www.energy.gov/articles/public-project-fixture';
const observed = (periodEnd, value) => ({ periodEnd, value, sourceUrl: eiaUrl, fetchedAt: '2026-11-10T00:00:00Z', version: 'test-v1', isEstimated: false, isRestated: false });
function dataset() {
  const data = { schemaVersion: '1', generatedAt: '2026-11-10T00:00:00Z', definitions: [], series: {}, events: [], sources: [], projects: [{
    id: 'texas-test-project', name: '德州公开项目样本', owner: '测试建设方', country: '美国', stateCode: 'TX', city: 'Abilene',
    status: 'construction', powerCapacityMw: 1000, capacityKind: 'data_center_planned_capacity', isEstimated: false,
    sourceUrls: [projectUrl], lastVerifiedAt: '2026-10-15', expectedOperationalAt: '2027',
    statusHistory: [{ date: '2026-01-12', status: 'announced', sourceUrl: projectUrl }, { date: '2026-10-15', status: 'construction', sourceUrl: projectUrl }],
  }] };
  const add = (id, unit, observations, status = 'ready', frequency = 'monthly') => {
    data.definitions.push({ id, unit, frequency, sourceName: 'EIA', sourceUrl: eiaUrl });
    data.series[id] = { observations, status, lastSuccessfulAt: '2026-11-09T02:00:00Z', checkedAt: '2026-11-10T00:00:00Z' };
  };
  add('EIA.TX.industrial', '美分/kWh', [observed('2026-08-31', 5.75), observed('2026-09-30', 6.25), observed('2026-10-31', 9.75)]);
  add('EIA.VA.industrial', '美分/kWh', [observed('2026-08-31', 8.25), observed('2026-09-30', 8.5)]);
  add('EIA.TX.industrial_sales', 'MWh', [observed('2026-09-30', 12345)]);
  add('EIA.VA.industrial_sales', 'MWh', [observed('2026-09-30', 23456)]);
  // National annual values must never become a state value or the comparison month.
  add('EIA.US.industrial', '美分/kWh', [observed('2025-12-31', 777.77)], 'ready', 'annual');
  add('MSFT.capex', '亿美元', [observed('2026-10-31', 99999)], 'ready', 'quarterly');
  return data;
}
const loadSeries = (id, observations, status = 'available') => ({ id, name: '实际小时负荷', kind: 'load', frequency: 'hourly', unit: 'MW', status, observations, timeZone: 'America/Chicago', sourceName: 'EIA 实际负荷', sourceUrl: 'https://www.eia.gov/electricity/gridmonitor/', lastSuccessAt: '2026-11-10T12:00:00Z' });
function energy() {
  return { generatedAt: '2026-11-10T12:00:00Z', regions: [
    { id: 'ercot', name: '德克萨斯 · ERCOT', series: [loadSeries('ERCO_LOAD', [{ date: '2026-11-10T10:00:00Z', value: 42000 }, { date: '2026-11-10T11:00:00Z', value: 43000 }])] },
    { id: 'pjm', name: '美国中东部 · PJM', series: [loadSeries('PJM_LOAD', [{ date: '2026-11-10T10:00:00Z', value: 80000 }])] },
  ] };
}
async function render(initialLayer = 'construction', data = dataset(), regionalEnergy = energy(), errors = [], initialMeasure = 'projectCount') {
  const Component = await component();
  const previous = globalThis.__infrastructureObserver;
  globalThis.__infrastructureObserver = { inputs: { regionalEnergy }, errors, loading: false, refresh() {} };
  try {
    const html = renderToStaticMarkup(React.createElement(Component, { data, initialLayer, initialMeasure }));
    return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
  } finally {
    if (previous === undefined) delete globalThis.__infrastructureObserver;
    else globalThis.__infrastructureObserver = previous;
  }
}

test('the map keeps all 51 states keyboard-selectable and exposes projects with their real source and history', async () => {
  const { html, text } = await render();
  const states = [...html.matchAll(/<path\b[^>]*class="infra-state[^>]+>/g)].map(match => match[0]);
  assert.equal(states.length, 51);
  assert.ok(states.every(path => /role="button"/.test(path) && /tabindex="0"/i.test(path) && /aria-label=/.test(path)));
  assert.match(html, /aria-label="加利福尼亚州，暂无可比数据"/);
  assert.match(html, /aria-label="得克萨斯州，1 项"/);
  for (const label of ['建设热度', '地区电价', '用电规模', '区域电网', '放大所选地区', '重置地图', '查看地区']) assert.ok(html.includes(label), label);
  assert.ok(text.includes('德州公开项目样本'));
  assert.match(text, /1,000 MW/);
  assert.match(text, /数据中心规划容量/);
  assert.ok(text.includes('2026-01-12') && text.includes('2026-10-15'));
  assert.ok(html.includes(`href="${projectUrl}"`));
  assert.ok(html.includes(`href="${eiaUrl}"`));
  assert.ok(html.includes('href="https://github.com/topojson/us-atlas"'));
  assert.match(html, /aria-label="收起数据中心与电力地图"/);
});

test('electricity heat uses the latest shared month without substituting a newer or nationwide value', async () => {
  const { html, text } = await render('price');
  assert.match(html, /<option value="2026-09" selected="">2026-09<\/option>/);
  assert.match(html, /aria-label="得克萨斯州，6\.25 美分\/kWh"/);
  assert.match(html, /aria-label="弗吉尼亚州，8\.50 美分\/kWh"/);
  assert.match(html, /aria-label="加利福尼亚州，暂无可比数据"/);
  assert.ok(text.includes('2026-09 · 同月比较'));
  assert.ok(!text.includes('777.77') && !text.includes('99,999'));
  assert.doesNotMatch(html, /aria-label="得克萨斯州，9\.75/);
});

test('sales heat uses MWh and retains a separately labeled retail price in regional details', async () => {
  const { html, text } = await render('sales');
  assert.match(html, /aria-label="得克萨斯州，12,345 MWh"/);
  assert.match(html, /aria-label="弗吉尼亚州，23,456 MWh"/);
  assert.match(text, /平均零售电价\s+6\.25\s+美分\/kWh/);
  assert.match(text, /当月售电量\s+12,345\s+MWh/);
  assert.doesNotMatch(html, /aria-label="得克萨斯州，6\.25 MWh"/);
});

test('source failures retain dated cached electricity and project records with visible status', async () => {
  const data = dataset();
  data.sources = [{ url: projectUrl, status: 'fetch_failed', checkedAt: '2026-11-10T00:00:00Z', error: '官方页面暂时无法访问' }];
  data.series['EIA.TX.industrial'].status = 'cached';
  data.series['EIA.TX.industrial'].error = '电力来源本次检查失败';
  const { html, text } = await render('price', data);
  assert.match(text, /展示缓存/);
  assert.match(text, /本轮未核验|获取失败/);
  assert.match(text, /电力来源本次检查失败/);
  assert.ok(text.includes('2026-10-15'));
  assert.match(html, /aria-label="得克萨斯州，6\.25 美分\/kWh"/);
  assert.ok(html.includes(`href="${projectUrl}"`));
});

test('grid markers compare one shared hour and distinguish that value from the latest observation', async () => {
  const { html, text } = await render('markets');
  assert.match(html, /aria-label="德克萨斯 · ERCOT，42,000 MW"/);
  assert.match(html, /aria-label="美国中东部 · PJM，80,000 MW"/);
  assert.match(text, /当前比较时点\s+42,000\s+MW/);
  assert.match(text, /最近有效观测\s+43,000\s+MW/);
  assert.ok(html.includes('https://www.eia.gov/electricity/gridmonitor/'));
  assert.ok(text.includes('2 / 2 个区域有该时点观测'));
  assert.match(html, /<option value="2026-11-10T10:00:00Z" selected="">/);
});

test('an unavailable regional series keeps its failure and empty value rather than inventing zero', async () => {
  const regional = energy();
  regional.regions[0].series[0] = loadSeries('ERCO_LOAD', [{ date: '2026-11-10T10:00:00Z', value: null }], 'fetch_failed');
  regional.regions[0].series[0].error = '负荷源暂时无法访问';
  const { html, text } = await render('markets', dataset(), regional);
  assert.match(html, /aria-label="德克萨斯 · ERCOT，— MW"/);
  assert.match(text, /当前比较时点\s+—\s+MW/);
  assert.match(text, /获取失败/);
  assert.match(text, /负荷源暂时无法访问/);
  assert.ok(text.includes('1 / 2 个区域有该时点观测'));
  assert.doesNotMatch(text, /当前比较时点\s+0(?:\.00)?\s+MW/);
});

test('a failed page refresh presents retained market data as cached, with its successful retrieval date', async () => {
  const { text } = await render('markets', dataset(), energy(), ['区域电力读取失败']);
  assert.match(text, /使用缓存/);
  assert.match(text, /页面读取失败，保留上次已加载数据/);
  assert.match(text, /42,000/);
  assert.match(text, /最近成功获取\s+2026\/11\/10/);
});

test('unpublished and unconfigured market sources remain distinct from fetch failures', async () => {
  for (const [status, label] of [['not_published', '尚未发布'], ['not_configured', '来源未配置']]) {
    const regional = energy();
    regional.regions[0].series[0] = loadSeries('ERCO_LOAD', [], status);
    const { html, text } = await render('markets', dataset(), regional);
    assert.ok(text.includes(label), `${status} must keep its source boundary`);
    assert.match(html, /aria-label="德克萨斯 · ERCOT，— MW"/);
    assert.match(text, /当前比较时点\s+—\s+MW/);
    assert.doesNotMatch(text, /获取失败/);
  }
});

function capacityDataset() {
 const data=dataset();
 data.projects[0]={...data.projects[0],name:'Temple',status:'operational',powerCapacityMw:null,capacityKind:undefined,capacityEvidence:[
  {id:'epoch-temple-it',sourceType:'institutional_estimate',valueMw:178,capacityKind:'it_power',scope:'current',asOfDate:'2026-09-30',publishedAt:'2026-09-30',sourceName:'Epoch AI',sourceUrl:'https://epoch.ai/data/ai-data-centers/directory/meta-temple',status:'cached',lastSuccessfulAt:'2026-11-10T12:00:00Z',checkedAt:'2026-11-11T12:00:00Z',coverageScope:'AI 建筑 1—3',method:'卫星影像与制冷设备模型'},
  {id:'epoch-temple-facility',sourceType:'institutional_estimate',valueMw:231,capacityKind:'facility_power',scope:'current',asOfDate:'2026-09-30',sourceName:'Epoch AI',sourceUrl:'https://epoch.ai/data/ai-data-centers/directory/meta-temple',status:'ready'},
  {id:'epoch-temple-plan',sourceType:'institutional_estimate',valueMw:500,capacityKind:'it_power',scope:'planned',asOfDate:'2026-09-30',targetDate:'2028-Q1',sourceName:'Epoch AI',sourceUrl:'https://epoch.ai/data/ai-data-centers/directory/meta-temple',status:'ready'}
 ]};
 return data;
}
test('project cards and IT heat expose matching estimates, official absence, dates, coverage and cached state',async()=>{
 const {html,text}=await render('construction',capacityDataset(),energy(),[],'estimatedOperationalMw');
 assert.match(html,/aria-label="得克萨斯州，178 MW"/);
 assert.match(text,/官方披露 容量尚未披露/);
 assert.match(text,/约 178 MW/);assert.match(text,/Epoch AI/);assert.match(text,/展示缓存/);
 assert.match(text,/数据截至 2026-09-30/);assert.match(text,/AI 建筑 1—3/);
 assert.ok(text.includes('已覆盖 1 / 1 个适用项目'));
 assert.match(text,/目标 2028-Q1/);
 assert.doesNotMatch(html,/aria-label="得克萨斯州，(?:231|500|909) MW"/);
});
test('facility heat remains separately selectable while a range is displayed without becoming a point',async()=>{
 const data=capacityDataset();
 data.projects.push({...data.projects[0],id:'range',name:'范围样本',capacityEvidence:[{id:'range-facility',sourceType:'institutional_estimate',valueMw:null,upperBoundMw:200,valueQualifier:'less_than',capacityKind:'facility_power',scope:'current',asOfDate:'2026-11-10',sourceName:'Cleanview',sourceUrl:'https://cleanview.co/data-centers/missouri',status:'ready'}]});
 const {html,text}=await render('construction',data,energy(),[],'estimatedFacilityMw');
 assert.match(html,/aria-label="得克萨斯州，231 MW"/);
 assert.match(text,/低于 200 MW/);assert.match(text,/Cleanview/);
 assert.ok(text.includes('已覆盖 1 / 2 个适用项目'));
 assert.doesNotMatch(html,/aria-label="得克萨斯州，431 MW"/);
});

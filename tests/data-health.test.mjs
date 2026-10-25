import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { latestObservation, seriesHealth, schedulerHealth, sourceForSeries, barDomain, seriesUpdate, auditHealth, macroCacheVersion } from '../lib/data-health.mjs';

const observation = { date: '2026-08-01', value: 3 };
const ready = { status: 'ready', observations: [observation], publication: { state: 'waiting_release' } };

test('audit-only updates invalidate the macro view while an unavailable manifest cannot create a cache version', () => {
  assert.notEqual(macroCacheVersion({ macro: { version: 'same-data' }, sourceAudit: { version: 'audit-1' } }), macroCacheVersion({ macro: { version: 'same-data' }, sourceAudit: { version: 'audit-2' } }));
  assert.equal(macroCacheVersion({ sourceAudit: { version: 'audit-1' } }), '');
  assert.equal(macroCacheVersion(null), '');
});

test('monthly observations remain current while waiting for the next scheduled release', () => {
  assert.equal(seriesHealth(ready).state, 'ready');
  assert.equal(seriesHealth({ ...ready, publication: { state: 'delayed' } }).state, 'delayed');
  assert.equal(seriesHealth({ ...ready, publication: { state: 'awaiting_source' } }).state, 'awaiting_source');
});

test('missing, unavailable and cached sources preserve separate states and valid observation dates', () => {
  assert.equal(seriesHealth(undefined).state, 'not_configured');
  assert.equal(seriesHealth({ status: 'ready', observations: [] }).state, 'not_published');
  assert.equal(seriesHealth({ status: 'fetch_failed', observations: [] }).state, 'fetch_failed');
  assert.equal(seriesHealth({ ...ready, status: 'fetch_failed' }).state, 'cached');
  assert.deepEqual(latestObservation({ observations: [{ date: '2026-10-24', value: null }, observation, { date: '2025-01-01', value: 5 }] }), observation);
});

test('scheduler detects multi-hour delays without treating every missed 15-minute target as failure', () => {
  const now = Date.parse('2026-10-25T06:00:00Z');
  assert.equal(schedulerHealth({ mode: 'github_actions', lastCompletedAt: '2026-10-25T05:30:00Z' }, now).state, 'current');
  assert.equal(schedulerHealth({ mode: 'github_actions', lastCompletedAt: '2026-10-25T01:00:00Z', lastRunAt: '2026-10-25T05:59:00Z' }, now).state, 'delayed');
  assert.equal(schedulerHealth({ mode: 'github_actions', lastRunAt: '2026-10-25T05:59:00Z' }, now).state, 'unconfirmed');
  assert.equal(schedulerHealth({ mode: 'github_actions', lastRunAt: 'invalid' }, now).state, 'unknown');
  assert.equal(schedulerHealth({ mode: 'github_actions', lastCompletedAt: '2026-10-25T05:30:00Z', failed: ['DGS10'] }, now).state, 'partial_failure');
});

test('electricity source follows its authoritative EIA registry release instead of a nonexistent FRED series', () => {
  const registry = Object.fromEntries(JSON.parse(fs.readFileSync(new URL('../lib/indicators.json', import.meta.url))).map(item => [item.id, item]));
  for (const id of Object.keys(registry).filter(id => id.startsWith('EIA_'))) {
    assert.equal(sourceForSeries(id, registry), registry[id].release);
    assert.match(sourceForSeries(id, registry), /^https:\/\/www\.eia\.gov\//);
  }
  assert.equal(sourceForSeries('DGS10', registry), 'https://fred.stlouisfed.org/series/DGS10');
});

test('bar charts retain a truthful zero baseline for positive, negative and mixed series', () => {
  assert.deepEqual(barDomain([2.8, 5.4]), [0, 5.4]);
  assert.deepEqual(barDomain([-5.4, -2.8]), [-5.4, 0]);
  assert.deepEqual(barDomain([-1, 2]), [-1, 2]);
});

test('successful fetching alone never invents an observation change or revision', () => {
  assert.equal(seriesUpdate({ ...ready, fetchedAt: '2026-10-25T06:00:00Z', revision: 'new-hash' }).known, false);
  const lastChange = { at: '2026-10-24T01:00:00Z', kind: 'new_observation' };
  assert.equal(seriesUpdate({ ...ready, lastChange, fetchedAt: '2026-10-25T06:00:00Z' }).at, lastChange.at);
  assert.equal(seriesUpdate({ ...ready, lastChange, statusChange: { at: '2026-10-25T05:00:00Z', from: 'ready', to: 'cached' } }).kind, 'failure');
  assert.equal(seriesUpdate({ ...ready, lastChange, statusChange: { at: '2026-10-25T06:00:00Z', from: 'cached', to: 'ready' } }).kind, 'recovery');
});

test('audit has explicit missing, failed and outdated passed states', () => {
  const now = Date.parse('2026-10-25T06:00:00Z');
  assert.equal(auditHealth(null, now).label, '尚无审计记录');
  assert.equal(auditHealth({ status: 'failed', completedAt: '2026-10-25T05:00:00Z' }, now).warning, true);
  assert.equal(auditHealth({ status: 'passed', completedAt: '2026-10-25T05:00:00Z' }, now).warning, false);
  assert.equal(auditHealth({ status: 'passed', completedAt: '2026-10-22T05:00:00Z' }, now).stale, true);
});

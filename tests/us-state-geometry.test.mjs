import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const geometry = JSON.parse(readFileSync(new URL('../lib/industry/us-state-geometry.json', import.meta.url), 'utf8'));

test('state map covers all 50 states and DC with pinned Census provenance', () => {
  assert.equal(geometry.states.length, 51);
  assert.equal(new Set(geometry.states.map(state => state.code)).size, 51);
  assert.equal(new Set(geometry.states.map(state => state.fips)).size, 51);
  for (const code of ['AK', 'HI', 'DC', 'TX', 'VA', 'CA', 'NY']) assert.ok(geometry.states.some(state => state.code === code));
  assert.equal(geometry.source.edition, '2017');
  assert.equal(geometry.source.packageVersion, '3.0.1');
  assert.equal(geometry.source.sourceSha256, '6e7bb086a3c791490361968a3094f377f7726c5d0c4900fec03cc42db2305a3d');
  assert.match(geometry.source.censusUrl, /^https:\/\/www\.census\.gov\//);
});

test('all state paths and label anchors fit the declared SVG viewport', () => {
  assert.equal(geometry.viewBox, '0 0 975 610');
  for (const state of geometry.states) {
    assert.match(state.path, /^M[\d.,LMZ]+Z$/);
    assert.ok(!/NaN|Infinity/.test(state.path), state.code);
    const [[x0, y0], [x1, y1]] = state.bounds;
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= geometry.width && y1 <= geometry.height, state.code);
    assert.ok(x1 > x0 && y1 > y0, state.code);
    assert.ok(state.centroid[0] >= x0 && state.centroid[0] <= x1, state.code);
    assert.ok(state.centroid[1] >= y0 && state.centroid[1] <= y1, state.code);
  }
});

test('Alaska and Hawaii remain in lower insets and state shapes remain geographical', () => {
  const state = code => geometry.states.find(row => row.code === code);
  assert.ok(state('AK').centroid[1] > state('CA').centroid[1]);
  assert.ok(state('HI').centroid[1] > state('TX').centroid[1]);
  assert.ok(state('CA').centroid[0] < state('TX').centroid[0]);
  assert.ok(state('TX').centroid[0] < state('VA').centroid[0]);
  assert.ok(state('WA').centroid[1] < state('CA').centroid[1]);
  assert.ok(state('ME').centroid[1] < state('FL').centroid[1]);
  assert.match(readFileSync(new URL('../docs/us-atlas-LICENSE.txt', import.meta.url), 'utf8'), /Copyright 2013-2019 Michael Bostock/);
});

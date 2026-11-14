import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

const bundle = await build({
 entryPoints: ['app/segmented-navigation.tsx'], bundle: true, write: false,
 format: 'cjs', platform: 'node', packages: 'external', loader: {'.css': 'empty'},
});
const mod = {exports: {}};
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
const {SegmentedNavigation, positionSegmentIndicator} = mod.exports;

test('selection uses local coordinates in a scrolled strip, retargets immediately and snaps on resize', () => {
 const button = {offsetLeft: 120, offsetTop: 10, offsetWidth: 50, offsetHeight: 38};
 const group = {dataset: {}, scrollLeft: 70, querySelector: () => button};
 const marker = {dataset: {}, style: {}};
 positionSegmentIndicator(group, marker, 'underline', true);
 assert.deepEqual(marker.style, {transform: 'translate(120px, 46px)', width: '50px', height: '2px'});
 assert.equal(marker.dataset.moving, 'false');

 button.offsetLeft = 210;
 positionSegmentIndicator(group, marker, 'underline', true);
 button.offsetLeft = 17;
 positionSegmentIndicator(group, marker, 'underline', true);
 assert.equal(marker.dataset.moving, 'true');
 assert.equal(marker.style.transform, 'translate(17px, 46px)');

 Object.assign(button, {offsetLeft: 5, offsetTop: 108, offsetWidth: 143, offsetHeight: 42});
 positionSegmentIndicator(group, marker, 'pill', false);
 assert.deepEqual(marker.style, {transform: 'translate(5px, 108px)', width: '143px', height: '42px'});
 assert.equal(marker.dataset.moving, 'false');
 button.offsetWidth = 0;
 positionSegmentIndicator(group, marker, 'pill', false);
 assert.ok(!('indicatorReady' in group.dataset));
 button.offsetWidth = 143;
 positionSegmentIndicator(group, marker, 'pill', true);
 assert.ok('indicatorReady' in group.dataset);
 assert.equal(marker.dataset.moving, 'false');
});

test('navigation and chart controls retain their landmark, native button and selection before measurement', () => {
 for (const [as, attribute] of [['nav', 'aria-current'], ['div', 'aria-pressed']]) {
  const button = React.createElement('button', {[attribute]: as === 'nav' ? 'page' : true}, '当前');
  const html = renderToStaticMarkup(React.createElement(SegmentedNavigation, {as, value: 'a', label: '视图'}, button));
  assert.match(html, as === 'nav' ? /^<nav aria-label="视图"/ : /^<div role="group" aria-label="视图"/);
  assert.match(html, new RegExp('<button ' + attribute + '='));
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /data-indicator-ready/);
 }
});

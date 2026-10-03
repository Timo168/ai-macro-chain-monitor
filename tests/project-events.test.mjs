import test from 'node:test';
import assert from 'node:assert/strict';
import {uniqueProjectEvents} from '../lib/industry/project-events.mjs';
const row={projectId:'DOE',date:'2026-07-20',status:'planning',sourceUrl:'https://energy.gov/public',capacityMw:1000};
test('legacy and enriched copies count once and preserve the explicit capacity basis',()=>{
 const events=uniqueProjectEvents([row,{...row,capacityKind:'data_center_planned_capacity'}]);
 assert.equal(events.length,1);assert.equal(events[0].capacityKind,'data_center_planned_capacity');
 assert.deepEqual(uniqueProjectEvents(events),events);
});
test('different capacity bases, values, dates and sources are not silently collapsed',()=>{
 const events=uniqueProjectEvents([row,{...row,capacityKind:'grid_connection'},{...row,capacityKind:'generation'},{...row,capacityMw:2000},{...row,date:'2026-07-21'},{...row,sourceUrl:'https://energy.gov/other'}]);
 assert.equal(events.length,6);assert.equal(new Set(events.map(event=>event.eventKey)).size,6);
});

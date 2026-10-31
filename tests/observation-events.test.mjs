import test from 'node:test';
import assert from 'node:assert/strict';
import {eventDay,buildObservationEvents,eventsForChart,alignEventsToRows} from '../lib/observation-events.mjs';

test('uses publication dates, never observation or fetch dates',()=>{
 const inputs={macro:{series:{A:{sourcePublishedAt:null,fetchedAt:'2026-04-03',observations:[{date:'2026-03-01',value:3}],sourceUrl:'https://official.example/a'},B:{sourcePublishedAt:'2026-04-03T21:00:00Z',sourceUrl:'https://official.example/b',status:'cached',revision:'v1'}}}};
 const events=buildObservationEvents(inputs,'2026-05-01');
 assert.equal(events.length,1);assert.equal(events[0].date,'2026-04-04');assert.equal(events[0].status,'cached');assert.equal(events[0].version,'v1');
 assert.equal(eventDay('2026-04-03'),'2026-04-03');assert.equal(eventDay('invalid'),null);
});
test('deduplicates company publication shared by several metrics and retains all ids',()=>{
 const observation={periodEnd:'2026-03-31',publishedAt:'2026-04-20',sourceUrl:'https://company.example/q1',version:'v2'};
 const inputs={industry:{definitions:[{id:'X.revenue',entity:'X'},{id:'X.capex',entity:'X'}],series:{'X.revenue':{observations:[observation]},'X.capex':{observations:[observation]}}}};
 const events=buildObservationEvents(inputs,'2026-05-01');assert.equal(events.length,1);assert.deepEqual(events[0].seriesIds,['X.revenue','X.capex']);
 assert.equal(eventsForChart(events,{entity:'Y'}).length,0);assert.equal(eventsForChart(events,{seriesIds:['X.capex']}).length,1);
});
test('categorical markers use next observation, outside dates remain list only',()=>{
 const events=[{id:'a',date:'2026-01-15',scheduled:false},{id:'b',date:'2026-03-15',scheduled:false},{id:'c',date:'2025-12-01',scheduled:false}];
 const positioned=alignEventsToRows(events,[{date:'2026-01-01'},{date:'2026-02-01'}]);
 assert.equal(positioned[0].positionDate,'2026-02-01');assert.equal(positioned[0].aligned,true);assert.equal(positioned[1].positionDate,null);assert.equal(positioned[2].positionDate,null);
});
test('future official releases are schedules, not realised events, and unsafe sources excluded',()=>{
 const events=buildObservationEvents({industry:{events:[{id:'future',entity:'X',kind:'release',date:'2026-05-15',sourceUrl:'https://company.example/q1',isConfirmed:true},{id:'bad',kind:'release',date:'2026-01-01',sourceUrl:'javascript:alert(1)',isConfirmed:true}]}},'2026-05-01');
 assert.equal(events.length,1);assert.equal(events[0].scheduled,true);assert.equal(alignEventsToRows(events,[{date:'2026-05-15'}])[0].positionDate,null);
});
test('policy decisions only appear in charts that opt in',()=>{
 const events=buildObservationEvents({policyDecisions:{status:'ready',decisions:[{bankId:'fed',bank:'美联储',announcementDate:'2026-04-01',lower:3,upper:3.25,statementUrl:'https://federalreserve.gov/test'}]}},'2026-05-01');
 assert.equal(eventsForChart(events).length,0);assert.equal(eventsForChart(events,{includePolicy:true}).length,1);
});

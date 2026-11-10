import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResearchCalendar,calendarDayOffset,filterResearchCalendar,researchCalendarIcs} from '../lib/research-calendar.mjs';

const now='2026-11-10T10:00:00Z';
const policy={id:'fed-dec',bankId:'fed',bank:'美联储',country:'美国',decisionDate:'2026-12-09',title:'FOMC 两日会议',timezone:'美国东部时间',sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',scheduleType:'official'};
const macroCalendar={checkedAt:now,fred:[{releaseId:10,status:'ok',fetchedAt:now,sourceUrl:'https://fred.stlouisfed.org/releases/calendar?rid=10',events:[{scheduledAt:'2026-11-10T13:30:00Z'},{scheduledAt:'2026-12-10T13:30:00Z'}]}]};
const financial={entity:'TSM',sourceStatus:'ready',checkedAt:now,lastSuccessfulAt:now,sourceUrl:'https://investor.tsmc.com/english/quarterly-results',release:{entity:'TSM',fiscalYear:2026,quarter:3,publishedAt:'2026-10-15',url:'https://investor.tsmc.com/english/quarterly-results/2026/q3'},upcoming:{entity:'TSM',fiscalYear:2026,quarter:4,publishedAt:'2026-11-01',releaseAt:'2026-12-11T14:00:00+08:00',url:'https://investor.tsmc.com/english/quarterly-results/2026/q4'}};
const review={id:'my-review',title:'检查需求是否变强',reviewStatus:'pending',reviewOn:'2026-11-12',updatedAt:now,snapshot:{title:'云厂商资本开支'}};
const options={now,policyEvents:[policy],policyCheckedAt:now,macroCalendar,industry:{financialUpdates:[financial]},notes:[review]};

test('merges four sources, retains official links, and sorts by calendar time',()=>{
 const result=buildResearchCalendar(options);
 assert.deepEqual([...new Set(result.events.map(row=>row.category))].sort(),['earnings','macro','policy','review']);
 assert.equal(result.events.length,6);
 assert.deepEqual(result.events.map(row=>row.day),['2026-10-15','2026-11-10','2026-11-12','2026-12-09','2026-12-10','2026-12-11']);
 assert.equal(result.events.find(row=>row.category==='policy').sourceUrl,policy.sourceUrl);
 assert.equal(result.byCategory.find(row=>row.category==='earnings').count,1);
});

test('explicit timezone offsets and DST flow into Beijing time without browser-local guessing',()=>{
 const result=buildResearchCalendar({now,macroCalendar:{fred:[{releaseId:18,status:'ok',fetchedAt:now,events:[{scheduledAt:'2026-10-30T16:15:00-04:00',calendarUrl:'https://www.federalreserve.gov/releases/h15/'},{scheduledAt:'2026-11-02T16:15:00-05:00',calendarUrl:'https://www.federalreserve.gov/releases/h15/'}]}]}});
 assert.deepEqual(result.events.map(row=>[row.day,row.at]),[['2026-10-31','2026-10-30T20:15:00.000Z'],['2026-11-03','2026-11-02T21:15:00.000Z']]);
});

test('date-only policy stays on source-local date, not fabricated midnight in Beijing',()=>{
 const event=buildResearchCalendar({now,policyEvents:[policy],policyCheckedAt:now}).events[0];
 assert.equal(event.at,null);assert.equal(event.day,'2026-12-09');assert.equal(event.timeBasis,'date_only');assert.equal(event.timezone,'美国东部时间');
});

test('polling times, fiscal quarter ends, and announcement publication dates are not future events',()=>{
 const result=buildResearchCalendar({now,macro:{series:{ICSA:{fetchedAt:now,publication:{nextCheckAt:'2026-11-11T01:00:00Z'}}}},industry:{financialUpdates:[{...financial,release:null,upcoming:{...financial.upcoming,releaseAt:undefined,eventAt:undefined,periodEnd:'2026-12-31'}}]}});
 assert.equal(result.events.length,0);
 assert.match(result.coverage[0].note,/尚未收录/);
});

test('per-series official schedules collapse related CPI series into a single event',()=>{
 const series={checkedAt:now,publication:{nextReleaseAt:'2026-11-10T13:30:00Z',calendarSource:'https://fred.stlouisfed.org/releases/calendar?rid=10',calendarStatus:'ok'}};
 const result=buildResearchCalendar({now,macro:{series:{CPIAUCNS:series,CPILFENS:series,CPIAUCSL:series,CPILFESL:series}},catalog:[{id:'macro:CPIAUCNS:yoy',href:'/?page=economy#cpi'}]});
 assert.equal(result.events.length,1);assert.equal(result.events[0].relatedHref,'/?page=economy#cpi');
});

test('a loaded full calendar takes precedence over obsolete next-release snapshots',()=>{
 const result=buildResearchCalendar({...options,macro:{series:{CPIAUCNS:{publication:{nextReleaseAt:'2026-11-13T13:30:00Z',calendarSource:'https://fred.stlouisfed.org/releases/calendar?rid=10'}}}}});
 assert.equal(result.events.filter(row=>row.category==='macro').length,2);assert.equal(result.events.some(row=>row.day==='2026-11-13'),false);
});

test('dollar H.10 calendar uses only explicit release 17 times and links the dollar chart',()=>{
 const result=buildResearchCalendar({now,catalog:[{id:'macro:DTWEXBGS',href:'/?page=financing#dollar'}],macroCalendar:{fred:[{releaseId:17,status:'ok',fetchedAt:now,sourceUrl:'https://fred.stlouisfed.org/releases/calendar?rid=17',events:[{scheduledAt:'2026-11-16T21:15:00Z'},{scheduledAt:'2026-11-23'}]}]}});
 assert.equal(result.events.length,2);assert.equal(result.events[0].day,'2026-11-17');assert.equal(result.events[0].at,'2026-11-16T21:15:00.000Z');assert.equal(result.events[0].relatedHref,'/?page=financing#dollar');
 assert.equal(result.events[1].at,null);assert.match(result.events[0].title,/H.10/);
 const absent=buildResearchCalendar({now,macro:{series:{DTWEXBGS:{checkedAt:now,publication:{state:'waiting_release',nextCheckAt:'2026-11-16T21:15:00Z'}}}}});
 assert.equal(absent.events.length,0);
});

test('unavailable or unknown calendar status never becomes a fresh official fallback',()=>{
 for(const calendarStatus of ['unavailable','calendar_unavailable','unknown',undefined]){
  const result=buildResearchCalendar({now,macro:{series:{DTWEXBGS:{checkedAt:now,publication:{nextReleaseAt:'2026-11-16T21:15:00Z',calendarSource:'https://fred.stlouisfed.org/releases/calendar?rid=17',calendarStatus}}}}});
  assert.equal(result.events.length,0);
 }
 const full=buildResearchCalendar({now,macroCalendar:{fred:[{...macroCalendar.fred[0],status:'unavailable'}]}});
 assert.equal(full.events[0].sourceStatus,'unknown');
});

test('excludes estimated cadence, invalid dates, offset-less clocks and unsafe sources',()=>{
 const result=buildResearchCalendar({now,policyEvents:[{...policy,scheduleType:'cadence'},{...policy,id:'bad',decisionDate:'2026-02-30'},{...policy,id:'unsafe',sourceUrl:'javascript:alert(1)'}],macroCalendar:{fred:[{releaseId:10,status:'ok',sourceUrl:'https://fred.stlouisfed.org',events:[{scheduledAt:'2026-11-10T13:30:00'},{scheduledAt:'2026-02-30T13:30:00Z'}]}]}});
 assert.deepEqual(result.events,[]);
});

test('cached and failed sources remain identifiable; old official checks become stale',()=>{
 const result=buildResearchCalendar({...options,policyCheckedAt:'2026-09-01',macroCalendar:{fred:[{...macroCalendar.fred[0],status:'cached'}]},industry:{financialUpdates:[{...financial,sourceStatus:'fetch_failed'}]}});
 assert.equal(result.events.find(row=>row.category==='policy').sourceStatus,'stale');
 assert.equal(result.events.find(row=>row.category==='macro').sourceStatus,'cached');
 assert.equal(result.events.find(row=>row.category==='earnings').sourceStatus,'fetch_failed');
});

test('known completed earnings replace the same upcoming event and are not duplicated',()=>{
 const result=buildResearchCalendar({now,industry:{financialUpdates:[{...financial,upcoming:{...financial.release,releaseAt:financial.release.publishedAt}}]}});
 assert.equal(result.events.length,1);assert.equal(result.events[0].detail,'已发布财报');
});

test('pending personal reviews join the calendar; completed and date-less notes do not',()=>{
 const result=buildResearchCalendar({now,notes:[review,{...review,id:'done',reviewStatus:'completed'},{...review,id:'no-day',reviewOn:null}]});
 assert.equal(result.events.length,1);assert.equal(result.events[0].sourceStatus,'personal');assert.equal(result.events[0].sourceUrl,null);
});

test('upcoming filters include overdue reviews optionally, with category and text search',()=>{
 const result=buildResearchCalendar({...options,notes:[review,{...review,id:'overdue',reviewOn:'2026-11-05',title:'旧笔记'}]});
 const defaultRows=filterResearchCalendar(result.events,{today:'2026-11-10',range:'7'});
 assert.deepEqual(defaultRows.map(row=>row.day),['2026-11-05','2026-11-10','2026-11-12']);
 assert.equal(filterResearchCalendar(result.events,{today:'2026-11-10',range:'7',includeOverdue:false}).length,2);
 assert.equal(filterResearchCalendar(result.events,{today:'2026-11-10',range:'90',categories:['earnings'],query:'tsm'}).length,1);
 assert.equal(filterResearchCalendar(result.events,{today:'2026-11-10',range:'past7',categories:['policy']}).length,0);
 assert.deepEqual(filterResearchCalendar(result.events,{today:'2026-11-10',range:'unknown'}),[]);
});

test('calendar offsets handle month/year transitions',()=>{
 assert.equal(calendarDayOffset('2026-12-31',1),'2027-01-01');assert.equal(calendarDayOffset('2026-03-01',-1),'2026-02-28');assert.equal(calendarDayOffset('invalid',1),null);
});

test('routine treasury and energy price releases are opt-in while weekly dollar remains visible',()=>{
 const model=buildResearchCalendar({now,macroCalendar:{fred:[18,212,17].map(releaseId=>({releaseId,status:'ok',fetchedAt:now,sourceUrl:'https://fred.stlouisfed.org/releases/calendar',events:[{scheduledAt:'2026-11-11T13:00:00Z'}]}))}});
 assert.equal(model.events.length,3);
 const compact=filterResearchCalendar(model.events,{today:'2026-11-10'});
 assert.equal(compact.length,1);assert.match(compact[0].title,/H.10/);
 assert.equal(filterResearchCalendar(model.events,{today:'2026-11-10',includeRoutine:true}).length,3);
});

test('ICS retains timed and all-day semantics and stable UIDs with only chosen events',()=>{
 const model=buildResearchCalendar(options);const selection=model.events.filter(row=>row.category==='policy'||row.category==='macro').slice(0,2);
 const text=researchCalendarIcs(selection,{now,reminder:'hour'}).replace(/\r\n /g,'');
 assert.equal((text.match(/BEGIN:VEVENT/g)??[]).length,2);
 assert.match(text,/DTSTART:20261110T133000Z/);assert.match(text,/DTSTART;VALUE=DATE:20261209/);assert.match(text,/DTEND;VALUE=DATE:20261210/);
 assert.match(text,/TRIGGER:-PT1H/);assert.match(text,/TRIGGER:-P1D/);assert.doesNotMatch(text,/TSM/);
 const next=researchCalendarIcs(selection,{now:'2026-11-11T00:00:00Z'}).replace(/\r\n /g,'');
 assert.deepEqual(text.match(/UID:.+/g),next.match(/UID:.+/g));
});

test('ICS escapes content and folds Unicode by byte length without corrupting text',()=>{
 const event={...buildResearchCalendar(options).events[0],title:'研究,复盘;笔记\nBEGIN:VEVENT '+ '中文研究'.repeat(45)};
 const text=researchCalendarIcs([event],{now,reminder:'none'});
 assert.ok(text.split('\r\n').every(line=>new TextEncoder().encode(line).length<=75));
 const unfolded=text.replace(/\r\n /g,'');assert.match(unfolded,/SUMMARY:研究\\,复盘\\;笔记\\nBEGIN:VEVENT/);assert.equal((text.match(/\r\nBEGIN:VEVENT/g)??[]).length,1);assert.doesNotMatch(text,/VALARM/);
 assert.ok(unfolded.includes('中文研究'.repeat(45)));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {beijingDay,buildWeeklyReport,clearNoteDraft,collectDisclosures,completeNoteReview,createNote,editNote,escapeHtml,inWeek,matchesNoteFilter,noteDraftKey,readNoteDraft,reopenNoteReview,writeNoteDraft,MAX_BACKUP_BYTES,mergeNotes,NOTEBOOK_SCHEMA,parseNotebook,safeSourceUrl,serializeNotebook,weeklyHtml,weeklyMarkdown,weekRange} from '../lib/research-notebook.mjs';

const item={id:'macro:dgs10',title:'十年期名义收益率',kind:'macro',value:'4.25',unit:'%',period:'2026-10-30',status:'已获取',sourceUrl:'https://fred.stlouisfed.org/series/DGS10',sourceVersion:'v1',checkedAt:'2026-10-31T00:00:00Z'};
const fields={title:'利率变化观察',judgment:'资金成本变化',evidence:'观察企业现金流',reviewOn:'2026-11-07'};
const note=createNote(item,fields,{id:'note-1',now:'2026-10-31T01:00:00Z'});
const inputs={macro:{generatedAt:'2026-10-31T00:00:00Z',series:{}},industry:null,research:null,policyRates:null,policyDecisions:null};

test('saving and editing preserve the original source snapshot',()=>{
 const source={...item};const saved=createNote(source,fields,{id:'stable',now:'2026-10-31T01:00:00Z'});source.value='9.99';source.sourceVersion='v2';
 const edited=editNote(saved,{...fields,judgment:'新增判断',snapshot:{value:'99'},createdAt:'2027-01-01T00:00:00Z'},'2026-11-02T01:00:00Z');
 assert.equal(saved.snapshot.value,'4.25');assert.equal(edited.snapshot.value,'4.25');assert.equal(edited.snapshot.sourceVersion,'v1');assert.equal(edited.createdAt,saved.createdAt);assert.equal(edited.judgment,'新增判断');assert.notEqual(edited.snapshot,saved.snapshot);
});
test('local backup roundtrip preserves notes and no extra object fields',()=>{
 const backup=JSON.parse(serializeNotebook([note]));backup.notes[0].injected='drop';backup.notes[0].snapshot.injected='drop';
 assert.deepEqual(parseNotebook(JSON.stringify(backup)),[note]);
});
test('import rejects oversized, invalid, foreign-version and duplicate payloads atomically',()=>{
 assert.throws(()=>parseNotebook('x'.repeat(MAX_BACKUP_BYTES+1)),/5 MB/);
 assert.throws(()=>parseNotebook('{'),/JSON/);
 assert.throws(()=>parseNotebook(JSON.stringify({schema:'other',notes:[]})),/版本/);
 assert.throws(()=>parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[note,note]})),/重复/);
 assert.throws(()=>parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[note,{...note,id:'broken',snapshot:null}]})),/无效/);
 assert.throws(()=>parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[{...note,reviewOn:'2026-02-30'}]})),/无效/);
});
test('same-id imported notes never overwrite existing observations or writing',()=>{
 const imported={...note,title:'foreign version',snapshot:{...note.snapshot,value:'8.8'}};
 const extra={...note,id:'note-2'};const merged=mergeNotes([note],[imported,extra]);
 assert.equal(merged.added,1);assert.equal(merged.skipped,1);assert.equal(merged.notes.find(row=>row.id===note.id).title,note.title);assert.equal(merged.notes.find(row=>row.id===note.id).snapshot.value,'4.25');
});
test('saving cannot create a notebook larger than its own import limits',()=>{
 assert.throws(()=>serializeNotebook(Array.from({length:501},(_,index)=>({...note,id:String(index)}))),/500/);
 const large=Array.from({length:150},(_,index)=>({...note,id:String(index),judgment:'观'.repeat(12000),evidence:'察'.repeat(12000)}));
 assert.throws(()=>serializeNotebook(large),/5 MB/);
});
test('weekly ranges use Monday to Sunday and handle the year boundary',()=>{
 assert.deepEqual(weekRange('2026-11-01'),{start:'2026-10-26',end:'2026-11-01'});
 assert.deepEqual(weekRange('2027-01-01'),{start:'2026-12-28',end:'2027-01-03'});
 assert.throws(()=>weekRange('2026-02-30'));
});
test('timestamp range membership uses Beijing midnight, not UTC or browser timezone',()=>{
 const range=weekRange('2026-11-02');
 assert.equal(inWeek('2026-11-01T15:59:59Z',range),false);
 assert.equal(inWeek('2026-11-01T16:00:00Z',range),true);
 assert.equal(inWeek('2026-11-08T15:59:59Z',range),true);
 assert.equal(inWeek('2026-11-08T16:00:00Z',range),false);
 assert.equal(beijingDay('2026-11-01T16:00:00Z'),'2026-11-02');
 assert.equal(beijingDay('2026-11-01'),'2026-11-01');assert.equal(beijingDay('invalid'),null);
});
test('source links permit only http(s), without credentials',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,hello','file:///x','//example.com','https://user:secret@example.com'])assert.equal(safeSourceUrl(value),null);
 assert.equal(safeSourceUrl('https://example.com/data?q=1'),'https://example.com/data?q=1');
 assert.equal(createNote({...item,sourceUrl:'javascript:alert(1)'},fields,{id:'safe'}).snapshot.sourceUrl,null);
 assert.throws(()=>parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[{...note,snapshot:{...note.snapshot,sourceUrl:'javascript:alert(1)'}}]})),/无效/);
});
test('weekly disclosure list uses publication dates, not collection or observation dates',()=>{
 const data={...inputs,macro:{series:{NO_RELEASE:{fetchedAt:'2026-10-30T00:00:00Z',sourcePublishedAt:null,observations:[{date:'2026-10-30',value:5}]},PUBLISHED:{sourcePublishedAt:'2026-10-29T13:30:00Z',sourceUrl:'https://example.com/macro',revision:'r1',observations:[{date:'2026-09-01',value:5}]}}},industry:{definitions:[{id:'company.revenue',nameZh:'收入',unit:'亿美元'}],series:{'company.revenue':{observations:[{periodEnd:'2026-09-30',publishedAt:'2026-10-29',value:100,version:'q3',sourceUrl:'https://example.com/earnings'},{periodEnd:'2026-06-30',fetchedAt:'2026-10-29',value:90,version:'q2'}]}},events:[{title:'未确认',isConfirmed:false,date:'2026-10-30',sourceUrl:'https://example.com'}]},policyDecisions:{decisions:[{bank:'测试央行',announcementDate:'2026-10-30',effectiveDate:'2026-11-01',lower:3.75,upper:4,changeBps:0,statementUrl:'https://example.com/decision'}]}};
 const rows=collectDisclosures(data,weekRange('2026-10-31'));
 assert.equal(rows.length,3);assert.ok(rows.some(row=>row.title==='PUBLISHED'));assert.ok(rows.some(row=>row.title==='收入'&&row.period==='2026-09-30'));assert.ok(rows.some(row=>row.title==='测试央行'));assert.equal(rows.some(row=>row.title==='NO_RELEASE'||row.title==='未确认'),false);
});
test('report selects first-saved notes and explicitly labels current snapshot as nonhistorical',()=>{
 const old=editNote({...note,createdAt:'2026-10-01T00:00:00Z'},fields,'2026-10-30T00:00:00Z');
 const report=buildWeeklyReport({notes:[note,old],items:[item],inputs,day:'2026-10-31',now:'2026-11-02T00:00:00Z'});
 assert.equal(report.notes.length,1);assert.equal(report.snapshots.length,1);assert.match(report.limitations,/不代表所选周末已知数据/);
 const empty=buildWeeklyReport({notes:[],items:[item],inputs,day:'2026-10-31'});assert.match(weeklyHtml(empty),/没有首次保存的笔记/);assert.match(weeklyMarkdown(empty),/本节不是所选周的历史数据/);
});
test('HTML export escapes every user supplied text and source URL attribute',()=>{
 const attack='<img src=x onerror=alert(1)> & "hello"';
 const unsafeNote={...note,title:attack,judgment:'</p><script>alert(1)</script>',evidence:attack,snapshot:{...note.snapshot,title:attack,sourceUrl:'https://example.com/?q="x"&tag=%3C'}};
 const report=buildWeeklyReport({notes:[unsafeNote],items:[{...item,title:attack}],inputs,day:'2026-10-31'});const html=weeklyHtml(report);
 assert.equal(html.includes('<img src=x'),false);assert.equal(html.includes('<script>'),false);assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&amp;tag='));assert.equal(escapeHtml('<>"\'&'),'&lt;&gt;&quot;&#39;&amp;');
});
test('Markdown escapes bracket injection and parentheses inside links',()=>{
 const report=buildWeeklyReport({notes:[{...note,title:'[click](javascript:alert(1))',snapshot:{...note.snapshot,sourceUrl:'https://example.com/(a)'}}],items:[],inputs,day:'2026-10-31'});
 const md=weeklyMarkdown(report);assert.ok(md.includes('\\[click\\]'));assert.ok(md.includes('https://example.com/%28a%29'));
});

test('legacy v1 backups become pending notes without losing original fields',()=>{
 const legacy={...note};delete legacy.reviewStatus;delete legacy.reviews;
 const restored=parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[legacy]}))[0];
 assert.equal(restored.reviewStatus,'pending');assert.deepEqual(restored.reviews,[]);assert.deepEqual(restored.snapshot,note.snapshot);assert.equal(restored.judgment,note.judgment);
});
test('completion and reopening keep writing, source snapshot and every review result',()=>{
 const completed=completeNoteReview(note,'现金流未同步改善，继续观察','2026-11-07T01:00:00Z');
 assert.equal(completed.reviewStatus,'completed');assert.equal(completed.judgment,note.judgment);assert.deepEqual(completed.snapshot,note.snapshot);assert.equal(matchesNoteFilter(completed,'due','2026-11-10'),false);assert.equal(matchesNoteFilter(completed,'completed','2026-11-10'),true);
 const reopened=reopenNoteReview(completed,'2026-11-12','2026-11-10T01:00:00Z');
 assert.equal(reopened.reviewStatus,'pending');assert.deepEqual(reopened.reviews,completed.reviews);assert.equal(matchesNoteFilter(reopened,'due','2026-11-10'),false);assert.equal(matchesNoteFilter(reopened,'due','2026-11-12'),true);
 const twice=completeNoteReview(reopened,'下一期继续验证','2026-11-12T01:00:00Z');assert.equal(twice.reviews.length,2);assert.deepEqual(parseNotebook(serializeNotebook([twice])),[twice]);
 assert.throws(()=>completeNoteReview(completed,'重复完成'),/已完成/);assert.throws(()=>completeNoteReview(note,'  '),/请写下/);assert.throws(()=>reopenNoteReview(completed,'2026-02-30'),/无效/);
});
test('invalid review imports reject the complete backup instead of losing history',()=>{
 for(const invalid of [{reviewStatus:'wrong',reviews:[]},{reviewStatus:'completed',reviews:[]},{reviewStatus:'pending',reviews:[{completedAt:'bad',conclusion:'结果'}]}])assert.throws(()=>parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[note,{...note,id:'bad',...invalid}]})),/复盘记录无效/);
});
test('weekly report includes reviews by completion week even for older notes',()=>{
 const completed=completeNoteReview(note,'<script>结果</script> [复盘]','2026-11-08T16:00:00Z');
 const report=buildWeeklyReport({notes:[completed],items:[],inputs,day:'2026-11-10'});
 assert.equal(report.notes.length,0);assert.equal(report.reviews.length,1);assert.equal(report.reviews[0].conclusion,completed.reviews[0].conclusion);
 assert.match(weeklyHtml(report),/本周完成的复盘（1）/);assert.ok(!weeklyHtml(report).includes('<script>'));assert.ok(weeklyHtml(report).includes('&lt;script&gt;'));assert.ok(weeklyMarkdown(report).includes('\\[复盘\\]'));
 assert.equal(buildWeeklyReport({notes:[completed],items:[],inputs,day:'2026-11-08'}).reviews.length,0);
});
function memoryStorage(){const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};}
test('drafts restore exact unsaved input and clearing one cannot erase other drafts',()=>{
 const storage=memoryStorage(),key=noteDraftKey('item',item.id),other=noteDraftKey('note',item.id),review=noteDraftKey('review',item.id);
 const unfinished={...fields,title:'',judgment:'  尚未写完  ',reviewOn:null};
 writeNoteDraft(storage,key,unfinished,null,'2026-11-10T01:00:00Z');writeNoteDraft(storage,other,fields,note.updatedAt);writeNoteDraft(storage,review,fields,note.updatedAt);
 assert.deepEqual(readNoteDraft(storage,key).fields,unfinished);assert.equal(readNoteDraft(storage,other,note.updatedAt).fields.title,fields.title);
 clearNoteDraft(storage,key);assert.equal(readNoteDraft(storage,key),null);assert.ok(readNoteDraft(storage,other,note.updatedAt));assert.ok(readNoteDraft(storage,review,note.updatedAt));
});
test('stale and malformed drafts remain untouched and cannot cross contexts',()=>{
 const storage=memoryStorage(),key=noteDraftKey('note',note.id),other=noteDraftKey('item',note.id);writeNoteDraft(storage,key,fields,note.updatedAt);
 const original=storage.getItem(key);assert.throws(()=>readNoteDraft(storage,key,'2026-11-10T00:00:00Z'),/其他页面更新/);assert.equal(storage.getItem(key),original);
 storage.setItem(other,original);assert.throws(()=>readNoteDraft(storage,other,note.updatedAt),/格式无效/);storage.setItem(key,'{broken');assert.throws(()=>readNoteDraft(storage,key,note.updatedAt),/无法读取/);assert.equal(storage.getItem(key),'{broken');
 assert.throws(()=>clearNoteDraft(storage,'unrelated-key'),/无效/);assert.throws(()=>writeNoteDraft(storage,key,{...fields,reviewOn:'2026-02-30'}),/无效/);
});
test('draft storage failures surface to caller without pretending success',()=>{
 const storage={getItem(){throw Error('blocked')},setItem(){throw Error('quota')},removeItem(){throw Error('blocked')}};const key=noteDraftKey('item',item.id);
 assert.throws(()=>readNoteDraft(storage,key),/blocked/);assert.throws(()=>writeNoteDraft(storage,key,fields),/quota/);assert.throws(()=>clearNoteDraft(storage,key),/blocked/);
});
test('editing a note after completion cannot rewrite the historical review judgment or title',()=>{
 const completed=completeNoteReview({...note,title:'标题 A',judgment:'判断 A'},'完成验证','2026-11-10T01:00:00Z');
 const edited=editNote(completed,{...fields,title:'标题 B',judgment:'判断 B'},'2026-11-18T01:00:00Z');
 const restored=parseNotebook(serializeNotebook([edited]))[0];
 const report=buildWeeklyReport({notes:[restored],items:[],inputs,day:'2026-11-10'});
 assert.equal(report.reviews[0].title,'标题 A');assert.equal(report.reviews[0].judgment,'判断 A');assert.equal(report.reviews[0].judgmentBasis,'review');
 assert.ok(weeklyMarkdown(report).includes('复盘时的判断：判断 A'));assert.ok(!weeklyMarkdown(report).includes('判断 B'));assert.ok(weeklyHtml(report).includes('判断 A'));assert.ok(!weeklyHtml(report).includes('判断 B'));
 assert.equal(edited.judgment,'判断 B');assert.equal(edited.reviews[0].judgment,'判断 A');
});
test('old review records without a judgment snapshot remain readable and are labeled as current text',()=>{
 const legacy={...note,reviewStatus:'completed',reviews:[{completedAt:'2026-11-10T01:00:00Z',conclusion:'旧复盘结论'}]};
 const restored=parseNotebook(serializeNotebook([legacy]))[0];assert.equal(restored.reviews[0].judgment,undefined);
 const report=buildWeeklyReport({notes:[restored],items:[],inputs,day:'2026-11-10'});
 assert.equal(report.reviews[0].judgmentBasis,'current');assert.match(weeklyMarkdown(report),/当前笔记判断（旧记录未保存当时判断）/);assert.match(weeklyHtml(report),/当前笔记判断（旧记录未保存当时判断）/);
 for(const invalid of [{title:'只有标题'},{judgment:'只有判断'},{title:'标题',judgment:42}])assert.throws(()=>parseNotebook(JSON.stringify({schema:NOTEBOOK_SCHEMA,notes:[{...legacy,reviews:[{...legacy.reviews[0],...invalid}]}]})),/复盘记录无效/);
});

export const NOTEBOOK_SCHEMA = 'macro-observatory-notebook/v1';
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const MAX_NOTES = 500;
const MAX_TEXT = 12000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const text = (value, max = MAX_TEXT) => typeof value === 'string' && value.length <= max;

export function safeSourceUrl(value) {
 if(typeof value !== 'string')return null;
 try { const url = new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function escapeHtml(value) {return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
export function beijingDay(value) {
 if(validDate(value))return value;
 if(!timestamp(value))return null;
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}
export function weekRange(day) {
 if(!validDate(day))throw new Error('请选择有效日期。');
 const start = new Date(day+'T00:00:00Z');
 start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
 const end = new Date(start);end.setUTCDate(end.getUTCDate()+6);
 return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
}
export function inWeek(date, range) {const day=beijingDay(date);return Boolean(day&&day>=range.start&&day<=range.end);}

export function snapshotItem(item) {
 return {itemId:String(item.id),title:String(item.title),kind:String(item.kind),value:String(item.value??'—'),unit:String(item.unit??''),period:String(item.period??''),status:String(item.status??''),sourceUrl:safeSourceUrl(item.sourceUrl),sourceVersion:typeof item.sourceVersion==='string'?item.sourceVersion:null,checkedAt:timestamp(item.checkedAt)?item.checkedAt:null};
}
function validSnapshot(value) {
 return value&&typeof value==='object'&&text(value.itemId,240)&&value.itemId.length>0&&text(value.title,500)&&['macro','industry','valuation','policy'].includes(value.kind)&&['value','unit','period','status'].every(key=>text(value[key],1000))&&(value.sourceUrl===null||Boolean(safeSourceUrl(value.sourceUrl)))&&(value.sourceVersion===null||text(value.sourceVersion,2000))&&(value.checkedAt===null||timestamp(value.checkedAt));
}
function validateNote(note) {
 if(!note||typeof note!=='object'||!text(note.id,200)||!note.id||!text(note.title,300)||!note.title.trim()||!text(note.judgment)||!text(note.evidence)||!timestamp(note.createdAt)||!timestamp(note.updatedAt)||(note.reviewOn!==null&&!validDate(note.reviewOn))||!validSnapshot(note.snapshot))throw new Error('备份包含不完整或无效的笔记，未导入任何记录。');
 return {id:note.id,title:note.title,judgment:note.judgment,evidence:note.evidence,reviewOn:note.reviewOn,createdAt:note.createdAt,updatedAt:note.updatedAt,snapshot:{itemId:note.snapshot.itemId,title:note.snapshot.title,kind:note.snapshot.kind,value:note.snapshot.value,unit:note.snapshot.unit,period:note.snapshot.period,status:note.snapshot.status,sourceUrl:safeSourceUrl(note.snapshot.sourceUrl),sourceVersion:note.snapshot.sourceVersion,checkedAt:note.snapshot.checkedAt}};
}
export function createNote(item, fields, {id,now=new Date().toISOString()}={}) {
 return validateNote({id:id??globalThis.crypto.randomUUID(),title:fields.title.trim(),judgment:fields.judgment.trim(),evidence:fields.evidence.trim(),reviewOn:fields.reviewOn||null,createdAt:now,updatedAt:now,snapshot:snapshotItem(item)});
}
export function editNote(note, fields, now=new Date().toISOString()) {
 // Only writing fields can change. Original observation and creation time stay intact.
 return validateNote({...note,title:fields.title.trim(),judgment:fields.judgment.trim(),evidence:fields.evidence.trim(),reviewOn:fields.reviewOn||null,updatedAt:now,snapshot:{...note.snapshot}});
}
export function serializeNotebook(notes, now=new Date().toISOString()) {
 if(notes.length>MAX_NOTES)throw new Error('最多保存 500 条笔记，请先备份并清理。');
 const encoded=JSON.stringify({schema:NOTEBOOK_SCHEMA,exportedAt:now,notes:notes.map(validateNote)},null,2);
 if(new TextEncoder().encode(encoded).length>MAX_BACKUP_BYTES)throw new Error('笔记总量超过 5 MB，请先导出已有记录并清理。');
 return encoded;
}
export function parseNotebook(input) {
 if(typeof input!=='string'||new TextEncoder().encode(input).length>MAX_BACKUP_BYTES)throw new Error('备份文件不能超过 5 MB。');
 let value;try{value=JSON.parse(input);}catch{throw new Error('无法读取 JSON 备份，现有笔记未改动。');}
 if(value?.schema!==NOTEBOOK_SCHEMA||!Array.isArray(value.notes)||value.notes.length>MAX_NOTES)throw new Error('备份格式或版本不匹配，最多支持 500 条笔记。');
 const ids=new Set();return value.notes.map(note=>{const checked=validateNote(note);if(ids.has(checked.id))throw new Error('备份存在重复笔记编号，未导入任何记录。');ids.add(checked.id);return checked;});
}
export function mergeNotes(existing, incoming) {
 const ids=new Set(existing.map(note=>note.id));const fresh=incoming.filter(note=>!ids.has(note.id));
 if(existing.length+fresh.length>MAX_NOTES)throw new Error('合并后超过 500 条，请先备份并清理不需要的笔记。');
 return {notes:[...existing,...fresh].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),added:fresh.length,skipped:incoming.length-fresh.length};
}

/** Publications, not retrieval times. Historical prices do not imply a release date. */
export function collectDisclosures(inputs, range) {
 const rows=[];const seen=new Set();
 function add(row) {if(!inWeek(row.date,range))return;const key=[row.kind,row.title,row.date,row.period,row.version].join('|');if(seen.has(key))return;seen.add(key);rows.push({...row,sourceUrl:safeSourceUrl(row.sourceUrl)});}
 for(const [id,series] of Object.entries(inputs?.macro?.series??{})){
  if(series.sourcePublishedAt)add({kind:'宏观发布',title:id,date:series.sourcePublishedAt,period:series.observations?.at(-1)?.date??'',detail:'来源标记的最近发布时间；观测值以当前快照为准。',sourceUrl:series.sourceUrl,version:series.revision??''});
 }
 const industry=inputs?.industry;const definitions=new Map((industry?.definitions??[]).map(row=>[row.id,row]));
 for(const [id,series] of Object.entries(industry?.series??{}))for(const observation of series.observations??[]){
  const published=observation.publishedAt||observation.filingDate;if(!published)continue;
  const definition=definitions.get(id);add({kind:'企业/产业披露',title:definition?.nameZh??id,date:published,period:observation.periodEnd,detail:`${observation.value??'—'} ${definition?.unit??''}${observation.isRestated?' · 修订版本':''}`,sourceUrl:observation.sourceUrl,version:observation.version??''});
 }
 for(const event of industry?.events??[])if(event.isConfirmed)add({kind:'产业事件',title:event.title,date:event.date,period:event.period??'',detail:event.description,sourceUrl:event.sourceUrl,version:event.version??''});
 for(const decision of inputs?.policyDecisions?.decisions??[])add({kind:'央行决议',title:decision.bank,date:decision.announcedAt||decision.announcementDate,period:decision.effectiveDate??decision.announcementDate,detail:`${decision.lower===decision.upper?decision.lower:decision.lower+'–'+decision.upper}% · ${decision.changeBps===0?'维持不变':`${decision.changeBps>0?'上调':'下调'} ${Math.abs(decision.changeBps)}bp`}`,sourceUrl:decision.statementUrl,version:''});
 return rows.sort((a,b)=>b.date.localeCompare(a.date)||a.title.localeCompare(b.title,'zh-CN'));
}
export function buildWeeklyReport({notes,items,inputs,day,now=new Date().toISOString()}) {
 const range=weekRange(day);
 return {range,generatedAt:now,notes:notes.filter(note=>inWeek(note.createdAt,range)).map(validateNote),disclosures:collectDisclosures(inputs,range),snapshots:items.map(snapshotItem),limitations:'笔记按首次保存时间统计，带时区的时间统一换算为北京时间；来源只给日期时保留其原始日期。披露记录仅覆盖网站当前保留且明确标注发布时间的数据，不等于完整历史发布清单。下方观察快照是导出时的当前数据，不代表所选周末已知数据，也不构成回测。'};
}
const display = value => value===null||value===undefined||value===''?'未提供':String(value);
const safeMd = value => display(value).replace(/[\\`*_[\]<>#|]/g,'\\$&').replace(/\r?\n/g,'  \n');
function markdownLink(url) {const safe=safeSourceUrl(url);return safe?`[来源](${safe.replace(/[()\s]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())})`:'来源未提供';}
export function weeklyMarkdown(report) {
 const lines=[`# 每周观察报告`,`${report.range.start} — ${report.range.end}（周一至周日）`,`生成时间：${safeMd(report.generatedAt)}`,report.limitations,'','## 本周保存的研究笔记'];
 if(!report.notes.length)lines.push('所选周没有首次保存的笔记。');
 for(const note of report.notes)lines.push(`### ${safeMd(note.title)}`,`首次记录：${safeMd(note.createdAt)}；最近编辑：${safeMd(note.updatedAt)}；复盘日：${display(note.reviewOn)}`,`判断：${safeMd(note.judgment)}`,`依据：${safeMd(note.evidence)}`,`当时快照：${safeMd(note.snapshot.title)} · ${safeMd(note.snapshot.value)} ${safeMd(note.snapshot.unit)} · 观测期 ${safeMd(note.snapshot.period)} · 状态 ${safeMd(note.snapshot.status)} · 版本 ${safeMd(note.snapshot.sourceVersion)} · ${markdownLink(note.snapshot.sourceUrl)}`,'');
 lines.push('## 所选周已标注发布时间的披露');
 if(!report.disclosures.length)lines.push('当前保存数据中没有符合周范围的明确披露记录。');
 for(const row of report.disclosures)lines.push(`- ${safeMd(row.date)} · ${safeMd(row.kind)} · ${safeMd(row.title)}：${safeMd(row.detail)}；观测期 ${safeMd(row.period)} · ${markdownLink(row.sourceUrl)}`);
 lines.push('','## 导出时的当前观察快照','本节不是所选周的历史数据。');
 for(const row of report.snapshots)lines.push(`- ${safeMd(row.title)}：${safeMd(row.value)} ${safeMd(row.unit)}；观测期 ${safeMd(row.period)}；状态 ${safeMd(row.status)}；版本 ${safeMd(row.sourceVersion)} · ${markdownLink(row.sourceUrl)}`);
 return lines.join('\n\n');
}
export function weeklyHtml(report) {
 const e=escapeHtml;const link=url=>{const safe=safeSourceUrl(url);return safe?`<a href="${e(safe)}" rel="noopener noreferrer">官方/原始来源</a>`:'来源未提供';};
 const noteRows=report.notes.map(note=>`<article><h3>${e(note.title)}</h3><p class="meta">首次记录 ${e(note.createdAt)} · 编辑 ${e(note.updatedAt)} · 复盘 ${e(display(note.reviewOn))}</p><h4>当时的判断</h4><p>${e(display(note.judgment))}</p><h4>依据与待验证条件</h4><p>${e(display(note.evidence))}</p><p class="snapshot">${e(note.snapshot.title)}：${e(note.snapshot.value)} ${e(note.snapshot.unit)} · 观测期 ${e(display(note.snapshot.period))} · ${e(note.snapshot.status)} · 版本 ${e(display(note.snapshot.sourceVersion))} · ${link(note.snapshot.sourceUrl)}</p></article>`).join('');
 const disclosures=report.disclosures.map(row=>`<tr><td>${e(row.date)}</td><td>${e(row.kind)}<br><strong>${e(row.title)}</strong></td><td>${e(row.detail)}<br>观测期 ${e(display(row.period))}</td><td>${link(row.sourceUrl)}</td></tr>`).join('');
 const snapshots=report.snapshots.map(row=>`<tr><td>${e(row.title)}</td><td>${e(row.value)} ${e(row.unit)}</td><td>${e(display(row.period))}</td><td>${e(row.status)}<br>版本 ${e(display(row.sourceVersion))}<br>${link(row.sourceUrl)}</td></tr>`).join('');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>每周观察报告 ${e(report.range.start)}</title><style>body{margin:0 auto;padding:40px;max-width:1000px;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#213b3b}h1{font-size:30px}h2{margin-top:38px;border-bottom:2px solid #178a75;padding-bottom:10px}h3{margin-bottom:8px}h4{margin-bottom:0}p{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#117763;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #dbe6e2;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}article{border:1px solid #dbe6e2;border-radius:10px;padding:20px;margin:16px 0}.meta{color:#607571;font-size:12px}.snapshot,.scope{background:#eef6f3;padding:14px}.scope{border-left:3px solid #178a75}thead{display:table-header-group}@media print{body{padding:0;font-size:11px}h2,h3{break-after:avoid}article,tr{break-inside:avoid}@page{margin:18mm}}@media(max-width:600px){body{padding:18px}table{font-size:11px}th,td{padding:5px}}</style></head><body><h1>每周观察报告</h1><p>${e(report.range.start)} — ${e(report.range.end)} · 周一至周日</p><p class="meta">生成时间 ${e(report.generatedAt)} · 个人研究记录</p><p class="scope">${e(report.limitations)}</p><h2>本周保存的研究笔记（${report.notes.length}）</h2>${noteRows||'<p>所选周没有首次保存的笔记。</p>'}<h2>所选周已标注发布时间的披露（${report.disclosures.length}）</h2>${disclosures?`<table><thead><tr><th>发布时间</th><th>事项</th><th>内容</th><th>来源</th></tr></thead><tbody>${disclosures}</tbody></table>`:'<p>当前保存数据中没有符合周范围的明确披露记录。</p>'}<h2>导出时的当前观察快照</h2><p class="scope">本节不是所选周的历史数据。请结合每项观测期和状态阅读。</p><table><thead><tr><th>指标</th><th>最新值</th><th>观测期</th><th>状态和来源</th></tr></thead><tbody>${snapshots}</tbody></table></body></html>`;
}

"use client";

import {useEffect,useId,useMemo,useRef,useState,type FormEvent} from 'react';
import {BookOpen,Download,FileText,NotebookPen,Printer,Upload,X} from 'lucide-react';
import type {ObservationItem,ObserverInputs} from '../lib/observer-types';
import {beijingDay,buildWeeklyReport,createNote,editNote,MAX_BACKUP_BYTES,MAX_NOTES,mergeNotes,parseNotebook,safeSourceUrl,serializeNotebook,weeklyHtml,weeklyMarkdown,weekRange,type NoteFields,type NoteSnapshot,type ResearchNote} from '../lib/research-notebook.mjs';
import './research-notebook.css';

const STORAGE='macro-observatory:research-notebook:v1';
const CHANGE='macro-observatory:notebook-change';
function readNotes():ResearchNote[]{const raw=localStorage.getItem(STORAGE);return raw?parseNotebook(raw):[];}
function writeNotes(notes:ResearchNote[]){localStorage.setItem(STORAGE,serializeNotebook(notes));window.dispatchEvent(new Event(CHANGE));}
function message(error:unknown){return error instanceof Error?error.message:'保存失败，请检查浏览器是否允许本地存储。';}
function time(value:string){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value));}
function download(content:string,name:string,type:string){const url=URL.createObjectURL(new Blob([content],{type}));const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
function useNotes(){
 const [notes,setNotes]=useState<ResearchNote[]>([]),[error,setError]=useState('');
 useEffect(()=>{const read=()=>{try{setNotes(readNotes());setError('');}catch(err){setError('无法读取本地笔记：'+message(err)+' 为保护已有记录，修改操作将停止。');}};const storage=(event:StorageEvent)=>{if(event.key===STORAGE||event.key===null)read();};read();window.addEventListener(CHANGE,read);window.addEventListener('storage',storage);return()=>{window.removeEventListener(CHANGE,read);window.removeEventListener('storage',storage);};},[]);
 return {notes,error};
}
function Source({url}:{url?:string|null}){const safe=safeSourceUrl(url);return safe?<a href={safe} target="_blank" rel="noopener noreferrer">查看来源 ↗</a>:<span>来源链接未提供</span>;}
function Snapshot({snapshot}:{snapshot:NoteSnapshot}){return <dl className="rnb-snapshot"><div><dt>指标与数值</dt><dd>{snapshot.title} · <strong>{snapshot.value} {snapshot.unit}</strong></dd></div><div><dt>观测期 / 状态</dt><dd>{snapshot.period||'未提供'} · {snapshot.status||'未提供'}</dd></div><div><dt>来源版本</dt><dd>{snapshot.sourceVersion||'来源未提供版本号'}</dd></div><div><dt>检查时间</dt><dd>{snapshot.checkedAt?time(snapshot.checkedAt)+'（北京）':'未提供'} · <Source url={snapshot.sourceUrl}/></dd></div></dl>;}

function NoteForm({item,note,onSaved,onCancel}:{item?:ObservationItem;note?:ResearchNote;onSaved:()=>void;onCancel:()=>void}){
 const id=useId();const [fields,setFields]=useState<NoteFields>({title:note?.title??item?.title??'',judgment:note?.judgment??'',evidence:note?.evidence??'',reviewOn:note?.reviewOn??null});
 const [error,setError]=useState('');const [saving,setSaving]=useState(false);
 function submit(event:FormEvent){event.preventDefault();setSaving(true);try{const current=readNotes();if(note){const original=current.find(row=>row.id===note.id);if(!original)throw new Error('这条笔记已在其他页面删除，请刷新列表。');writeNotes(current.map(row=>row.id===note.id?editNote(original,fields):row));}else if(item){if(current.length>=MAX_NOTES)throw new Error('最多保存 500 条笔记，请先备份并清理。');writeNotes([createNote(item,fields),...current]);}onSaved();}catch(err){setError(message(err));}finally{setSaving(false);}}
 return <form className="rnb-editor" onSubmit={submit}>
  <p>{note?'编辑文字与复盘日期；首次保存时的数据快照保持原样。':'保存你自己的判断、依据，以及此刻显示的数据快照。'}</p>
  <label htmlFor={id+'title'}>笔记标题<input id={id+'title'} value={fields.title} onChange={event=>setFields({...fields,title:event.target.value})} maxLength={300} required/></label>
  <label htmlFor={id+'judgment'}>我的判断<textarea id={id+'judgment'} value={fields.judgment} onChange={event=>setFields({...fields,judgment:event.target.value})} maxLength={12000} rows={3} placeholder="我观察到了什么？目前持什么判断？"/></label>
  <label htmlFor={id+'evidence'}>依据与待验证条件<textarea id={id+'evidence'} value={fields.evidence} onChange={event=>setFields({...fields,evidence:event.target.value})} maxLength={12000} rows={3} placeholder="支持或反对的证据；什么变化会让我修改判断？"/></label>
  <label htmlFor={id+'review'}>计划复盘日期（选填）<input id={id+'review'} type="date" value={fields.reviewOn??''} onChange={event=>setFields({...fields,reviewOn:event.target.value||null})}/></label>
  <p className="rnb-hint">仅保存在当前浏览器；复盘日期用于列表提醒，不会发送消息或系统通知。</p>
  {error&&<p role="alert" className="rnb-error">{error}</p>}
  <div className="rnb-actions"><button type="submit" disabled={saving} className="rnb-primary">保存笔记</button><button type="button" onClick={onCancel}>取消</button></div>
 </form>;
}

/** Reusable beside a chart; saving never changes the underlying dataset. */
export function ObservationNoteButton({item}:{item:ObservationItem}){
 const [draft,setDraft]=useState<ObservationItem|null>(null),[saved,setSaved]=useState(false);const id=useId();
 return <div className="rnb-inline"><button type="button" className="rnb-note-button" aria-expanded={Boolean(draft)} aria-controls={id} onClick={()=>{setDraft(draft?null:{...item});setSaved(false);}}><NotebookPen size={15} aria-hidden="true"/>{draft?'收起笔记':'记笔记'}</button>{saved&&<span role="status" className="rnb-saved">已存入本机研究笔记</span>}{draft&&<div id={id}><NoteForm key={draft.id} item={draft} onSaved={()=>{setDraft(null);setSaved(true);}} onCancel={()=>setDraft(null)}/></div>}</div>;
}

function NoteCard({note,items,onMessage}:{note:ResearchNote;items:ObservationItem[];onMessage:(text:string)=>void}){
 const [editing,setEditing]=useState(false),[deleting,setDeleting]=useState(false);const current=items.find(item=>item.id===note.snapshot.itemId);const today=beijingDay(new Date().toISOString())??'';
 function remove(){try{writeNotes(readNotes().filter(row=>row.id!==note.id));onMessage('已删除笔记。');}catch(error){onMessage('删除失败：'+message(error));}}
 return <article className="rnb-note-card"><div className="rnb-note-heading"><div><h3>{note.title}</h3><p>首次保存 {time(note.createdAt)}{note.updatedAt!==note.createdAt?` · 编辑 ${time(note.updatedAt)}`:''}（北京）</p></div>{note.reviewOn&&<span className={note.reviewOn<=today?'rnb-due':'rnb-tag'}>{note.reviewOn<=today?'待复盘':'计划复盘'} · {note.reviewOn}</span>}</div>
  {editing?<NoteForm note={note} onSaved={()=>{setEditing(false);onMessage('文字已更新，初始数据快照已保留。');}} onCancel={()=>setEditing(false)}/>:<><div className="rnb-note-prose"><h4>我的判断</h4><p>{note.judgment||'未填写'}</p><h4>依据与待验证条件</h4><p>{note.evidence||'未填写'}</p></div><details className="rnb-comparison"><summary>查看当时快照与当前数据</summary><div className="rnb-compare-grid"><div><h4>首次保存时</h4><Snapshot snapshot={note.snapshot}/></div><div><h4>当前观察</h4>{current?<><p><strong>{current.value} {current.unit}</strong></p><p>观测期 {current.period||'未提供'} · {current.status}</p><p>版本 {current.sourceVersion||'来源未提供版本号'}</p><Source url={current.sourceUrl}/><p><a href={current.href}>打开指标面板 →</a></p></>:<p>当前目录中没有此指标，历史快照仍保留。</p>}</div></div></details><div className="rnb-actions"><button type="button" onClick={()=>setEditing(true)}>编辑文字</button>{deleting?<><span>删除后需通过备份恢复。</span><button type="button" onClick={remove}>确认删除</button><button type="button" onClick={()=>setDeleting(false)}>取消</button></>:<button type="button" onClick={()=>setDeleting(true)}>删除</button>}</div></>}
 </article>;
}

export function ResearchNotebook({items,inputs}:{items:ObservationItem[];inputs:ObserverInputs}){
 const {notes,error}=useNotes();const [selectedId,setSelectedId]=useState(''),[creating,setCreating]=useState(false),[search,setSearch]=useState(''),[filter,setFilter]=useState('all'),[notice,setNotice]=useState(''),[weekDay,setWeekDay]=useState(()=>beijingDay(new Date().toISOString())??new Date().toISOString().slice(0,10));
 const fileInput=useRef<HTMLInputElement>(null);const today=beijingDay(new Date().toISOString())??'';const [visible,setVisible]=useState(8);
 const item=items.find(row=>row.id===selectedId)??items[0];
 const filtered=useMemo(()=>notes.filter(note=>(filter!=='due'||note.reviewOn&&note.reviewOn<=today)&&`${note.title} ${note.judgment} ${note.evidence} ${note.snapshot.title}`.toLowerCase().includes(search.toLowerCase())),[notes,filter,today,search]);
 const report=useMemo(()=>buildWeeklyReport({notes,items,inputs,day:weekDay}),[notes,items,inputs,weekDay]);
 const range=weekRange(weekDay);const due=notes.filter(note=>note.reviewOn&&note.reviewOn<=today).length;
 async function importBackup(file:File){try{if(file.size>MAX_BACKUP_BYTES)throw new Error('备份文件不能超过 5 MB。');const incoming=parseNotebook(await file.text());const result=mergeNotes(readNotes(),incoming);writeNotes(result.notes);setNotice(`已导入 ${result.added} 条；${result.skipped} 条同编号记录保留本机版本。`);}catch(err){setNotice('未导入：'+message(err));}finally{if(fileInput.current)fileInput.current.value='';}}
 function exportBackup(){try{download(serializeNotebook(readNotes()),`研究笔记备份-${today}.json`,'application/json;charset=utf-8');setNotice('备份文件已生成，导入其他浏览器即可继续使用。');}catch(err){setNotice('导出失败：'+message(err));}}
 function printReport(){const popup=window.open('','_blank');if(!popup){setNotice('浏览器拦截了打印窗口；请允许弹窗，或先下载 HTML 后打印。');return;}popup.opener=null;popup.document.open();popup.document.write(weeklyHtml(report));popup.document.close();window.setTimeout(()=>{if(!popup.closed)popup.print();},250);setNotice('已打开打印版，可在打印窗口选择“另存为 PDF”。');}
 return <section className="research-notebook" aria-label="研究笔记与每周观察报告">
  <header className="rnb-header"><div><span className="rnb-kicker">MY RESEARCH JOURNAL</span><h2><BookOpen size={25} aria-hidden="true"/>研究笔记与每周观察</h2><p>留下当时的判断与数据，之后再对照事实复盘。</p></div><span className="rnb-tag">{notes.length} 条笔记 · {due} 条待复盘</span></header>
  <p className="rnb-local-note">笔记只保存在当前浏览器，不会上传。清理浏览器数据可能丢失记录；更换电脑或浏览器前，请导出 JSON 备份。</p>
  {error&&<p role="alert" className="rnb-error">{error}</p>}{notice&&<p role="status" className="rnb-notice">{notice}<button type="button" aria-label="关闭提示" onClick={()=>setNotice('')}><X size={14}/></button></p>}
  <div className="rnb-actions rnb-backups"><button type="button" disabled={Boolean(error)} onClick={exportBackup}><Download size={15}/>导出笔记备份</button><button type="button" disabled={Boolean(error)} onClick={()=>fileInput.current?.click()}><Upload size={15}/>导入 JSON 备份</button><input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="导入研究笔记备份" onChange={event=>{const file=event.target.files?.[0];if(file)void importBackup(file);}}/><span>导入时同编号记录保留本机版本，不覆盖已有笔记。</span></div>
  <section className="rnb-create"><h3>记录一次观察</h3><div className="rnb-create-row"><label>关联指标<select aria-label="笔记关联指标" value={item?.id??''} onChange={event=>{setSelectedId(event.target.value);setCreating(false);}}>{items.map(row=><option key={row.id} value={row.id}>{row.title} · {row.period||'暂无观测'}</option>)}</select></label><button type="button" className="rnb-primary" disabled={!item||Boolean(error)} onClick={()=>setCreating(true)}><NotebookPen size={16}/>新建笔记</button></div>{creating&&item&&<NoteForm key={item.id} item={item} onSaved={()=>{setCreating(false);setNotice('笔记和当时的数据快照已保存。');}} onCancel={()=>setCreating(false)}/>}</section>
  <section className="rnb-weekly"><div className="rnb-weekly-heading"><div><h3><FileText size={20}/>每周观察报告</h3><p>汇总所选周首次保存的笔记，以及网站保留的明确披露记录。</p></div><label>选择周内任一天<input type="date" aria-label="周报选择日期" value={weekDay} onChange={event=>{if(event.target.value&&/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)){try{weekRange(event.target.value);setWeekDay(event.target.value);}catch{/* Keep the last valid range. */}}}}/></label></div><p><strong>{range.start} — {range.end}</strong> · {report.notes.length} 条笔记 · {report.disclosures.length} 条披露 · {report.snapshots.length} 项当前快照</p><p className="rnb-hint">{report.limitations}</p>{!report.notes.length&&<p className="rnb-hint">这一周没有保存的笔记，仍可导出明确标注日期的当前观察快照。</p>}<div className="rnb-actions"><button type="button" onClick={()=>download(weeklyMarkdown(report),`每周观察-${range.start}.md`,'text/markdown;charset=utf-8')}><Download size={15}/>导出 Markdown</button><button type="button" onClick={()=>download(weeklyHtml(report),`每周观察-${range.start}.html`,'text/html;charset=utf-8')}><Download size={15}/>导出 HTML</button><button type="button" onClick={printReport}><Printer size={15}/>打印 / PDF</button></div><details className="rnb-disclosures"><summary>预览本周披露事项（{report.disclosures.length}）</summary>{report.disclosures.length?<ul>{report.disclosures.slice(0,25).map((row,index)=><li key={index}><time>{beijingDay(row.date)||row.date}</time><strong>{row.title}</strong><span>{row.detail}</span><Source url={row.sourceUrl}/></li>)}</ul>:<p>当前保存数据中没有符合周范围的明确披露记录。</p>}{report.disclosures.length>25&&<p>预览显示前 25 条，导出包含全部 {report.disclosures.length} 条。</p>}</details></section>
  <div className="rnb-list-heading"><h3>我的笔记</h3><div className="rnb-list-filters"><input aria-label="搜索研究笔记" placeholder="搜索判断、依据或指标" value={search} onChange={event=>{setSearch(event.target.value);setVisible(8);}}/><select aria-label="筛选研究笔记" value={filter} onChange={event=>{setFilter(event.target.value);setVisible(8);}}><option value="all">全部笔记</option><option value="due">待复盘</option></select></div></div>
  {filtered.length?<div className="rnb-notes">{filtered.slice(0,visible).map(note=><NoteCard key={note.id} note={note} items={items} onMessage={setNotice}/>)}</div>:<p className="rnb-empty">{notes.length?'没有符合条件的笔记。':'还没有研究笔记。可以在这里新建，也可以在图表旁点击“记笔记”。'}</p>}{filtered.length>visible&&<button type="button" className="rnb-more" onClick={()=>setVisible(visible+8)}>再显示 8 条（还有 {filtered.length-visible} 条）</button>}
 </section>;
}

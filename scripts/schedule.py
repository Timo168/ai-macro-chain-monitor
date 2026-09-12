"""Run by Task Scheduler every 15 min. Calendar-driven selection, bounded retries."""
import argparse, concurrent.futures, json, os, pathlib, re, time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urljoin
from zoneinfo import ZoneInfo
from calendar_provider import CalendarParser
from collect import ROOT, DATA, REGISTRY, collect, download
CT=ZoneInfo('America/Chicago')
RIDS={10:['CPIAUCNS','CPILFENS','CPIAUCSL','CPILFESL'],50:['UNRATE','PAYEMS'],54:['PCEPI','PCEPILFE'],180:['ICSA'],221:['NFCI'],18:['DGS10','DFII10'],212:['DCOILBRENTEU']}
def atomic(path,data):
    tmp=path.with_suffix('.tmp.json');tmp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8');os.replace(tmp,path)
def fetch_calendar(rid,now):
    lookback=62 if rid in (10,50,54) else 21 if rid in (180,221) else 7
    url='https://fred.stlouisfed.org/releases/calendar?'+urlencode({'rid':rid,'vs':(now-timedelta(days=lookback)).date().isoformat(),'ve':(now+timedelta(days=100)).date().isoformat()})
    original=url;events=[]
    for page in range(4):
        content=download(url).decode('utf-8-sig');parser=CalendarParser();parser.feed(content)
        if not parser.rows or 'All times are US Central Time' not in content:raise ValueError('Calendar markup or timezone changed')
        date=None
        for row in parser.rows:
            cells=row['cells'];date_cell=next((c for c in cells if c['attrs'].get('colspan')=='2'),None)
            if date_cell:
                date=datetime.strptime((date_cell['firstSpan'] or date_cell['text']).strip(),'%A %B %d, %Y').date();continue
            if date is None or len(cells)<2:continue
            if not any(a['href'].startswith('/release?rid='+str(rid)) for a in cells[1]['links']):continue
            raw=cells[0]['text'].strip()
            if not raw:continue
            clock=datetime.strptime(raw.upper(),'%I:%M %p').time();stamp=datetime.combine(date,clock,tzinfo=CT).astimezone(timezone.utc).isoformat()
            events.append({'scheduledAt':stamp,'calendarUrl':original})
        if len([e for e in events if datetime.fromisoformat(e['scheduledAt'])>now])>=3 or not parser.next_url:break
        url=urljoin(url,parser.next_url)
    if not events:raise ValueError('No usable release dates')
    return {'releaseId':rid,'status':'ok','events':events,'fetchedAt':now.isoformat(),'sourceUrl':original}
def calendar(now):
    path=DATA/'calendar.json';old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if old.get('checkedAt') and now-datetime.fromisoformat(old['checkedAt'])<timedelta(hours=20):return old
    entries=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures={pool.submit(fetch_calendar,rid,now):rid for rid in RIDS}
        for job in concurrent.futures.as_completed(futures):
            rid=futures[job]
            try:entries.append(job.result())
            except Exception as exc:
                prior=next((e for e in old.get('fred',[]) if e['releaseId']==rid),{'releaseId':rid,'events':[]})
                entries.append({**prior,'status':'cached' if prior['events'] else 'fetch_failed','error':str(exc)})
    # Direct BEA machine-readable schedule is preferred for PCE.
    try:
        raw=json.loads(download('https://apps.bea.gov/API/signup/release_dates.json'));dates=raw['Personal Income and Outlays']['release_dates']
        bea={'releaseId':54,'status':'ok','fetchedAt':now.isoformat(),'sourceUrl':'https://apps.bea.gov/API/signup/release_dates.json','events':[{'scheduledAt':d,'calendarUrl':'https://apps.bea.gov/API/signup/release_dates.json'} for d in dates if now-timedelta(days=62)<=datetime.fromisoformat(d)<=now+timedelta(days=100)]}
        entries=[e for e in entries if e['releaseId']!=54]+[bea]
    except Exception:pass
    result={'checkedAt':now.isoformat(),'fred':entries};atomic(path,result);return result
def expected_date(key,event):
    d=event.astimezone(CT).date()
    if key in ('UNRATE','PAYEMS','CPIAUCNS','CPILFENS','CPIAUCSL','CPILFESL','PCEPI','PCEPILFE'):
        return (d.replace(day=1)-timedelta(days=1)).replace(day=1).isoformat()
    if key in ('ICSA','NFCI'):
        target=5 if key=='ICSA' else 4
        return (d-timedelta(days=(d.weekday()-target)%7 or 7)).isoformat()
    return None
def run(force=False):
    now=datetime.now(timezone.utc);lock=DATA/'schedule.lock'
    if lock.exists() and time.time()-lock.stat().st_mtime<1800:print('Another collector is running');return
    lock.write_text(str(os.getpid()))
    try:
        cal=calendar(now);path=DATA/'scheduler.json';state=json.loads(path.read_text()) if path.exists() else {'attempts':{}}
        cached=json.loads((DATA/'latest.json').read_text(encoding='utf-8'));selected=[];pending={}
        for item in REGISTRY:
            key=item['id'];s=cached['series'].get(key,{});last=s.get('observations',[]);last_date=next((p['date'] for p in reversed(last) if p['value'] is not None),'')
            checked=datetime.fromisoformat(s.get('checkedAt') or '2000-01-01T00:00:00+00:00')
            if force or not last:selected.append(key);continue
            if key in ('COPPER','GOLD','SILVER','DFEDTARL','DFEDTARU'):
                if now-checked>=timedelta(hours=24):selected.append(key)
                pending[key]={'state':'waiting_release','nextCheckAt':(checked+timedelta(hours=24)).isoformat(),'calendarSource':'daily_file_check' if key in ('COPPER','GOLD','SILVER') else 'daily_effective_rate_check'};continue
            rid=next(r for r,keys in RIDS.items() if key in keys);entry=next((e for e in cal['fred'] if e['releaseId']==rid),{})
            times=sorted(datetime.fromisoformat(e['scheduledAt']) for e in entry.get('events',[]));past=[t for t in times if t<=now];future=[t for t in times if t>now];due=past[-1] if past else None
            state.setdefault('lastDue',{})
            if due:state['lastDue'][str(rid)]=due.isoformat()
            elif state['lastDue'].get(str(rid)):due=datetime.fromisoformat(state['lastDue'][str(rid)])
            if not times:
                if now-checked>=timedelta(hours=24):selected.append(key)
                pending[key]={'state':'calendar_unavailable','nextCheckAt':(now+timedelta(hours=24)).isoformat()};continue
            expected=expected_date(key,due) if due else None
            not_yet=bool(due and expected and last_date<expected)
            attempt_key=key+'_'+(due.isoformat() if due else 'none');attempt=state['attempts'].get(attempt_key,0)
            retry_after=min(120,15*2**min(attempt,3))
            needs=due and (checked<due or (not_yet and now-checked>=timedelta(minutes=retry_after) and now-due<timedelta(hours=48)))
            # A prolonged outage must not freeze a monthly series until next month's release.
            if not_yet and now-due>=timedelta(hours=48) and now-checked>=timedelta(hours=24):needs=True
            if s.get('status') in ('cached','fetch_failed') and now-checked>=timedelta(minutes=retry_after):needs=True
            # Daily sources: daily cadence also captures late FRED updates / revisions after release.
            if item['frequency']=='daily' and now-checked>=timedelta(hours=24):needs=True
            # Weekly revision reconciliation also catches releases missing from refreshed calendars.
            if now-checked>=timedelta(days=7):needs=True
            if needs:selected.append(key);state['attempts'][attempt_key]=attempt+1
            pending[key]={'state':'delayed' if not_yet and now-due>timedelta(hours=48) else 'awaiting_source' if not_yet else 'waiting_release','expectedObservationDate':expected,'nextReleaseAt':future[0].isoformat() if future else None,'lastScheduledReleaseAt':due.isoformat() if due else None,'calendarSource':entry.get('sourceUrl'),'calendarStatus':entry.get('status')}
        os.environ.setdefault('MACRO_SCHEDULER','scheduled')
        result=collect(selected=selected) if selected else cached
        for key,info in pending.items():
            s=result['series'][key];latest=next((p['date'] for p in reversed(s['observations']) if p['value'] is not None),'')
            if info.get('expectedObservationDate') and latest>=info['expectedObservationDate']:info['state']='waiting_release'
            s['publication']=info
        result['scheduler']={'mode':os.environ['MACRO_SCHEDULER'],'lastRunAt':now.isoformat(),'lastFetchAt':result.get('generatedAt'),'nextCheckAt':(now+timedelta(minutes=int(os.environ.get('MACRO_CHECK_MINUTES','15')))).isoformat(),'calendarStatus':'ready' if all(e['status']=='ok' for e in cal['fred']) else 'partial_cache','checkedSeries':selected}
        atomic(DATA/'latest.json',result);state['lastRunAt']=now.isoformat();state['selected']=selected;atomic(path,state)
        print(json.dumps({'checkedAt':now.isoformat(),'selected':selected,'calendarStatus':result['scheduler']['calendarStatus']},ensure_ascii=False))
    finally:lock.unlink(missing_ok=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--force',action='store_true');args=p.parse_args();run(args.force)

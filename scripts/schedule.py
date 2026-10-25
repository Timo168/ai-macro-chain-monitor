"""Run by Task Scheduler every 15 min. Calendar-driven selection, bounded retries."""
import argparse, concurrent.futures, json, os, pathlib, re, sys, time
from datetime import date, datetime, timedelta, timezone
from statistics import median
from urllib.parse import urlencode, urljoin
from zoneinfo import ZoneInfo
from calendar_provider import CalendarParser
from collect import ROOT, DATA, REGISTRY, WB_IDS, MARKET_IDS, collect, download
from policy_decisions import collect_policy_decisions
from policy_rates import collect_policy_rates

def configure_headless_log():
    """Give pythonw scheduled runs an audit trail without opening a console."""
    if sys.stdout is not None:
        return
    log_dir=ROOT/'.logs';log_dir.mkdir(exist_ok=True)
    stream=open(log_dir/'scheduler.log','a',encoding='utf-8',buffering=1)
    sys.stdout=stream;sys.stderr=stream
configure_headless_log()
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
def us_market_holidays(year):
    """Treasury observation dates: US federal holidays and Good Friday.

    Release times still come from the official calendar; this only estimates the
    previous observation date so a successful HTTP response cannot end retries.
    """
    def observed(day):
        return day-timedelta(days=1) if day.weekday()==5 else day+timedelta(days=1) if day.weekday()==6 else day
    def weekday(month,which,n):
        first=date(year,month,1)
        return first+timedelta(days=(which-first.weekday())%7+7*(n-1))
    holidays={observed(date(y,m,d)) for y in (year-1,year,year+1) for m,d in ((1,1),(6,19),(7,4),(11,11),(12,25))}
    holidays.update([weekday(1,0,3),weekday(2,0,3),weekday(9,0,1),weekday(10,0,2),weekday(11,3,4)])
    may_end=date(year,5,31);holidays.add(may_end-timedelta(days=may_end.weekday()))
    # Gregorian Easter, used only to exclude Good Friday's non-trading date.
    a=year%19;b=year//100;c=year%100;d=b//4;e=b%4;f=(b+8)//25;g=(b-f+1)//3
    h=(19*a+b-d-g+15)%30;i=c//4;k=c%4;l=(32+2*e+2*i-h-k)%7;m=(a+11*h+22*l)//451
    easter=date(year,(h+l-7*m+114)//31,(h+l-7*m+114)%31+1)
    holidays.add(easter-timedelta(days=2))
    return holidays

def previous_us_business_day(day):
    result=day-timedelta(days=1)
    while result.weekday()>=5 or result in us_market_holidays(result.year):result-=timedelta(days=1)
    return result

def expected_date(key,event):
    d=event.astimezone(CT).date()
    if key in ('UNRATE','PAYEMS','CPIAUCNS','CPILFENS','CPIAUCSL','CPILFESL','PCEPI','PCEPILFE'):
        return (d.replace(day=1)-timedelta(days=1)).replace(day=1).isoformat()
    if key in ('ICSA','NFCI'):
        target=5 if key=='ICSA' else 4
        return (d-timedelta(days=(d.weekday()-target)%7 or 7)).isoformat()
    if key in ('DGS10','DFII10'):
        # H.15 publishes the prior business day's observations, not an intraday
        # quote. https://www.federalreserve.gov/releases/h15/
        return previous_us_business_day(d).isoformat()
    return None

def cadence_metadata(now,previous,state,mode):
    target=max(1,int(os.environ.get('MACRO_CHECK_MINUTES','15')))
    elapsed=max(0,(now-datetime.fromisoformat(previous)).total_seconds()/60) if previous else None
    intervals=[float(value) for value in state.get('recentIntervalMinutes',[]) if isinstance(value,(float,int)) and value>0]
    if elapsed and elapsed>=1:intervals=(intervals+[round(elapsed,1)])[-8:]
    typical=median(intervals) if intervals else target
    next_estimate=now+timedelta(minutes=max(target,typical))
    state['recentIntervalMinutes']=intervals
    return {'targetIntervalMinutes':target,'previousRunAt':previous,'actualIntervalMinutes':round(elapsed,1) if elapsed is not None else None,
            'recentIntervalMinutes':intervals,'cadenceStatus':'unknown' if elapsed is None else 'delayed' if elapsed>target*2 else 'on_schedule',
            'estimatedNextCheckAt':next_estimate.isoformat(),'nextCheckAt':next_estimate.isoformat(),'nextCheckIsEstimate':True,
            'schedulingNote':'GitHub Actions 为尽力调度，目标间隔不保证实际执行时间；预计检查时间参考最近实际间隔。' if mode=='github_actions' else '预计检查时间参考最近实际间隔，实际运行以后台任务为准。'}

def failed_sources(series):
    # A source skipped by this pass can still be serving stale cached values.
    return [key for key,item in series.items() if item.get('status') in ('cached','fetch_failed')]

def release_plan(key,item,series,entry,state,now):
    """Return a calendar-aware fetch decision, including retries for stale HTTP 200s."""
    checked=datetime.fromisoformat(series.get('checkedAt') or '2000-01-01T00:00:00+00:00')
    last_date=next((p['date'] for p in reversed(series.get('observations',[])) if p['value'] is not None),'')
    times=sorted(datetime.fromisoformat(e['scheduledAt']) for e in entry.get('events',[]))
    past=[t for t in times if t<=now];future=[t for t in times if t>now]
    rid=str(entry.get('releaseId') or next(r for r,keys in RIDS.items() if key in keys))
    due=past[-1] if past else None
    state.setdefault('lastDue',{})
    if due:state['lastDue'][rid]=due.isoformat()
    elif state['lastDue'].get(rid):due=datetime.fromisoformat(state['lastDue'][rid])
    if not times:
        return now-checked>=timedelta(hours=24),{'state':'calendar_unavailable','nextCheckAt':max(now,checked+timedelta(hours=24)).isoformat()}
    expected=expected_date(key,due) if due else None
    not_yet=bool(due and expected and last_date<expected)
    attempt_key=key+'_'+(due.isoformat() if due else 'none');attempt=state.setdefault('attempts',{}).get(attempt_key,0)
    retry_after=min(120,15*2**min(attempt,3))
    # EIA spot prices can lag their release date. Retry an unchanged response
    # during a bounded 8-hour window without claiming an exact observation date.
    catchup=False
    if key=='DCOILBRENTEU' and due:
        windows=state.setdefault('releaseWindows',{});window=windows.get(key,{})
        if window.get('releaseAt')!=due.isoformat():
            window={'releaseAt':due.isoformat(),'initialObservationDate':last_date};windows[key]=window
        catchup=last_date<=window.get('initialObservationDate','') and now-due<timedelta(hours=8)
    needs=bool(due and (checked<due or ((not_yet or catchup) and now-checked>=timedelta(minutes=retry_after) and now-due<timedelta(hours=48))))
    if not_yet and now-due>=timedelta(hours=48) and now-checked>=timedelta(hours=24):needs=True
    if series.get('status') in ('cached','fetch_failed') and now-checked>=timedelta(minutes=retry_after):needs=True
    if item['frequency']=='daily' and now-checked>=timedelta(hours=24):needs=True
    if now-checked>=timedelta(days=7):needs=True
    if needs:state['attempts'][attempt_key]=attempt+1
    retry_at=(checked+timedelta(minutes=retry_after)).isoformat() if not_yet or catchup else None
    return needs,{'state':'delayed' if not_yet and now-due>timedelta(hours=48) else 'awaiting_source' if not_yet or catchup else 'waiting_release',
                 'expectedObservationDate':expected,'expectedDateBasis':'previous_us_business_day' if key in ('DGS10','DFII10') else 'release_period' if expected else 'source_dependent',
                 'nextReleaseAt':future[0].isoformat() if future else None,'lastScheduledReleaseAt':due.isoformat() if due else None,
                 'retryNotBeforeAt':retry_at,'calendarSource':entry.get('sourceUrl'),'calendarStatus':entry.get('status')}
def run(force=False):
    now=datetime.now(timezone.utc);lock=DATA/'schedule.lock'
    if lock.exists() and time.time()-lock.stat().st_mtime<1800:print('Another collector is running');return
    lock.write_text(str(os.getpid()))
    try:
        # Official decision feed is independent of the monthly BIS comparison
        # history and intentionally runs on every scheduler pass.
        try:
            collect_policy_decisions()
        except Exception as exc:
            print('POLICY_DECISIONS FAILED; will retain prior decision cache:', str(exc)[-160:], flush=True)
        # BIS policy rates are a supplementary series. A first-fetch outage must
        # not prevent the existing macro collection from running.
        try:
            collect_policy_rates()
        except Exception as exc:
            print('POLICY_RATES FAILED; will use packaged fallback:', str(exc)[-160:], flush=True)
        cal=calendar(now);path=DATA/'scheduler.json';state=json.loads(path.read_text()) if path.exists() else {'attempts':{}}
        cached=json.loads((DATA/'latest.json').read_text(encoding='utf-8'));selected=[];pending={}
        for item in REGISTRY:
            key=item['id'];s=cached['series'].get(key,{});last=s.get('observations',[]);last_date=next((p['date'] for p in reversed(last) if p['value'] is not None),'')
            checked=datetime.fromisoformat(s.get('checkedAt') or '2000-01-01T00:00:00+00:00')
            if force or not last:selected.append(key);continue
            # Market-reference quotes are checked on every 15-minute scheduler
            # pass. They remain separate from the official monthly price series.
            if key in MARKET_IDS:
                selected.append(key)
                pending[key]={'state':'market_sync','nextCheckAt':(now+timedelta(minutes=int(os.environ.get('MACRO_CHECK_MINUTES','15')))).isoformat(),'calendarSource':'daily_market_reference'};continue
            # World Bank commodity files and EIA-861M electricity data publish
            # outside the FRED release calendar, so they are checked daily.
            if key in (*WB_IDS,'EIA_US_COMMERCIAL','DFEDTARL','DFEDTARU'):
                if now-checked>=timedelta(hours=24):selected.append(key)
                pending[key]={'state':'waiting_release','nextCheckAt':(checked+timedelta(hours=24)).isoformat(),'calendarSource':'daily_file_check' if key in (*WB_IDS,'EIA_US_COMMERCIAL') else 'daily_effective_rate_check'};continue
            rid=next(r for r,keys in RIDS.items() if key in keys);entry=next((e for e in cal['fred'] if e['releaseId']==rid),{})
            needs,info=release_plan(key,item,s,entry,state,now)
            if needs:selected.append(key)
            pending[key]=info
        os.environ.setdefault('MACRO_SCHEDULER','scheduled')
        result=collect(selected=selected) if selected else cached
        for key,info in pending.items():
            s=result['series'][key];latest=next((p['date'] for p in reversed(s['observations']) if p['value'] is not None),'')
            if info.get('expectedObservationDate') and latest>=info['expectedObservationDate']:info['state']='waiting_release'
            s['publication']=info
        cadence=cadence_metadata(now,state.get('lastRunAt'),state,os.environ['MACRO_SCHEDULER'])
        result['scheduler']={**cadence,'mode':os.environ['MACRO_SCHEDULER'],'lastRunAt':now.isoformat(),'lastCompletedAt':datetime.now(timezone.utc).isoformat(),'lastFetchAt':result.get('generatedAt'),'calendarStatus':'ready' if all(e['status']=='ok' for e in cal['fred']) else 'partial_cache','checkedSeries':selected,'failed':failed_sources(result['series'])}
        atomic(DATA/'latest.json',result);state['lastRunAt']=now.isoformat();state['selected']=selected;atomic(path,state)
        print(json.dumps({'checkedAt':now.isoformat(),'selected':selected,'calendarStatus':result['scheduler']['calendarStatus']},ensure_ascii=False))
    finally:lock.unlink(missing_ok=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--force',action='store_true');p.add_argument('--skip-research',action='store_true');args=p.parse_args();run(args.force)
    from industry_schedule import run as run_industry
    run_industry(args.force,not args.skip_research)

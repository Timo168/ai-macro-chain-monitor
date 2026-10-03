"""Independent daily industry refresh; browser requests only read the snapshot."""
import json,subprocess,sys
from datetime import datetime,timezone,timedelta
from industry_common import DATA,ROOT,atomic,now
from industry_reviewed import materialize

# Task Scheduler runs this module while the user may be in a fullscreen game.
# CREATE_NO_WINDOW prevents child Python and Node processes from creating a
# transient console window on Windows, while leaving their exit codes intact.
CREATE_NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if sys.platform == 'win32' else 0
WINDOWS_STARTUPINFO = None
if sys.platform == 'win32':
    WINDOWS_STARTUPINFO = subprocess.STARTUPINFO()
    WINDOWS_STARTUPINFO.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    WINDOWS_STARTUPINFO.wShowWindow = subprocess.SW_HIDE

def run_background(command, **kwargs):
    return subprocess.run(
        command,
        creationflags=CREATE_NO_WINDOW,
        startupinfo=WINDOWS_STARTUPINFO,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        **kwargs,
    )
def bootstrap_extended(initial,target):
    definitions=[d for d in initial['definitions'] if d.get('sourceAdapter')=='extended' and initial['series'][d['id']]['observations']]
    extended=json.loads(target.read_text(encoding='utf-8')) if target.exists() else {'definitions':[],'series':{}}
    known={d['id'] for d in extended['definitions']}
    for definition in definitions:
        if definition['id'] not in known:
            restored={**initial['series'][definition['id']],'status':'cached','error':'从已核验发布快照恢复；等待本次官方来源检查'}
            extended['definitions'].append(definition);extended['series'][definition['id']]=restored
    atomic(target,extended)

# FRED/Census proxies have a small payload and are the earliest public signal
# in this layer.  Check them hourly and retry sooner after a failed source
# response.  All children still go through run_background(), so neither the
# scheduled refresh nor a retry creates a visible console window on Windows.
FAST_COLLECTORS=(
    {'key':'infrastructure','script':'industry_infrastructure.py','snapshot':'infrastructure.json','intervalMinutes':60},
)

def state_time(value):
    try:
        parsed=datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError,ValueError):
        return datetime(2000,1,1,tzinfo=timezone.utc)

def retry_minutes(failures):
    """Back off 15, 30, 60, then 120 minutes after an upstream failure."""
    return min(120,15*2**min(max(int(failures or 0)-1,0),3))

def source_snapshot_health(snapshot):
    """Treat cached and fetch_failed source states as retryable failures."""
    try:
        payload=json.loads((DATA/snapshot).read_text(encoding='utf-8'))
        series=payload.get('series',{})
        if not series:return False,['no_series']
        unhealthy=[metric_id for metric_id,item in series.items() if item.get('status')!='ready']
        return not unhealthy,unhealthy
    except Exception as error:
        return False,[f'snapshot: {error}']

def run_fast_collector(spec,state,current,force):
    records=state.setdefault('fastCollectors',{})
    previous=records.get(spec['key'],{})
    failures=previous.get('failureCount',0)
    last=state_time(previous.get('lastAttemptAt'))
    interval=retry_minutes(failures) if failures else spec['intervalMinutes']
    due=force or current-last>=timedelta(minutes=interval)
    if not due:
        return previous,previous.get('nextCheckAt')
    error=None
    try:
        result=run_background([sys.executable,str(ROOT/'scripts'/spec['script']),'--force'],cwd=ROOT,timeout=300)
        if result.returncode:
            error=f"{spec['script']} exited with {result.returncode}"
    except Exception as exc:
        error=f"{spec['script']}: {exc}"
    healthy,details=source_snapshot_health(spec['snapshot']) if not error else (False,[error])
    failure_count=0 if healthy else int(failures or 0)+1
    next_delay=spec['intervalMinutes'] if healthy else retry_minutes(failure_count)
    record={
        'lastAttemptAt':now(),
        'lastSuccessfulAt':now() if healthy else previous.get('lastSuccessfulAt'),
        'status':'ready' if healthy else 'partial_cache',
        'failureCount':failure_count,
        'failedSeries':[] if healthy else details,
        'nextCheckAt':(current+timedelta(minutes=next_delay)).isoformat(),
    }
    records[spec['key']]=record
    return record,record['nextCheckAt']

FINANCIAL_COLLECTORS={
 'MSFT':'industry_collect.py','GOOG':'industry_collect.py','AMZN':'industry_collect.py','META':'industry_collect.py','NVDA':'industry_collect.py',
 'DELL':'industry_hardware.py','AMD':'industry_hardware.py','ORCL':'industry_oracle.py','HPE':'industry_extended.py',
 'MU':'industry_sector_financials.py','ETN':'industry_sector_financials.py','VRT':'industry_sector_financials.py','TSM':'industry_sector_financials.py',
}

def release_key(release):
    return '|'.join(str(release.get(key,'')) for key in ('url','fiscalYear','quarter','publishedAt'))

def financial_release_checks(state,current,force=False,daily_scripts=()):
    """Discover hourly, retry confirmed but unparsed releases with backoff.

    A failed list request never becomes an unpublished financial report. This
    state only governs retries; build-industry verifies ingestion independently.
    """
    prior=state.setdefault('financialReleases',{})
    discovery_due=force or current-state_time(prior.get('lastAttemptAt'))>=timedelta(hours=1)
    failures=[]
    if discovery_due:
        try:
            result=run_background([sys.executable,str(ROOT/'scripts/industry_releases.py'),'--force'],cwd=ROOT,timeout=450)
            if result.returncode:failures.append('industry_releases.py')
        except Exception as error:failures.append('industry_releases.py: '+str(error))
        prior['lastAttemptAt']=now()
    path=DATA/'release-discovery.json'
    discovery=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'entities':{}}
    sources={}
    for name in set(FINANCIAL_COLLECTORS.values()):
        filename={'industry_collect.py':'companies.json','industry_hardware.py':'hardware.json','industry_oracle.py':'oracle.json','industry_extended.py':'extended.json','industry_sector_financials.py':'sector-financials.json'}[name]
        p=DATA/filename
        sources[name]=json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
    attempts=prior.setdefault('ingestionAttempts',{})
    scripts={}
    for entity,source in discovery.get('entities',{}).items():
        name=FINANCIAL_COLLECTORS.get(entity)
        releases=[r for r in source.get('releases',[]) if r.get('publishedAt') and r['publishedAt'][:10]<=current.date().isoformat()]
        if not name or not releases:continue
        latest=max(releases,key=lambda r:r['publishedAt'])
        key=release_key(latest)
        parsed=any(r.get('entity')==entity and release_key(r)==key for r in sources[name].get('ingestedReleases',[]))
        if parsed:
            attempts[entity]={'releaseKey':key,'lastAttemptAt':now(),'failureCount':0}
            continue
        last_attempt=attempts.get(entity,{})
        delay=retry_minutes(last_attempt.get('failureCount',0)) if last_attempt.get('releaseKey')==key else 0
        if force or last_attempt.get('releaseKey')!=key or current-state_time(last_attempt.get('lastAttemptAt'))>=timedelta(minutes=max(30,delay)):
            if name not in daily_scripts:scripts.setdefault(name,[]).append(entity)
            attempts[entity]={'releaseKey':key,'lastAttemptAt':now(),'failureCount':int(last_attempt.get('failureCount',0))+1 if last_attempt.get('releaseKey')==key else 1}
    for name in sorted(scripts):
        try:
            # Force bypasses source caches for a freshly discovered report.
            args=[sys.executable,str(ROOT/'scripts'/name),'--force']
            if name in ('industry_collect.py','industry_hardware.py'):
                for entity in scripts[name]:args.extend(['--entity',entity])
            result=run_background(args,cwd=ROOT,timeout=600)
            if result.returncode:failures.append(name)
        except Exception as error:failures.append(name+': '+str(error))
    prior['sourceFailures']=[entity for entity,source in discovery.get('entities',{}).items() if source.get('status') in ('cached','fetch_failed')]
    prior['nextCheckAt']=(current+timedelta(minutes=30)).isoformat()
    return failures

def refresh_research():
    for script in ['research_market.py','research_alfred.py']:
        try:
            supplement=run_background([sys.executable,str(ROOT/'scripts'/script)],cwd=ROOT,timeout=600)
            if supplement.returncode:print(script+' failed; retaining last successful reference data')
        except Exception as error:
            print(script+' unavailable; retaining last successful reference data: '+str(error)[:160])
    result=run_background(['node',str(ROOT/'scripts/build-investment-research.mjs')],cwd=ROOT)
    if result.returncode:raise RuntimeError('Investment research build failed; last successful snapshot retained')

def run(force=False,build_research=True):
    reviewed=DATA/'public-reviewed.json'
    if reviewed.exists():materialize()
    # Bootstrap normalized history so a first-run source outage cannot erase the reviewed seed.
    seed=DATA/'seed.json'
    if seed.exists():
        initial=json.loads(seed.read_text(encoding='utf-8'))
        for name,prefixes in [('companies',['MSFT.','GOOG.','META.','AMZN.','NVDA.']),('oracle',['ORCL.']),('hardware',['DELL.','AMD.','TSM.']),('costs',['WB.','EIA.']),('sia',['SIA.'])]:
            target=DATA/(name+'.json')
            if not target.exists():
                definitions=[d for d in initial['definitions'] if not d.get('sourceAdapter') and any(d['id'].startswith(p) for p in prefixes) and initial['series'][d['id']]['observations']]
                atomic(target,{'definitions':definitions,'series':{d['id']:initial['series'][d['id']] for d in definitions}})
        target=DATA/'extended.json'
        bootstrap_extended(initial,target)
        target=DATA/'power-load.json'
        if not target.exists():
            definitions=[d for d in initial['definitions'] if d.get('sourceAdapter')=='power-load' and initial['series'][d['id']]['observations']]
            if definitions:atomic(target,{'definitions':definitions,'series':{d['id']:initial['series'][d['id']] for d in definitions},'projects':[],'events':[]})
    path=DATA/'scheduler.json'
    state=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    current=datetime.now(timezone.utc)
    last=state_time(state.get('lastAttemptAt'))
    daily_due=force or current-last>=timedelta(hours=24) or state.get('collectorVersion')!=12
    # Discover actual official URLs before any adapter attempts a new quarter.
    release_failures=financial_release_checks(state,current,force or daily_due,set(FINANCIAL_COLLECTORS.values()) if daily_due else ())
    if daily_due:
        failures=[]
        for script in ['industry_collect.py','industry_hardware.py','industry_costs.py','industry_oracle.py','industry_sia.py','industry_extended.py','industry_power_load.py','industry_projects.py','industry_sector_financials.py','industry_institutions.py']:
            try:
                result=run_background([sys.executable,str(ROOT/'scripts'/script)],cwd=ROOT,timeout=600)
                if result.returncode:failures.append(script)
            except Exception as error:failures.append(script+': '+str(error))
        state.update({'collectorVersion':12,'lastAttemptAt':now(),'dailyFailures':failures})
    fast_next=[]
    fast_failures=[]
    for spec in FAST_COLLECTORS:
        record,next_check=run_fast_collector(spec,state,current,force)
        if next_check:fast_next.append(state_time(next_check))
        if record.get('status')!='ready':fast_failures.append(spec['script']+': '+', '.join(record.get('failedSeries',[])))
    daily_next=last+timedelta(hours=24) if not daily_due else current+timedelta(hours=24)
    state.update({
        'collectorVersion':12,
        'failures':(state.get('dailyFailures',[])+fast_failures+release_failures),
        'nextCheckAt':min([daily_next,*fast_next,state_time(state['financialReleases']['nextCheckAt'])]).isoformat(),
    })
    atomic(path,state)
    result=run_background(['node',str(ROOT/'scripts/build-industry.mjs')],cwd=ROOT)
    if result.returncode:raise RuntimeError('Industry build failed; last successful snapshot retained')
    if build_research:
        refresh_research()
if __name__=='__main__':run('--force' in sys.argv,'--skip-research' not in sys.argv)

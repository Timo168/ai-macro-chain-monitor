"""Independent daily industry refresh; browser requests only read the snapshot."""
import hashlib,json,subprocess,sys,time
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

PROJECT_CAPACITY_COLLECTOR_VERSION = 1

def refresh_project_capacity(state, current, daily_collected=False):
    """Install new project-source coverage immediately and retry source outages."""
    previous = state.get('projectCapacity', {})
    retry_due = previous.get('status') != 'ready' and current >= state_time(previous.get('nextCheckAt'))
    needs_version = previous.get('collectorVersion') != PROJECT_CAPACITY_COLLECTOR_VERSION
    if not daily_collected and not (needs_version or retry_due):
        return
    if not daily_collected and previous.get('status') == 'cached' and current < state_time(previous.get('nextCheckAt')):
        return
    error = None
    try:
        if not daily_collected:
            result = run_background([sys.executable, str(ROOT/'scripts'/'industry_projects.py')], cwd=ROOT, timeout=600)
            if result.returncode:
                raise RuntimeError('项目容量更新未成功')
        payload = json.loads((DATA/'projects.json').read_text(encoding='utf-8'))
        projects = payload.get('projects', [])
        if not projects or any(not project.get('capacityAudit') for project in projects):
            raise RuntimeError('项目容量核查记录尚未齐备')
        failed = [source['id'] for source in payload.get('sources', []) if source.get('status') in ('fetch_failed', 'cached')]
        if failed:
            raise RuntimeError('部分来源待重试：'+', '.join(failed))
    except Exception as exc:
        error = str(exc)
    failures = int(previous.get('failureCount', 0))+1 if error else 0
    state['projectCapacity'] = {
        'collectorVersion': PROJECT_CAPACITY_COLLECTOR_VERSION,
        'status': 'cached' if error else 'ready',
        'lastAttemptAt': current.isoformat(),
        'lastSuccessfulAt': previous.get('lastSuccessfulAt') if error else current.isoformat(),
        'nextCheckAt': (current+timedelta(minutes=retry_minutes(failures)) if error else current+timedelta(hours=24)).isoformat(),
        'failureCount': failures,
        'error': error,
    }

def state_time(value):
    try:
        parsed=datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError,ValueError):
        return datetime(2000,1,1,tzinfo=timezone.utc)

def retry_minutes(failures):
    """Back off 15, 30, 60, then 120 minutes after an upstream failure."""
    return min(120,15*2**min(max(int(failures or 0)-1,0),3))

def retry_monthly_revenue(state,current,daily_collected):
    # The daily sweep checks all sources. Retry only this cached series if
    # a closed reporting month is missing, with the same bounded backoff.
    if daily_collected:return
    previous=state.get('tsmMonthlyRetry',{})
    if current<state_time(previous.get('nextCheckAt')):return
    path=DATA/'hardware.json'
    if not path.exists():return
    series=json.loads(path.read_text(encoding='utf-8')).get('series',{}).get('TSM.revenue',{})
    if series.get('status')!='cached' or not series.get('observations'):
        state.pop('tsmMonthlyRetry',None);return
    from industry_tsm_monthly import last_closed_month
    target=last_closed_month(current.date()).isoformat()
    if any(p.get('periodEnd','')>=target and p.get('value') is not None for p in series['observations']):
        state.pop('tsmMonthlyRetry',None);return
    count=int(previous.get('failureCount',0))+1
    try:
        result=run_background([sys.executable,str(ROOT/'scripts'/'industry_hardware.py'),'--latest-tsm-only'],cwd=ROOT,timeout=90)
        series=json.loads(path.read_text(encoding='utf-8'))['series']['TSM.revenue']
        if result.returncode==0 and any(p['periodEnd']==target and p.get('value') is not None for p in series['observations']):
            state.pop('tsmMonthlyRetry',None);return
    except (OSError,ValueError,KeyError,subprocess.TimeoutExpired):
        pass
    state['tsmMonthlyRetry']={'periodEnd':target,'failureCount':count,'nextCheckAt':(current+timedelta(minutes=retry_minutes(count))).isoformat()}

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
 'ANET':'industry_supply_evidence.py','AMKR':'industry_packaging.py','ENTG':'industry_materials.py','FUJIMI':'industry_cross_company.py',
 'MSFT':'industry_collect.py','GOOG':'industry_collect.py','AMZN':'industry_collect.py','META':'industry_collect.py','NVDA':'industry_collect.py',
 'DELL':'industry_hardware.py','AMD':'industry_hardware.py','ORCL':'industry_oracle.py','HPE':'industry_extended.py',
 'MU':'industry_sector_financials.py','ETN':'industry_sector_financials.py','VRT':'industry_sector_financials.py','TSM':'industry_sector_financials.py',
}

# A targeted repair for the reviewed Amazon historical URL migration. It is
# independent of the daily sweep and latest-release ledger: both can be fresh
# while an older report is still missing. Values remain sourced observations;
# only real, finite quarters with provenance satisfy the repair.
AMAZON_HISTORY_PERIODS=('2024-03-31','2024-06-30','2024-09-30','2025-09-30')

def amazon_history_gaps():
    try:
        import math
        payload=json.loads((DATA/'companies.json').read_text(encoding='utf-8'))
        good={point.get('periodEnd') for point in payload.get('series',{}).get('AMZN.capex',{}).get('observations',[])
            if isinstance(point.get('value'),(int,float)) and not isinstance(point.get('value'),bool)
            and math.isfinite(point['value']) and point.get('sourceUrl') and point.get('version') and point.get('fetchedAt')}
    except (OSError,ValueError,TypeError):good=set()
    return [period for period in AMAZON_HISTORY_PERIODS if period not in good]

def repair_amazon_history(state,current,daily_collected=False):
    repairs=state.setdefault('historyRepairs',{})
    key='amazon-cash-purchases-2024-v1';prior=repairs.get(key,{})
    missing=amazon_history_gaps()
    if not missing:
        if prior.get('status')!='ready':repairs[key]={**prior,'status':'ready','missingPeriods':[],'lastSuccessfulAt':now(),'failureCount':0}
        return []
    if not daily_collected and current-state_time(prior.get('lastAttemptAt'))<timedelta(minutes=retry_minutes(prior.get('failureCount',0))):
        return ['AMZN 历史财报待补齐：'+', '.join(missing)]
    error=None
    if not daily_collected:
        try:
            result=run_background([sys.executable,str(ROOT/'scripts/industry_collect.py'),'--entity','AMZN'],cwd=ROOT,timeout=600)
            if result.returncode:error='历史采集进程失败'
        except Exception as exc:error=str(exc)
    missing=amazon_history_gaps();failed=bool(missing)
    count=int(prior.get('failureCount',0))+1 if failed else 0
    repairs[key]={'status':'partial_cache' if failed else 'ready','lastAttemptAt':now(),
        'lastSuccessfulAt':prior.get('lastSuccessfulAt') if failed else now(),'failureCount':count,
        'missingPeriods':missing,'error':error,'nextCheckAt':(current+timedelta(minutes=retry_minutes(count))).isoformat() if failed else None}
    return ['AMZN 历史财报待补齐：'+', '.join(missing)] if failed else []

def release_key(release):
    return '|'.join(str(release.get(key,'')) for key in ('url','fiscalYear','quarter','publishedAt'))

def has_ingested_release(record,release):
    """Exact issuer/quarter, verified URL alias and the stated publication day.

    Keep original timestamps in the ledger; an ISO dateline and its date-only
    representation are the same release, not grounds for repeat collection.
    """
    return (record.get('entity')==release.get('entity')
        and record.get('fiscalYear')==release.get('fiscalYear')
        and record.get('quarter')==release.get('quarter')
        and bool(record.get('publishedAt'))
        and str(record['publishedAt'])[:10]==str(release.get('publishedAt',''))[:10]
        and release.get('url') in [record.get('url'),*record.get('sourceAliases',[])])

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
        filename={'industry_packaging.py':'packaging-evidence.json','industry_materials.py':'materials-evidence.json','industry_cross_company.py':'cross-company-evidence.json','industry_supply_evidence.py':'supply-evidence.json','industry_collect.py':'companies.json','industry_hardware.py':'hardware.json','industry_oracle.py':'oracle.json','industry_extended.py':'extended.json','industry_sector_financials.py':'sector-financials.json'}[name]
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
        parsed=any(has_ingested_release(r,latest) for r in sources[name].get('ingestedReleases',[]))
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

DAILY_SCRIPTS=(
    'industry_collect.py','industry_hardware.py','industry_supply_evidence.py','industry_packaging.py',
    'industry_materials.py','industry_cross_company.py','industry_costs.py','industry_oracle.py',
    'industry_sia.py','industry_extended.py','industry_power_load.py','industry_projects.py',
    'industry_sector_financials.py','industry_institutions.py',
)

def daily_collector(script):
    try:
        result=run_background([sys.executable,str(ROOT/'scripts'/script)],cwd=ROOT,timeout=600)
        return script if result.returncode else None
    except Exception as error:
        return script+': '+str(error)

def local_daily_sweep(path,state,current,deadline):
    # A process exit is the checkpoint. A source can still report cached values.
    digest=hashlib.sha256(b'local-daily-v1:16')
    for name in ('industry_common.py','industry_releases.py',*DAILY_SCRIPTS):
        digest.update((ROOT/'scripts'/name).read_bytes())
    version=digest.hexdigest()
    steps=('discovery',*DAILY_SCRIPTS)
    record=state.get('localDailySweep')
    valid=(isinstance(record,dict) and record.get('version')==version
           and timedelta()<=current-state_time(record.get('startedAt'))<=timedelta(days=2)
           and isinstance(record.get('finished'),dict)
           and tuple(record['finished'])==steps[:len(record['finished'])]
           and all(key in steps and isinstance(val,list) and all(isinstance(e,str) for e in val)
                   for key,val in record['finished'].items()))
    if not valid:
        record=state['localDailySweep']={'version':version,'startedAt':current.isoformat(),'finished':{}}
        atomic(path,state)
    finished=record['finished']
    for step in steps:
        if step in finished:continue
        if time.monotonic()>=deadline:
            print(f'Industry daily sweep: {len(finished)}/{len(steps)} steps checked. Resume at {step}.',flush=True)
            return False
        if step=='discovery':
            errors=financial_release_checks(state,current,True,set(FINANCIAL_COLLECTORS.values()))
        else:
            error=daily_collector(step)
            errors=[error] if error else []
        finished[step]=errors
        atomic(path,state)
    return True

def run(force=False,build_research=True,local_deadline=None):
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
    daily_due=force or current-last>=timedelta(hours=24) or state.get('collectorVersion')!=16
    # Discover actual official URLs before any adapter attempts a new quarter.
    if daily_due and local_deadline is not None:
        if not local_daily_sweep(path,state,current,local_deadline):return
        finished=state['localDailySweep']['finished']
        release_failures=finished['discovery']
        failures=[error for key in DAILY_SCRIPTS for error in finished[key]]
    else:
        release_failures=financial_release_checks(state,current,force or daily_due,set(FINANCIAL_COLLECTORS.values()) if daily_due else ())
        if daily_due:failures=[error for script in DAILY_SCRIPTS if (error:=daily_collector(script))]
    if daily_due:
        state.update({'collectorVersion':16,'lastAttemptAt':now(),'dailyFailures':failures})
        state.pop('localDailySweep',None)
        if local_deadline is not None:
            # The costly daily sweep stays complete even if a later auxiliary task is interrupted.
            state['failures']=release_failures+failures
            atomic(path,state)
            if time.monotonic()>=local_deadline:
                print('Industry daily sweep finished; auxiliary checks will continue on the next run.',flush=True)
                return
    retry_monthly_revenue(state,current,daily_due)
    refresh_project_capacity(state,current,daily_collected=daily_due)
    history_failures=repair_amazon_history(state,current,daily_collected=daily_due)
    fast_next=[]
    fast_failures=[]
    for spec in FAST_COLLECTORS:
        record,next_check=run_fast_collector(spec,state,current,force)
        if next_check:fast_next.append(state_time(next_check))
        if record.get('status')!='ready':fast_failures.append(spec['script']+': '+', '.join(record.get('failedSeries',[])))
    daily_next=last+timedelta(hours=24) if not daily_due else current+timedelta(hours=24)
    history_next=[state_time(item['nextCheckAt']) for item in state.get('historyRepairs',{}).values() if item.get('status')!='ready' and item.get('nextCheckAt')]
    tsm_check=state_time(state.get('tsmMonthlyRetry',{}).get('nextCheckAt'))
    if tsm_check>current:history_next.append(tsm_check)
    state.update({
        'collectorVersion':16,
        'failures':(state.get('dailyFailures',[])+fast_failures+release_failures+history_failures),
        'nextCheckAt':min([daily_next,*fast_next,*history_next,state_time(state['financialReleases']['nextCheckAt'])]).isoformat(),
    })
    atomic(path,state)
    result=run_background(['node',str(ROOT/'scripts/build-industry.mjs')],cwd=ROOT)
    if result.returncode:raise RuntimeError('Industry build failed; last successful snapshot retained')
    if build_research:
        refresh_research()
if __name__=='__main__':run('--force' in sys.argv,'--skip-research' not in sys.argv)

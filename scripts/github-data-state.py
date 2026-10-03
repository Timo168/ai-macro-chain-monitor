"""Restore/persist durable collector state on a separate Git branch. No force pushes."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sqlite3, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1];WORK=ROOT/'.data-work';DATA=ROOT/'data'
FILES=['latest.json','calendar.json','scheduler.json','observations.sqlite','policy-rates.json','policy-decisions.json']
INDUSTRY_FILES=['latest.json','research.json','research-history.json','research-ledger.json','research-followup.json','research-market.json','research-alfred.json','companies.json','hardware.json','oracle.json','costs.json','infrastructure.json','sia.json','extended.json','power-load.json','projects.json','sector-financials.json','institutions.json','release-discovery.json','reviewed-cache.json','scheduler.json']

def industry_state(source,destination):
    if not source.exists():return
    destination.mkdir(parents=True,exist_ok=True)
    for name in INDUSTRY_FILES:
        if (source/name).exists():shutil.copy2(source/name,destination/name)
    for name in ['parsed','recommendations','research-inputs','research-market-versions','research-vintages']:
        if (source/name).exists():shutil.copytree(source/name,destination/name,dirs_exist_ok=True)
    if (source/'industry.sqlite').exists():
        connection=sqlite3.connect(source/'industry.sqlite');backup=sqlite3.connect(destination/'industry.sqlite')
        try:connection.backup(backup)
        finally:backup.close();connection.close()
    # Public state contains extracted facts, never full company report files.
HIDDEN={'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)} if os.name=='nt' else {}
def git(*args,cwd=ROOT,check=True):return subprocess.run(['git',*args],cwd=cwd,check=check,capture_output=True,text=True,**HIDDEN)

def sqlite_blob(ref,relative):
    result=subprocess.run(['git','show',f'{ref}:{relative}'],cwd=WORK,capture_output=True,**HIDDEN)
    return result.stdout if result.returncode==0 else None

def merge_observations(local,remote_blob):
    """Union append-only observation revisions after a concurrent data-branch update."""
    if not local.exists() or not remote_blob:return
    with tempfile.NamedTemporaryFile(suffix='.sqlite',delete=False) as handle:
        handle.write(remote_blob);remote=pathlib.Path(handle.name)
    connection=sqlite3.connect(local)
    try:
        connection.execute('ATTACH DATABASE ? AS remote_state',(str(remote),))
        local_columns=[row[1] for row in connection.execute('PRAGMA main.table_info(observations)')]
        remote_columns=[row[1] for row in connection.execute('PRAGMA remote_state.table_info(observations)')]
        if not local_columns or local_columns!=remote_columns:raise RuntimeError(f'Observation schema mismatch while merging {local.name}')
        columns=','.join('"'+column.replace('"','""')+'"' for column in local_columns)
        connection.execute(f'INSERT OR IGNORE INTO main.observations ({columns}) SELECT {columns} FROM remote_state.observations')
        connection.commit();connection.execute('DETACH DATABASE remote_state')
    finally:
        connection.close();remote.unlink(missing_ok=True)

def ordered_union(local,remote,key,date,immutable=False):
    records={}
    for record in [*local,*remote]:
        ident=key(record)
        if not ident:raise ValueError('Research archive lacks a stable identity')
        old=records.get(ident)
        if old and immutable and old!=record:raise ValueError('Conflicting immutable research record: '+ident)
        if not old or record.get(date,'')<old.get(date,''):records[ident]=record
    return sorted(records.values(),key=lambda record:(record.get(date,''),key(record)))

def merge_followup(local,remote):
    """Keep every cohort and first completed evaluation, including competing results."""
    merged=dict(max([local,remote],key=lambda state:state.get('asOf','')));cohorts={}
    for record in [*local.get('cohorts',[]),*remote.get('cohorts',[])]:
        previous=cohorts.get(record['id'])
        if not previous:cohorts[record['id']]=record;continue
        for field in ['symbols','benchmark','inputHash','costBpsPerSide']:
            if previous.get(field)!=record.get(field):raise ValueError('Conflicting fixed paper basket: '+record['id'])
        entries=[entry for entry in [previous.get('entry'),record.get('entry')] if entry]
        if len({entry['date'] for entry in entries})>1:raise ValueError('Conflicting fixed paper entry date: '+record['id'])
        result={**previous};windows=[];alternatives={}
        for item in [*previous.get('concurrentEvaluations',[]),*record.get('concurrentEvaluations',[])]:alternatives[hashlib.sha256(json.dumps(item,sort_keys=True).encode()).hexdigest()]=item
        for months in [1,3,6]:
            candidates=[window for cohort in [previous,record] for window in cohort.get('windows',[]) if window['months']==months]
            completed=[window for window in candidates if window.get('status')=='matured']
            if not candidates:continue
            winner=min(completed,key=lambda window:window.get('evaluatedAt','')) if completed else max(candidates,key=lambda window:window.get('evaluatedAt',''))
            windows.append(winner)
            for window in completed:
                if window!=winner:alternatives[hashlib.sha256(json.dumps(window,sort_keys=True).encode()).hexdigest()]=window
        result['windows']=windows
        if alternatives:result['concurrentEvaluations']=list(alternatives.values())
        if entries:result['entry']=min(entries,key=lambda entry:entry.get('lockedAt',''))
        progress=[state for state in [previous.get('progress'),record.get('progress')] if state]
        finished=[state for state in progress if state.get('status')=='completed']
        if progress:result['progress']=min(finished,key=lambda state:state.get('evaluatedAt','')) if finished else max(progress,key=lambda state:state.get('evaluatedAt',''))
        cohorts[record['id']]=result
    merged['cohorts']=sorted(cohorts.values(),key=lambda record:(record['recordedAt'],record['id']))
    # Aggregates must match the union, rather than either writer's partial view.
    merged['byHorizon']=[]
    for months in [1,3,6]:
        values=[window for cohort in merged['cohorts'] for window in cohort['windows'] if window['months']==months and window.get('status')=='matured']
        merged['byHorizon'].append({'months':months,'maturedCount':len(values),'meanNetReturn':round(sum(window['netReturn'] for window in values)/len(values),2) if values else None,'meanExcessReturn':round(sum(window['excessReturn'] for window in values)/len(values),2) if values else None})
    return merged

RESEARCH_ARCHIVES=['industry/research-ledger.json','industry/research-history.json','industry/research-followup.json','industry/research-alfred.json']
def merge_research_archive(local,local_blob,remote_blob):
    if not local_blob or not remote_blob:return
    ours=json.loads(local_blob);theirs=json.loads(remote_blob)
    if local.name=='research-ledger.json':
        result=ordered_union(ours,theirs,lambda record:record.get('recordId') or record.get('id','')+':'+record.get('recordedAt',''),'recordedAt',True)
    elif local.name=='research-history.json':result=ordered_union(ours,theirs,lambda record:record.get('inputHash'),'generatedAt')
    elif local.name=='research-followup.json':result=merge_followup(ours,theirs)
    else:
        result=dict(max([ours,theirs],key=lambda state:state.get('checkedAt','')))
        result['vintages']={**theirs.get('vintages',{}),**ours.get('vintages',{})}
    local.parent.mkdir(parents=True,exist_ok=True);local.write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')

def merge_research_input(local,local_blob,remote_blob):
    if not local_blob or not remote_blob or local_blob==remote_blob:return
    ours=json.loads(local_blob);theirs=json.loads(remote_blob)
    if ours.get('inputHash')!=local.stem or theirs.get('inputHash')!=local.stem:raise ValueError('Research input filename and identity differ')
    winner,other=sorted([ours,theirs],key=lambda record:record['createdAt'])
    local.write_text(json.dumps(winner,ensure_ascii=False),encoding='utf-8')
    # Preserve the concurrent capture too: even equivalent prompts can have
    # different full input provenance. Never silently replace that evidence.
    alternative=json.dumps(other,ensure_ascii=False,sort_keys=True).encode('utf-8')
    digest=hashlib.sha256(alternative).hexdigest()
    local.with_name(local.stem+'.concurrent-'+digest+'.json').write_bytes(alternative)

def push_with_retry():
    first=git('push','origin','HEAD:refs/heads/data-cache',cwd=WORK,check=False)
    if first.returncode==0:return
    print(first.stderr.strip() or 'Concurrent data-cache update detected; merging and retrying')
    git('fetch','origin','data-cache',cwd=WORK)
    remote_dbs={relative:sqlite_blob('FETCH_HEAD',relative) for relative in ['observations.sqlite','industry/industry.sqlite']}
    archives={relative:(sqlite_blob('HEAD',relative),sqlite_blob('FETCH_HEAD',relative)) for relative in RESEARCH_ARCHIVES}
    changed_inputs=git('diff','--name-only','HEAD','FETCH_HEAD','--','industry/research-inputs',cwd=WORK).stdout.splitlines()
    inputs={relative:(sqlite_blob('HEAD',relative),sqlite_blob('FETCH_HEAD',relative)) for relative in changed_inputs if pathlib.Path(relative).suffix=='.json' and '.concurrent-' not in relative}
    merge=git('merge','--no-edit','--allow-unrelated-histories','-X','ours','FETCH_HEAD',cwd=WORK,check=False)
    if merge.returncode:raise RuntimeError('Could not merge concurrent data-cache update: '+(merge.stderr or merge.stdout))
    for relative,blob in remote_dbs.items():merge_observations(WORK/relative,blob)
    for relative,(ours,theirs) in archives.items():merge_research_archive(WORK/relative,ours,theirs)
    for relative,(ours,theirs) in inputs.items():merge_research_input(WORK/relative,ours,theirs)
    git('add','observations.sqlite','industry/industry.sqlite',cwd=WORK)
    for relative in archives:
        if (WORK/relative).exists():git('add','-f',relative,cwd=WORK)
    if (WORK/'industry/research-inputs').exists():git('add','-f','industry/research-inputs',cwd=WORK)
    if git('diff','--cached','--quiet',cwd=WORK,check=False).returncode:
        git('commit','--amend','--no-edit',cwd=WORK)
    second=git('push','origin','HEAD:refs/heads/data-cache',cwd=WORK,check=False)
    if second.returncode:raise RuntimeError('Could not persist data-cache after one merge retry: '+(second.stderr or second.stdout))
def restore():
    exists=git('ls-remote','--exit-code','--heads','origin','data-cache',check=False)
    if exists.returncode==0:
        git('fetch','origin','data-cache');git('worktree','add','--detach',str(WORK),'FETCH_HEAD')
        DATA.mkdir(exist_ok=True)
        for name in FILES:
            if (WORK/name).exists():shutil.copy2(WORK/name,DATA/name)
        if (WORK/'versions').exists():shutil.copytree(WORK/'versions',DATA/'versions',dirs_exist_ok=True)
        industry_state(WORK/'industry',DATA/'industry')
        print('Restored database, source archives and scheduling state from data-cache')
    elif exists.returncode==2:
        git('worktree','add','--detach',str(WORK),'HEAD');git('switch','--orphan','data-cache',cwd=WORK)
        print('Initialized independent data-cache branch')
    else:raise RuntimeError('Could not inspect remote data branch; refusing to overwrite state')
def save():
    if not WORK.exists():raise RuntimeError('Restore must run before save')
    if (DATA/'observations.sqlite').exists():
        connection=sqlite3.connect(DATA/'observations.sqlite');backup=sqlite3.connect(WORK/'observations.sqlite');connection.backup(backup);backup.close();connection.close()
    for name in FILES:
        if name!='observations.sqlite' and (DATA/name).exists():shutil.copy2(DATA/name,WORK/name)
    if (DATA/'versions').exists():shutil.copytree(DATA/'versions',WORK/'versions',dirs_exist_ok=True)
    industry_state(DATA/'industry',WORK/'industry')
    (WORK/'README.md').write_text('# Macro data state\n\nPublic-source observations, collector state, SQLite revision history and original source files. All timestamps and source attributions are stored in latest.json. This is a data branch, not the website source.\n',encoding='utf-8')
    git('config','user.name','github-actions[bot]',cwd=WORK);git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com',cwd=WORK)
    git('add','.',cwd=WORK)
    # These new audit artifacts are intentionally ignored in the source branch,
    # but are durable public-data state on data-cache and must be versioned there.
    for relative in ['industry/research.json','industry/research-history.json','industry/research-inputs','industry/research-ledger.json','industry/research-followup.json','industry/research-market.json','industry/research-market-versions','industry/research-alfred.json','industry/research-vintages']:
        if (WORK/relative).exists():git('add','-f',relative,cwd=WORK)
    changed=git('diff','--cached','--quiet',cwd=WORK,check=False).returncode
    if changed:
        git('commit','-m','Update macro observations and preserve revisions',cwd=WORK)
        push_with_retry()
        print('Persisted collector state without a force push')
    else:print('No data-state change')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['restore','save']);args=parser.parse_args();restore() if args.mode=='restore' else save()

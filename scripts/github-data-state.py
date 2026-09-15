"""Restore/persist durable collector state on a separate Git branch. No force pushes."""
import argparse, pathlib, shutil, subprocess, sqlite3, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1];WORK=ROOT/'.data-work';DATA=ROOT/'data'
FILES=['latest.json','calendar.json','scheduler.json','observations.sqlite','policy-rates.json']
INDUSTRY_FILES=['latest.json','companies.json','hardware.json','oracle.json','costs.json','sia.json','extended.json','power-load.json','reviewed-cache.json','scheduler.json']

def industry_state(source,destination):
    if not source.exists():return
    destination.mkdir(parents=True,exist_ok=True)
    for name in INDUSTRY_FILES:
        if (source/name).exists():shutil.copy2(source/name,destination/name)
    for name in ['parsed','recommendations']:
        if (source/name).exists():shutil.copytree(source/name,destination/name,dirs_exist_ok=True)
    if (source/'industry.sqlite').exists():
        connection=sqlite3.connect(source/'industry.sqlite');backup=sqlite3.connect(destination/'industry.sqlite')
        try:connection.backup(backup)
        finally:backup.close();connection.close()
    # Public state contains extracted facts, never full company report files.
def git(*args,cwd=ROOT,check=True):return subprocess.run(['git',*args],cwd=cwd,check=check,capture_output=True,text=True)

def sqlite_blob(ref,relative):
    result=subprocess.run(['git','show',f'{ref}:{relative}'],cwd=WORK,capture_output=True)
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

def push_with_retry():
    first=git('push','origin','HEAD:refs/heads/data-cache',cwd=WORK,check=False)
    if first.returncode==0:return
    print(first.stderr.strip() or 'Concurrent data-cache update detected; merging and retrying')
    git('fetch','origin','data-cache',cwd=WORK)
    remote_dbs={relative:sqlite_blob('FETCH_HEAD',relative) for relative in ['observations.sqlite','industry/industry.sqlite']}
    merge=git('merge','--no-edit','--allow-unrelated-histories','-X','ours','FETCH_HEAD',cwd=WORK,check=False)
    if merge.returncode:raise RuntimeError('Could not merge concurrent data-cache update: '+(merge.stderr or merge.stdout))
    for relative,blob in remote_dbs.items():merge_observations(WORK/relative,blob)
    git('add','observations.sqlite','industry/industry.sqlite',cwd=WORK)
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
    changed=git('diff','--cached','--quiet',cwd=WORK,check=False).returncode
    if changed:
        git('commit','-m','Update macro observations and preserve revisions',cwd=WORK)
        push_with_retry()
        print('Persisted collector state without a force push')
    else:print('No data-state change')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['restore','save']);args=parser.parse_args();restore() if args.mode=='restore' else save()

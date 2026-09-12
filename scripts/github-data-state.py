"""Restore/persist durable collector state on a separate Git branch. No force pushes."""
import argparse, pathlib, shutil, subprocess, sqlite3
ROOT=pathlib.Path(__file__).resolve().parents[1];WORK=ROOT/'.data-work';DATA=ROOT/'data'
FILES=['latest.json','calendar.json','scheduler.json','observations.sqlite']
def git(*args,cwd=ROOT,check=True):return subprocess.run(['git',*args],cwd=cwd,check=check,capture_output=True,text=True)
def restore():
    exists=git('ls-remote','--exit-code','--heads','origin','data-cache',check=False)
    if exists.returncode==0:
        git('fetch','origin','data-cache');git('worktree','add','--detach',str(WORK),'FETCH_HEAD')
        DATA.mkdir(exist_ok=True)
        for name in FILES:
            if (WORK/name).exists():shutil.copy2(WORK/name,DATA/name)
        if (WORK/'versions').exists():shutil.copytree(WORK/'versions',DATA/'versions',dirs_exist_ok=True)
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
    (WORK/'README.md').write_text('# Macro data state\n\nPublic-source observations, collector state, SQLite revision history and original source files. All timestamps and source attributions are stored in latest.json. This is a data branch, not the website source.\n',encoding='utf-8')
    git('config','user.name','github-actions[bot]',cwd=WORK);git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com',cwd=WORK)
    git('add','.',cwd=WORK)
    changed=git('diff','--cached','--quiet',cwd=WORK,check=False).returncode
    if changed:
        git('commit','-m','Update macro observations and preserve revisions',cwd=WORK)
        git('push','origin','HEAD:refs/heads/data-cache',cwd=WORK)
        print('Persisted collector state without a force push')
    else:print('No data-state change')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['restore','save']);args=parser.parse_args();restore() if args.mode=='restore' else save()

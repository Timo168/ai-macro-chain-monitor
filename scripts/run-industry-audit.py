"""Persist an honest audit outcome even when source replay fails or times out.

Only metadata, error summaries and source references are public. Console output
is written to the workflow artifact, not published as a source document archive.
"""
import json, os, pathlib, subprocess, sys
from datetime import datetime, timezone

ROOT=pathlib.Path(__file__).resolve().parents[1]
DATA=ROOT/'data'/'industry'
CHECKS=[('industry_source_replay','audit_industry.py')]
HIDDEN={'creationflags':getattr(subprocess,'CREATE_NO_WINDOW',0)} if os.name=='nt' else {}

def atomic(path,payload):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix('.tmp.json')
    temporary.write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    os.replace(temporary,path)

def timestamp():return datetime.now(timezone.utc).isoformat()

def run_checks(data=DATA,root=ROOT,runner=subprocess.run):
    path=data/'audit-status.json';prior={}
    try:prior=json.loads(path.read_text(encoding='utf-8'))
    except (FileNotFoundError,ValueError):pass
    started=timestamp();checks=[]
    run_id=os.environ.get('GITHUB_RUN_ID');repository=os.environ.get('GITHUB_REPOSITORY')
    result={'schemaVersion':1,'status':'running','startedAt':started,'completedAt':None,
            'lastSuccessAt':prior.get('lastSuccessAt'),'runUrl':f'https://github.com/{repository}/actions/runs/{run_id}' if repository and run_id else None,
            'checkedSnapshotAt':None,'checks':checks,
            'scope':'行业公开来源抽查和计算重放；不验证投资收益，也不代表所有历史点都逐点通过。'}
    atomic(path,result)
    logs=root/'.logs'/'industry-audit';logs.mkdir(parents=True,exist_ok=True)
    try:
        snapshot=json.loads((data/'latest.json').read_text(encoding='utf-8'))
        if not snapshot.get('definitions') or not snapshot.get('series'):raise ValueError('Restored industry snapshot is empty')
        result['checkedSnapshotAt']=snapshot.get('generatedAt')
        checks.append({'id':'restored_data','status':'passed'})
    except Exception as exc:
        checks.append({'id':'restored_data','status':'failed','error':f'{type(exc).__name__}: {exc}'[:600]})
    else:
        for ident,script in CHECKS:
            entry={'id':ident,'startedAt':timestamp()}
            try:
                with (logs/(ident+'.log')).open('w',encoding='utf-8') as log:
                    process=runner([sys.executable,str(root/'scripts'/script)],cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,timeout=900,check=False,**HIDDEN)
                entry.update(status='passed' if process.returncode==0 else 'failed',exitCode=process.returncode)
                if process.returncode:entry['error']='来源或计算重放未通过；失败明细见检查报告和运行日志。'
            except subprocess.TimeoutExpired:
                entry.update(status='failed',error='来源重放超过 15 分钟，未完成检查；上次成功记录仍保留。')
            except Exception as exc:
                entry.update(status='failed',error=f'{type(exc).__name__}: {exc}'[:600])
            entry['completedAt']=timestamp();checks.append(entry)
    result['completedAt']=timestamp()
    result['status']='passed' if checks and all(c['status']=='passed' for c in checks) else 'failed'
    report_path=root/'docs'/'industry'/'verification.json'
    if any(c['id']=='industry_source_replay' for c in checks) and report_path.exists():
        try:
            report=json.loads(report_path.read_text(encoding='utf-8'))
            if report.get('checkedAt','')>=started:
                result['sampleCounts']={name:report.get(name,0) for name in ['automaticSamples','currentSourceReplaySamples','previousSourceReplaySamples','manualFactLedgerSamples','failedSamples']}
                result['failures']=report.get('failures',[])[:25]
        except (OSError,ValueError) as exc:
            result['status']='failed';checks.append({'id':'audit_report','status':'failed','error':f'{type(exc).__name__}: {exc}'[:600]})
    if result['status']=='passed':result['lastSuccessAt']=result['completedAt']
    else:result['error']='本次检查未全部通过，详见逐项结果；这不代表所有数据均不可用。'
    atomic(path,result)
    print(json.dumps(result,ensure_ascii=False))
    return 0 if result['status']=='passed' else 1

if __name__=='__main__':sys.exit(run_checks())

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
def run(force=False):
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
    last=datetime.fromisoformat(state.get('lastAttemptAt','2000-01-01T00:00:00+00:00'))
    if force or current-last>=timedelta(hours=24) or state.get('collectorVersion')!=7:
        failures=[]
        for script in ['industry_collect.py','industry_hardware.py','industry_costs.py','industry_oracle.py','industry_sia.py','industry_extended.py','industry_power_load.py','industry_projects.py']:
            try:
                result=run_background([sys.executable,str(ROOT/'scripts'/script)],cwd=ROOT,timeout=600)
                if result.returncode:failures.append(script)
            except Exception as error:failures.append(script+': '+str(error))
        atomic(path,{'collectorVersion':7,'lastAttemptAt':now(),'failures':failures,'nextCheckAt':(current+timedelta(hours=24)).isoformat()})
    result=run_background(['node',str(ROOT/'scripts/build-industry.mjs')],cwd=ROOT)
    if result.returncode:raise RuntimeError('Industry build failed; last successful snapshot retained')
if __name__=='__main__':run('--force' in sys.argv)

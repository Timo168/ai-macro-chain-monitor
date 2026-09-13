"""Independent daily industry refresh; browser requests only read the snapshot."""
import json,subprocess,sys
from datetime import datetime,timezone,timedelta
from industry_common import DATA,ROOT,atomic,now
from industry_reviewed import materialize
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
        if not target.exists():
            definitions=[d for d in initial['definitions'] if d.get('sourceAdapter')=='extended' and initial['series'][d['id']]['observations']]
            atomic(target,{'definitions':definitions,'series':{d['id']:initial['series'][d['id']] for d in definitions}})
        target=DATA/'power-load.json'
        if not target.exists():
            definitions=[d for d in initial['definitions'] if d.get('sourceAdapter')=='power-load' and initial['series'][d['id']]['observations']]
            if definitions:atomic(target,{'definitions':definitions,'series':{d['id']:initial['series'][d['id']] for d in definitions},'projects':[],'events':[]})
    path=DATA/'scheduler.json'
    state=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    current=datetime.now(timezone.utc)
    last=datetime.fromisoformat(state.get('lastAttemptAt','2000-01-01T00:00:00+00:00'))
    if force or current-last>=timedelta(hours=24) or state.get('collectorVersion')!=3:
        failures=[]
        for script in ['industry_collect.py','industry_hardware.py','industry_costs.py','industry_oracle.py','industry_sia.py','industry_extended.py','industry_power_load.py']:
            try:
                result=subprocess.run([sys.executable,str(ROOT/'scripts'/script)],cwd=ROOT,timeout=600)
                if result.returncode:failures.append(script)
            except Exception as error:failures.append(script+': '+str(error))
        atomic(path,{'collectorVersion':3,'lastAttemptAt':now(),'failures':failures,'nextCheckAt':(current+timedelta(hours=24)).isoformat()})
    result=subprocess.run(['node',str(ROOT/'scripts/build-industry.mjs')],cwd=ROOT)
    if result.returncode:raise RuntimeError('Industry build failed; last successful snapshot retained')
if __name__=='__main__':run('--force' in sys.argv)

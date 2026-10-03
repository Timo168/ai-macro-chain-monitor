"""Optional true ALFRED vintages. Never reconstruct signals from current revisions."""
import hashlib, json, os
from datetime import datetime, timezone, timedelta
import requests
from industry_common import DATA, atomic, now

IDS=['ICSA','NFCI','DFII10','DGS10','PCEPI','PCEPILFE']
def run():
    path=DATA/'research-alfred.json';stamp=now();key=os.environ.get('FRED_API_KEY','').strip()
    old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if not key:
        result={**old,'status':'cached' if old.get('vintages') else 'not_configured','checkedAt':stamp,'note':'尚未配置FRED API密钥；使用网站实际留存快照作前瞻跟踪，不声称已完成ALFRED历史回测。'}
        atomic(path,result);return result
    ledger_path=DATA/'research-ledger.json';ledger=json.loads(ledger_path.read_text(encoding='utf-8')) if ledger_path.exists() else []
    # The prior calendar day is conservative: no same-day release can leak into
    # a snapshot archived before that release. No secret URL is archived.
    dates=sorted({(datetime.fromisoformat(record['recordedAt'].replace('Z','+00:00')).date()-timedelta(days=1)).isoformat() for record in ledger if record.get('recordedAt')}|{(datetime.now(timezone.utc).date()-timedelta(days=1)).isoformat()})
    vintages=old.get('vintages',{});errors=[];session=requests.Session();session.trust_env=False
    folder=DATA/'research-vintages';folder.mkdir(parents=True,exist_ok=True)
    for date in dates:
        for series in IDS:
            ident=f'{series}:{date}'
            if ident in vintages:continue
            try:
                response=session.get('https://api.stlouisfed.org/fred/series/observations',params={'api_key':key,'file_type':'json','series_id':series,'realtime_start':date,'realtime_end':date,'observation_start':(datetime.fromisoformat(date)-timedelta(days=800)).date().isoformat()},timeout=15)
                if response.status_code!=200:raise ValueError(f'HTTP {response.status_code}')
                payload=response.json();points=payload.get('observations')
                if payload.get('realtime_start')!=date or payload.get('realtime_end')!=date:raise ValueError('历史版本区间与请求不一致')
                if not isinstance(points,list) or not points or any(point.get('date','9999')>date for point in points):raise ValueError('无有效或越过截止日的观测')
                digest=hashlib.sha256(response.content).hexdigest();atomic(folder/f'{series}-{date}.json',payload)
                vintages[ident]={'seriesId':series,'asOfDate':date,'fetchedAt':stamp,'version':digest,'count':len(points),'sourceUrl':'https://fred.stlouisfed.org/docs/api/fred/realtime_period.html'}
            except Exception as error:errors.append({'seriesId':series,'asOfDate':date,'reason':str(error).replace(key,'[redacted]')[:180]})
    result={'status':'ready' if not errors else 'cached' if vintages else 'fetch_failed','checkedAt':stamp,'vintages':vintages,'errors':errors,'note':'保存记录日前一天的官方可得版本；仅为后续历史验证备料，未以当前数据倒推旧研究结论。'}
    atomic(path,result);print(f'ALFRED: {result["status"]}, {len(vintages)} actual vintages.');return result
if __name__=='__main__':run()

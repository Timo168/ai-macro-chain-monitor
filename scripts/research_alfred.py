"""Official ALFRED vintages via API or public download; no reconstructed signals."""
import csv, hashlib, io, json, math, os, re
from zipfile import ZipFile
from datetime import datetime, timezone, timedelta
import requests
from industry_common import DATA, atomic, now

IDS=['ICSA','NFCI','DFII10','DGS10','PCEPI','PCEPILFE']
PUBLIC_URL='https://alfred.stlouisfed.org/series/downloaddata?seid='

def validate(payload,date):
    points=payload.get('observations')
    if payload.get('realtime_start')!=date or payload.get('realtime_end')!=date:raise ValueError('历史版本区间与请求不一致')
    if not isinstance(points,list) or not points:raise ValueError('没有历史观测')
    seen=set();valid=0
    for point in points:
        observation=point.get('date','');datetime.strptime(observation,'%Y-%m-%d')
        if observation>date or observation in seen:raise ValueError('观测越过截止日或日期重复')
        seen.add(observation);value=point.get('value')
        if value not in (None,'','.','NA'):
            if isinstance(value,bool) or not math.isfinite(float(value)):raise ValueError('历史观测数值无效')
            valid+=1
    if valid<3:raise ValueError('历史版本少于三个有效观测')
    return payload

def parse_download(raw,series,date):
    """Require both official README and exact vintage column, never accept latest CSV."""
    with ZipFile(io.BytesIO(raw)) as archive:
        if sum(item.file_size for item in archive.infolist())>10_000_000:raise ValueError('历史下载超过允许大小')
        readme=archive.read('README.txt').decode('utf-8-sig',errors='replace')
        if not re.search(r'^Series ID:\s*'+re.escape(series)+r'\s*$',readme,re.M) or 'Output Format: Observations by Vintage Date, All Observations' not in readme:raise ValueError('官方历史下载的指标或格式不匹配')
        files=[name for name in archive.namelist() if name.endswith('.csv')]
        if len(files)!=1:raise ValueError('历史下载不是单一序列文件')
        rows=list(csv.reader(io.StringIO(archive.read(files[0]).decode('utf-8-sig'))))
        expected=[ 'observation_date',series+'_'+date.replace('-','') ]
        if not rows or rows[0]!=expected:raise ValueError('历史下载未返回所请求的版本列')
        if any(len(row)!=2 for row in rows[1:]):raise ValueError('历史下载的观测列数异常')
        payload={'series_id':series,'realtime_start':date,'realtime_end':date,'observations':[{'date':row[0],'value':None if row[1] in ('','.','NA') else row[1]} for row in rows[1:]],'metadata':readme,'adapter':'alfred_public_download'}
        return validate(payload,date)

def fetch_public(session,series,date):
    bounds=getattr(session,'alfred_bounds',{})
    if series not in bounds:
        page=session.get(PUBLIC_URL+series,timeout=20)
        if page.status_code!=200:raise ValueError(f'历史下载说明HTTP {page.status_code}')
        limits=[]
        for key in ['start','end']:
            match=re.search(r'<input[^>]*\bid="form_obs_'+key+r'_date"[^>]*\bvalue="(\d{4}-\d{2}-\d{2})"',page.text)
            if not match:raise ValueError('官方页面没有可验证的观测范围')
            datetime.strptime(match[1],'%Y-%m-%d');limits.append(match[1])
        bounds[series]=limits;session.alfred_bounds=bounds
    start=(datetime.fromisoformat(date)-timedelta(days=800)).date().isoformat()
    start=max(start,bounds[series][0]);end=min(date,bounds[series][1])
    if start>end:raise ValueError('指定历史日期之前没有可下载观测')
    response=session.post(PUBLIC_URL+series,data={'form[units]':'lin','form[obs_start_date]':start,'form[obs_end_date]':end,'form[entered_vintage_dates]':date,'form[file_type]':'2','form[file_format]':'csv','form[download_data]':''},timeout=20)
    if response.status_code!=200:raise ValueError(f'公开下载HTTP {response.status_code}')
    if not response.content.startswith(b'PK'):raise ValueError('官方公开下载未返回历史数据压缩包')
    return parse_download(response.content,series,date),response.content

def run():
    path=DATA/'research-alfred.json';stamp=now();key=os.environ.get('FRED_API_KEY','').strip()
    old=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
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
                if key:
                    response=session.get('https://api.stlouisfed.org/fred/series/observations',params={'api_key':key,'file_type':'json','series_id':series,'realtime_start':date,'realtime_end':date,'observation_start':(datetime.fromisoformat(date)-timedelta(days=800)).date().isoformat()},timeout=15)
                    if response.status_code!=200:raise ValueError(f'HTTP {response.status_code}')
                    payload=validate(response.json(),date);raw=response.content;adapter='fred_api';source='https://fred.stlouisfed.org/docs/api/fred/realtime_period.html'
                else:
                    payload,raw=fetch_public(session,series,date);adapter='alfred_public_download';source=PUBLIC_URL+series
                    (folder/f'{series}-{date}.zip').write_bytes(raw)
                digest=hashlib.sha256(raw).hexdigest();atomic(folder/f'{series}-{date}.json',payload)
                vintages[ident]={'seriesId':series,'asOfDate':date,'fetchedAt':stamp,'version':digest,'count':len(payload['observations']),'sourceUrl':source,'adapter':adapter}
            except Exception as error:
                reason=str(error).replace(key,'[redacted]') if key else str(error)
                errors.append({'seriesId':series,'asOfDate':date,'reason':reason[:180]})
    result={'status':'ready' if not errors else 'cached' if vintages else 'fetch_failed','checkedAt':stamp,'vintages':vintages,'errors':errors,'note':'通过官方API或公开下载保存记录日前一天的可得版本，无密钥时使用公开下载；仅为后续历史验证备料，未以当前数据倒推旧研究结论。'}
    atomic(path,result);print(f'ALFRED: {result["status"]}, {len(vintages)} actual vintages.');return result
if __name__=='__main__':run()

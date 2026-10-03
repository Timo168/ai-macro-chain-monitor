import json, pathlib, sys, tempfile, unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import research_market as adapter
import research_alfred as alfred

def prices(symbol='MSFT',currency='USD'):
    stamps=[int((datetime(2026,9,1,18,tzinfo=timezone.utc)+timedelta(days=i)).timestamp()) for i in range(31)]
    return {'chart':{'result':[{'meta':{'symbol':symbol,'currency':currency,'exchangeTimezoneName':'America/New_York','currentTradingPeriod':{'regular':{'end':int(datetime(2026,9,30,20,tzinfo=timezone.utc).timestamp())}}},'timestamp':stamps,'indicators':{'quote':[{'close':[100]*31}],'adjclose':[{'adjclose':[99]*31}]},'events':{}}]}}

def vendor(symbol='MSFT',currency='USD'):
    groups=[]
    for key,tag in adapter.TYPES.items():
        groups.append({'meta':{'symbol':[symbol],'type':[tag]},tag:[{'asOfDate':'2026-06-30','periodType':'TTM' if tag.startswith('trailing') else '3M','currencyCode':currency,'reportedValue':{'raw':-50 if key=='capex' else 100}}]})
    return {'timeseries':{'result':groups}}

def sec():
    ends=[('2025-07-01','2025-09-30','2025-11-01'),('2025-10-01','2025-12-31','2026-02-01'),('2026-01-01','2026-03-31','2026-05-01'),('2026-04-01','2026-06-30','2026-08-01')]
    facts=[{'start':start,'end':end,'filed':filed,'val':100,'accn':str(i),'form':'10-Q','fy':2026,'fp':'Q2'} for i,(start,end,filed) in enumerate(ends)]
    balance={'end':'2026-06-30','filed':'2026-08-01','val':20,'form':'10-Q'}
    return {'cik':789019,'facts':{'us-gaap':{'Revenues':{'units':{'USD':facts}},'CashAndCashEquivalentsAtCarryingValue':{'units':{'USD':[balance]}},'LongTermDebtCurrent':{'units':{'USD':[balance]}},'LongTermDebtNoncurrent':{'units':{'USD':[balance]}}}}}

class MarketTests(unittest.TestCase):
    def test_complete_session_only_and_original_and_adjusted_prices(self):
        raw=json.dumps(prices()).encode()
        before=adapter.parse_prices(raw,'MSFT',datetime(2026,9,30,19,tzinfo=timezone.utc))
        after=adapter.parse_prices(raw,'MSFT',datetime(2026,9,30,20,16,tzinfo=timezone.utc))
        self.assertEqual(before['observations'][-1]['date'],'2026-09-29')
        self.assertEqual(after['observations'][-1]['date'],'2026-09-30')
        self.assertEqual(after['observations'][-1]['close'],100)
        self.assertEqual(after['observations'][-1]['adjustedClose'],99)
    def test_wrong_symbol_currency_and_missing_adjusted_prices_fail(self):
        for payload in [prices('GOOG'),prices(currency='TWD')]:
            with self.assertRaises(ValueError):adapter.parse_prices(json.dumps(payload).encode(),'MSFT')
        payload=prices();del payload['chart']['result'][0]['indicators']['adjclose']
        with self.assertRaises(ValueError):adapter.parse_prices(json.dumps(payload).encode(),'MSFT')
    def test_null_zero_bool_prices_are_missing_not_zero(self):
        payload=prices();close=payload['chart']['result'][0]['indicators']['quote'][0]['close'];close[:3]=[None,0,True]
        parsed=adapter.parse_prices(json.dumps(payload).encode(),'MSFT',datetime(2026,10,2,tzinfo=timezone.utc))
        self.assertEqual(len(parsed['observations']),28);self.assertTrue(all(p['close']>0 for p in parsed['observations']))
    def test_vendor_requires_ttm_or_balance_metadata_and_marks_unknown_publication(self):
        raw=vendor();fields=adapter.parse_vendor_facts(json.dumps(raw).encode(),'MSFT','2026-10-03')
        self.assertEqual(fields['capex']['value'],50);self.assertIsNone(fields['revenue']['publishedAt']);self.assertEqual(fields['revenue']['basis'],'third_party_transcription')
        raw['timeseries']['result'][0][adapter.TYPES['revenue']][0]['periodType']='3M'
        self.assertNotIn('revenue',adapter.parse_vendor_facts(json.dumps(raw).encode(),'MSFT','2026-10-03'))
    def test_vendor_does_not_convert_currency_or_use_future_facts(self):
        raw=vendor(currency='TWD');fields=adapter.parse_vendor_facts(json.dumps(raw).encode(),'MSFT','2026-10-03');self.assertEqual(fields['revenue']['currency'],'TWD')
        for group in raw['timeseries']['result']:
            tag=group['meta']['type'][0];group[tag][0]['asOfDate']='2026-12-31'
        with self.assertRaises(ValueError):adapter.parse_vendor_facts(json.dumps(raw).encode(),'MSFT','2026-10-03')
    def test_sec_continuous_ttm_cik_and_balance_scope(self):
        raw=sec();fields=adapter.parse_sec_facts(json.dumps(raw).encode(),'MSFT','2026-10-03')
        self.assertEqual(fields['revenue']['value'],400);self.assertEqual(fields['cash']['scope'],'cash_only');self.assertEqual(fields['longTermDebt']['value'],40);self.assertNotIn('debt',fields)
        raw['cik']=999
        with self.assertRaises(ValueError):adapter.parse_sec_facts(json.dumps(raw).encode(),'MSFT','2026-10-03')
    def test_failed_fetch_retains_last_successful_values_and_times(self):
        previous={'observations':[{'date':'2026-10-02','close':100}],'fetchedAt':'original','lastSuccessfulAt':'original'}
        cached=adapter.retained(previous,'timeout','now');self.assertEqual(cached['status'],'cached');self.assertEqual(cached['lastSuccessfulAt'],'original');self.assertEqual(cached['checkedAt'],'now')
        self.assertEqual(adapter.retained({},'timeout','now')['status'],'fetch_failed')
    def test_official_outage_and_newer_vendor_fields_are_explicit_and_durable(self):
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);path=root/'market.json'
            with patch.object(adapter,'DATA',root),patch.object(adapter,'fetch_source',side_effect=RuntimeError('official unavailable')),patch.object(adapter,'download_market',side_effect=[json.dumps(prices()).encode(),json.dumps(vendor()).encode()]):
                result=adapter.run(True,path,['MSFT'])
            self.assertEqual(result['finance']['MSFT']['status'],'ready');self.assertIn('official unavailable',result['finance']['MSFT']['officialSourceError']);self.assertFalse(result['exportAllowed'])
            self.assertEqual(len(list((root/'research-market-versions'/'MSFT').glob('*.json'))),2)
            with patch.object(adapter,'DATA',root),patch.object(adapter,'fetch_source',side_effect=RuntimeError('offline')),patch.object(adapter,'download_market',side_effect=RuntimeError('offline')):
                cached=adapter.run(True,path,['MSFT'])
            self.assertEqual(cached['prices']['MSFT']['status'],'cached');self.assertEqual(cached['prices']['MSFT']['lastSuccessfulAt'],result['prices']['MSFT']['lastSuccessfulAt'])

class AlfredTests(unittest.TestCase):
    def test_missing_key_never_fabricates_vintages_and_retains_cache(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(alfred,'DATA',pathlib.Path(temp)),patch.dict('os.environ',{'FRED_API_KEY':''}):
            self.assertEqual(alfred.run()['status'],'not_configured')
            (pathlib.Path(temp)/'research-alfred.json').write_text(json.dumps({'vintages':{'ICSA:2026-10-01':{'count':10}}}))
            cached=alfred.run();self.assertEqual(cached['status'],'cached');self.assertEqual(cached['vintages']['ICSA:2026-10-01']['count'],10)
    def test_real_vintage_match_future_guard_and_no_secret_in_archives(self):
        class Session:
            trust_env=True
            def get(self,url,params,timeout):
                date=params['realtime_start'];payload={'realtime_start':date,'realtime_end':date,'observations':[{'date':date,'value':'.'}]}
                class Response:
                    status_code=200
                    content=json.dumps(payload).encode()
                    def json(self):return payload
                return Response()
        with tempfile.TemporaryDirectory() as temp,patch.object(alfred,'DATA',pathlib.Path(temp)),patch.object(alfred,'IDS',['ICSA']),patch.dict('os.environ',{'FRED_API_KEY':'secret-for-test'}),patch.object(alfred.requests,'Session',Session):
            ready=alfred.run();self.assertEqual(ready['status'],'ready');self.assertEqual(len(ready['vintages']),1)
            self.assertNotIn('secret-for-test',(pathlib.Path(temp)/'research-alfred.json').read_text(encoding='utf-8'))
            vintage=next((pathlib.Path(temp)/'research-vintages').glob('*.json'));self.assertNotIn('secret-for-test',vintage.read_text(encoding='utf-8'))
    def test_wrong_vintage_and_future_observations_fail_without_archive(self):
        for invalid in ['wrong_vintage','future_observation']:
            class Session:
                trust_env=True
                def get(self,url,params,timeout):
                    date=params['realtime_start'];payload={'realtime_start':'1990-01-01' if invalid=='wrong_vintage' else date,'realtime_end':date,'observations':[{'date':'2999-01-01' if invalid=='future_observation' else date,'value':'1'}]}
                    class Response:
                        status_code=200
                        content=json.dumps(payload).encode()
                        def json(self):return payload
                    return Response()
            with tempfile.TemporaryDirectory() as temp,patch.object(alfred,'DATA',pathlib.Path(temp)),patch.object(alfred,'IDS',['ICSA']),patch.dict('os.environ',{'FRED_API_KEY':'secret-for-test'}),patch.object(alfred.requests,'Session',Session):
                failed=alfred.run();self.assertEqual(failed['status'],'fetch_failed');self.assertEqual(failed['vintages'],{})

if __name__=='__main__':unittest.main()

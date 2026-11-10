import unittest, sys, json, sqlite3, tempfile, pathlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import collect
from schedule import expected_date
from datetime import datetime,timezone
from types import SimpleNamespace
class CollectorTests(unittest.TestCase):
    def test_official_http2_handshake_failure_retries_http1_without_visible_window(self):
        failed=SimpleNamespace(returncode=16,stderr=b'HTTP/2 SETTINGS frame',stdout=b'')
        success=SimpleNamespace(returncode=0,stderr=b'',stdout=b'official response')
        with patch.object(collect.subprocess,'run',side_effect=[failed,success]) as run:
            self.assertEqual(collect.download('https://www.rbi.org.in/Scripts/Annualpolicy.aspx'),b'official response')
        self.assertIn('--http1.1',run.call_args_list[1].args[0])
        self.assertEqual(run.call_args_list[1].kwargs['creationflags'],collect.CREATE_NO_WINDOW)
    def test_daily_precious_metal_market_references_are_configured(self):
        self.assertEqual(collect.MARKET_QUOTES['MKT_GOLD'][0],'GC=F')
        self.assertEqual(collect.MARKET_QUOTES['MKT_SILVER'][0],'SI=F')
        self.assertTrue(set(['MKT_GOLD','MKT_SILVER']).issubset(collect.MARKET_IDS))
    def test_market_chart_uses_trading_dates_and_keeps_missing_close(self):
        timestamps=[1799712000+86400*i for i in range(13)]
        raw=json.dumps({'chart':{'result':[{'timestamp':timestamps,'indicators':{'quote':[{'close':[6.7]+[None]+[6.8]*11}]}}],'error':None}}).encode()
        points=collect.parse_market_chart(raw)
        self.assertEqual(len(points),13);self.assertEqual(points[0]['value'],6.7);self.assertIsNone(points[1]['value'])
    def market_payload(self):
        stamps=[datetime(2026,10,28,tzinfo=timezone.utc).timestamp()+86400*i for i in range(13)]
        return {'chart':{'result':[{'meta':{'symbol':'GC=F','currency':'USD','dataGranularity':'1d','exchangeTimezoneName':'America/New_York'},'timestamp':stamps,'indicators':{'quote':[{'close':[4000+i for i in range(13)]}]}}],'error':None}}
    def test_market_dates_use_exchange_zone_across_dst(self):
        payload=self.market_payload();result=payload['chart']['result'][0]
        points=collect.parse_market_chart(json.dumps(payload),expected_symbol='GC=F')
        self.assertEqual(points[0]['date'],'2026-10-27');self.assertEqual(points[-1]['date'],'2026-11-08')
        # Both sides of the November daylight-saving transition use local date.
        self.assertEqual(points[3]['date'],'2026-10-30');self.assertEqual(points[6]['date'],'2026-11-02')
    def test_live_duplicate_date_keeps_newest_value_and_null_does_not_erase(self):
        payload=self.market_payload();result=payload['chart']['result'][0]
        result['timestamp'] += [result['timestamp'][-1]+60,result['timestamp'][-1]+120]
        result['indicators']['quote'][0]['close'] += [4042,None]
        points=collect.parse_market_chart(json.dumps(payload),expected_symbol='GC=F')
        self.assertEqual(len(points),13);self.assertEqual(points[-1]['value'],4042)
    def test_unfinished_daily_bar_is_distinct_from_a_final_close(self):
        payload=self.market_payload();result=payload['chart']['result'][0]
        start=datetime(2026,11,8,5,tzinfo=timezone.utc).timestamp();end=start+86400
        result['meta'].update(regularMarketTime=end-7200,currentTradingPeriod={'regular':{'start':start,'end':end}})
        points,market=collect.parse_market_payload(json.dumps(payload),'GC=F',datetime(2026,11,9,4,tzinfo=timezone.utc))
        self.assertEqual(market['latestObservationKind'],'session_in_progress')
        self.assertEqual(market['quoteTimestampStatus'],'available')
        self.assertEqual(market['latestObservationDate'],points[-1]['date'])
    def test_old_quote_metadata_does_not_replace_daily_history(self):
        payload=self.market_payload();payload['chart']['result'][0]['meta'].update(regularMarketTime=1628647552,regularMarketPrice=999)
        points,market=collect.parse_market_payload(json.dumps(payload),'GC=F',datetime(2026,11,10,tzinfo=timezone.utc))
        self.assertEqual(points[-1]['value'],4012);self.assertEqual(market['quoteTimestampStatus'],'stale');self.assertIsNone(market['quoteAsOf'])
    def test_market_wrong_symbol_frequency_currency_or_invalid_price_is_rejected(self):
        for field,value in [('symbol','SI=F'),('currency','CNY'),('dataGranularity','1mo')]:
            payload=self.market_payload();payload['chart']['result'][0]['meta'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):collect.parse_market_chart(json.dumps(payload),expected_symbol='GC=F')
        for value in [float('nan'),float('inf'),True,-1,'4012']:
            payload=self.market_payload();payload['chart']['result'][0]['indicators']['quote'][0]['close'][-1]=value
            with self.subTest(value=value),self.assertRaises(ValueError):collect.parse_market_chart(json.dumps(payload),expected_symbol='GC=F')
    def test_market_future_date_and_all_missing_prices_are_rejected(self):
        payload=self.market_payload()
        with self.assertRaisesRegex(ValueError,'Future market observation'):collect.parse_market_chart(json.dumps(payload),'GC=F',datetime(2026,11,1,tzinfo=timezone.utc))
        payload['chart']['result'][0]['indicators']['quote'][0]['close']=[None]*13
        with self.assertRaisesRegex(ValueError,'no valid price'):collect.parse_market_chart(json.dumps(payload),'GC=F')
    def test_market_failure_preserves_metadata_and_last_valid_data(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(collect,'DATA',pathlib.Path(directory)),patch.object(collect,'REGISTRY',[{'id':'MKT_GOLD','release':collect.MARKET_QUOTES['MKT_GOLD'][1]}]):
            raw=json.dumps(self.market_payload()).encode();points,market=collect.parse_market_payload(raw,'GC=F')
            c=collect.connect();collect.save(c,'MKT_GOLD',points,raw,'source','2026-11-10T00:00:00+00:00',market);c.close()
            with patch.object(collect,'download_market',side_effect=RuntimeError('HTTP 429')):result=collect.collect()
            series=result['series']['MKT_GOLD']
            self.assertEqual(series['status'],'cached');self.assertEqual(series['market'],market);self.assertEqual(series['observations'],points)
            self.assertEqual(series['fetchedAt'],'2026-11-10T00:00:00+00:00')
    def test_world_bank_three_points_each(self):
        payload=json.loads((collect.DATA/'latest.json').read_text(encoding='utf-8'))
        for key in collect.WB_IDS:
            s=payload['series'][key];archive=next((collect.DATA/'versions'/key).glob(s['revision'].split('_')[-1]+'*.xlsx'))
            points=collect.parse_wb(archive.read_bytes())[key]
            for i in [0,len(points)//2,len(points)-1]:self.assertEqual(points[i],s['observations'][i])
    def test_revision_and_failure_preserve_prior_success(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(collect,'DATA',pathlib.Path(directory)),patch.object(collect,'REGISTRY',[{'id':'UNRATE','release':'https://fred.stlouisfed.org/series/UNRATE'}]):
            c=collect.connect();p=[{'date':'2026-01-01','value':4.1}]
            collect.save(c,'UNRATE',p,b'DATE,UNRATE\n2026-01-01,4.1','url','2026-02-01T12:30:00+00:00')
            collect.save(c,'UNRATE',[{'date':'2026-01-01','value':4.2}],b'DATE,UNRATE\n2026-01-01,4.2','url','2026-03-01T12:30:00+00:00')
            self.assertEqual(c.execute('select count(*) from observations').fetchone()[0],2)
            c.close()
            with patch.object(collect,'download',side_effect=RuntimeError('Source unavailable')):result=collect.collect()
            s=result['series']['UNRATE'];self.assertEqual(s['status'],'cached');self.assertEqual(s['observations'][0]['value'],4.2);self.assertEqual(s['fetchedAt'],'2026-03-01T12:30:00+00:00')
    def test_schedule_calendar_month_and_week(self):
        t=datetime.fromisoformat('2026-09-11T12:30:00+00:00')
        self.assertEqual(expected_date('CPIAUCNS',t),'2026-08-01')
        self.assertEqual(expected_date('ICSA',datetime.fromisoformat('2026-09-10T12:30:00+00:00')),'2026-09-05')
        self.assertEqual(expected_date('NFCI',datetime.fromisoformat('2026-09-09T12:30:00+00:00')),'2026-09-04')
if __name__=='__main__':unittest.main()

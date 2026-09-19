import unittest, sys, json, sqlite3, tempfile, pathlib
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import collect
from schedule import expected_date
from datetime import datetime
class CollectorTests(unittest.TestCase):
    def test_market_chart_uses_trading_dates_and_keeps_missing_close(self):
        timestamps=[1799712000+86400*i for i in range(13)]
        raw=json.dumps({'chart':{'result':[{'timestamp':timestamps,'indicators':{'quote':[{'close':[6.7]+[None]+[6.8]*11}]}}],'error':None}}).encode()
        points=collect.parse_market_chart(raw)
        self.assertEqual(len(points),13);self.assertEqual(points[0]['value'],6.7);self.assertIsNone(points[1]['value'])
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

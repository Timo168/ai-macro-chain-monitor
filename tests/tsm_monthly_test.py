"""TWSE fallback serves only the missing, issuer-matched closed month."""
import json
import pathlib
import sys
import tempfile
import unittest
from datetime import date,datetime,timedelta,timezone
from types import SimpleNamespace
from unittest.mock import Mock,patch

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_schedule as schedule
import industry_tsm_monthly as tsm
from audit_industry import tsm_revenue

PAGE='''<h1>上市公司115年10月份(累計與當月)營業收入統計表</h1><p>單位：千元</p><table>
<tr><th>公司代號</th><th>公司名稱</th><th>當月營收</th><th>上月營收</th></tr>
<tr><td>2331</td><td>其他</td><td>1</td><td>2</td></tr>
<tr><td>2330</td><td>台積電</td><td>586,890,319</td><td>511,857,399</td></tr></table>'''
TODAY=date(2026,11,14)
END=date(2026,10,31)
DEF={'id':'TSM.revenue','currency':'TWD','unit':'亿新台币'}


class MonthlyRevenue(unittest.TestCase):
    def snapshot(self):
        return {'series':{'TSM.revenue':{'status':'cached','observations':[{'periodEnd':'2026-09-30','sourceUrl':'issuer','value':5118.57}]}}}

    def test_adds_only_new_month_and_audits_original_thousands(self):
        data=self.snapshot();source=Mock(return_value=(PAGE.encode('cp950'),'2026-11-14T03:00:00+00:00','report-hash'))
        self.assertTrue(tsm.fill_latest(data,TODAY,source))
        source.assert_called_once_with('https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_115_10_0.html')
        series=data['series'][DEF['id']];prior,point=series['observations']
        self.assertEqual(prior,{'periodEnd':'2026-09-30','sourceUrl':'issuer','value':5118.57})
        self.assertEqual((point['value'],point['periodEnd'],point['publishedAt'],point['originalValue']),(5868.9,'2026-10-31',None,586890319))
        self.assertEqual(series['status'],'ready')
        with patch('audit_industry.versioned_bytes',return_value=PAGE.encode('cp950')):
            self.assertIn('2330',tsm_revenue(DEF,point))
            with self.assertRaises(AssertionError):
                tsm_revenue(DEF,{**point,'originalValue':586890})
        point['sourceUrl']='issuer'
        self.assertFalse(tsm.fill_latest(data,TODAY,source));self.assertEqual(source.call_count,1)

    def test_rejects_wrong_month_unit_company_and_duplicate_row(self):
        for before,after in [('10月份','9月份'),('千元','百萬元'),('台積電','其他'),('2331','2330'),('當月營收','營業收入')]:
            with self.subTest(after=after),self.assertRaises(ValueError):
                tsm.current_revenue(PAGE.replace(before,after).encode('cp950'),END)

    def test_due_retry_is_targeted_and_backs_off(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(schedule,'DATA',pathlib.Path(folder)),patch.object(schedule,'run_background',return_value=SimpleNamespace(returncode=0)) as runner:
            (pathlib.Path(folder)/'hardware.json').write_text(json.dumps(self.snapshot()))
            current=datetime(2026,11,14,tzinfo=timezone.utc);state={}
            schedule.retry_monthly_revenue(state,current,True);runner.assert_not_called()
            schedule.retry_monthly_revenue(state,current,False)
            self.assertEqual(runner.call_args.args[0][-1],'--latest-tsm-only')
            schedule.retry_monthly_revenue(state,current+timedelta(minutes=3),False)
            self.assertEqual(runner.call_count,1)
            self.assertEqual(state['tsmMonthlyRetry']['nextCheckAt'],(current+timedelta(minutes=15)).isoformat())

if __name__=='__main__':unittest.main()

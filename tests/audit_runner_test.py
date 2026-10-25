"""Audit startup, failure and historical-success states must remain distinguishable."""
import contextlib,hashlib,importlib.util,io,json,pathlib,subprocess,sys,tempfile,unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('audit_runner',ROOT/'scripts'/'run-industry-audit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
import audit_industry
from audit_operating_samples import source_bytes as operating_source
from audit_research_sources import verify_financial

class AuditRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.data=self.root/'data'/'industry';self.data.mkdir(parents=True)
        self.prior='2026-10-20T01:00:00+00:00'
        (self.data/'audit-status.json').write_text(json.dumps({'status':'passed','lastSuccessAt':self.prior}),encoding='utf-8')
    def tearDown(self):self.temp.cleanup()
    def snapshot(self):
        (self.data/'latest.json').write_text(json.dumps({'generatedAt':'2026-10-24T01:00:00+00:00','definitions':[{'id':'A'}],'series':{'A':{}}}),encoding='utf-8')
    def run_audit(self,runner):
        with contextlib.redirect_stdout(io.StringIO()):code=audit.run_checks(self.data,self.root,runner)
        return code,json.loads((self.data/'audit-status.json').read_text(encoding='utf-8'))
    def test_missing_restored_data_is_failed_not_a_pass(self):
        runner=Mock();code,status=self.run_audit(runner)
        self.assertEqual(code,1);self.assertEqual(status['status'],'failed');runner.assert_not_called()
        self.assertEqual(status['lastSuccessAt'],self.prior);self.assertEqual(status['checks'][0]['id'],'restored_data')
    def test_success_preserves_scope_and_advances_success_time(self):
        self.snapshot();runner=Mock(return_value=SimpleNamespace(returncode=0));code,status=self.run_audit(runner)
        self.assertEqual(code,0);self.assertEqual(status['status'],'passed');self.assertEqual(status['lastSuccessAt'],status['completedAt'])
        self.assertEqual(status['checkedSnapshotAt'],'2026-10-24T01:00:00+00:00')
        self.assertFalse(runner.call_args.kwargs.get('shell',False));self.assertEqual(runner.call_args.kwargs['stdin'],subprocess.DEVNULL)
        if sys.platform=='win32':self.assertTrue(runner.call_args.kwargs['creationflags'] & subprocess.CREATE_NO_WINDOW)
    def test_nonzero_and_timeout_preserve_previous_success(self):
        self.snapshot()
        for runner in [Mock(return_value=SimpleNamespace(returncode=1)),Mock(side_effect=subprocess.TimeoutExpired('audit',900))]:
            code,status=self.run_audit(runner)
            self.assertEqual(code,1);self.assertEqual(status['status'],'failed');self.assertEqual(status['lastSuccessAt'],self.prior)
            self.assertIsNotNone(status['completedAt']);self.assertTrue(status['checks'][-1]['error'])
    def test_replay_continues_after_bad_point_without_claiming_success(self):
        points=[{'periodEnd':f'2026-0{i}-01','value':i,'sourceUrl':'https://example.com','version':'v1'} for i in (1,2,3)]
        payload={'definitions':[{'id':'A','unit':'%'}],'series':{'A':{'status':'ready','observations':points}}}
        (self.data/'latest.json').write_text(json.dumps(payload),encoding='utf-8')
        with patch.object(audit_industry,'DATA',self.data),patch.object(audit_industry,'ROOT',self.root),patch.object(audit_industry,'check',side_effect=[AssertionError('wrong source value'),'matched','matched']) as checks,contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            passed=audit_industry.run()
        report=json.loads((self.root/'docs'/'industry'/'verification.json').read_text(encoding='utf-8'))
        self.assertFalse(passed);self.assertFalse(report['passed']);self.assertEqual(checks.call_count,3)
        self.assertEqual(report['failedSamples'],1);self.assertEqual(len(report['samples']),2)
        self.assertIn('wrong source value',report['failures'][0]['error'])
    def test_cached_observation_with_changed_value_cannot_reuse_old_audit(self):
        folder=self.root/'docs'/'industry';folder.mkdir(parents=True)
        points=[{'periodEnd':f'2026-0{i}-01','value':i,'sourceUrl':'https://example.com','version':'v1'} for i in (1,2,3)]
        (folder/'verification.json').write_text(json.dumps({'samples':[{'metricId':'A',**p,'value':100,'checkMode':'automatic_source_replay'} for p in points]}),encoding='utf-8')
        (self.data/'latest.json').write_text(json.dumps({'definitions':[{'id':'A','unit':'%'}],'series':{'A':{'status':'cached','error':'timeout','observations':points}}}),encoding='utf-8')
        with patch.object(audit_industry,'DATA',self.data),patch.object(audit_industry,'ROOT',self.root),patch.object(audit_industry,'check',return_value='matched') as checks,contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(audit_industry.run())
        self.assertEqual(checks.call_count,3)
    def test_durable_source_replays_survive_fresh_checkout_and_later_failed_audit(self):
        points=[{'periodEnd':f'2026-0{i}-01','value':i,'sourceUrl':'https://example.com','version':'v1'} for i in (1,2,3)]
        (self.data/'audit-samples.json').write_text(json.dumps({'samples':[{'metricId':'A',**p,'checkMode':'automatic_source_replay'} for p in points]}),encoding='utf-8')
        payload={'definitions':[{'id':'A','unit':'%'}],'series':{'A':{'status':'cached','error':'timeout','observations':points}}}
        (self.data/'latest.json').write_text(json.dumps(payload),encoding='utf-8')
        with patch.object(audit_industry,'DATA',self.data),patch.object(audit_industry,'ROOT',self.root),patch.object(audit_industry,'check',side_effect=AssertionError('new source failure')) as checks,contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(audit_industry.run());checks.assert_not_called()
            points[0]['version']='v2'
            (self.data/'latest.json').write_text(json.dumps(payload),encoding='utf-8')
            self.assertFalse(audit_industry.run());self.assertEqual(checks.call_count,1)
        archive=json.loads((self.data/'audit-samples.json').read_text(encoding='utf-8'))
        self.assertEqual(len(archive['samples']),3)
        self.assertEqual(archive['samples'][0]['version'],'v1')
    def test_injected_official_source_still_checks_saved_byte_hash(self):
        raw=b'<html><body>Official source</body></html>'
        soup,digest=operating_source('https://example.com',hashlib.sha256(raw).hexdigest(),lambda url:raw)
        self.assertEqual(soup.get_text(),'Official source')
        with self.assertRaisesRegex(AssertionError,'source version'):
            operating_source('https://example.com','wrong-hash',lambda url:raw)
    def test_electricity_replay_cache_keeps_values_from_four_field_source_rows(self):
        audit_industry.electricity_prices.cache_clear()
        rows={'TX.commercial':[('2026-06-30',9.1,{'sales':1000},'state'),('2026-07-31',9.3,{'sales':1100},'state')]}
        with patch.object(audit_industry,'source_bytes',return_value=(b'workbook','hash')),patch.object(audit_industry,'parse_eia',return_value=rows) as parser:
            self.assertEqual(audit_industry.electricity_prices('https://example.com/workbook')['TX.commercial']['2026-07-31'],9.3)
            self.assertEqual(audit_industry.electricity_prices('https://example.com/workbook')['TX.commercial']['2026-06-30'],9.1)
            parser.assert_called_once()
        audit_industry.electricity_prices.cache_clear()
    def test_amkor_cumulative_cash_flow_uses_both_dated_reports(self):
        def raw(months,amount):return f'<html><table><caption>In thousands {months} Months Ended 2025</caption><tr><td>Payments for property, plant and equipment</td><td>({amount})</td></tr></table></html>'.encode()
        sources={'https://example.com/q2':raw('Six',250),'https://example.com/q1':raw('Three',100)}
        point={'periodEnd':'2025-06-30','fiscalPeriod':'FY2025 Q2','sourceUrl':'https://example.com/q2','value':.0015,'originalItems':{'baseUrl':'https://example.com/q1','baseVersion':hashlib.sha256(sources['https://example.com/q1']).hexdigest(),'baseYtdThousandUsd':100}}
        with patch.object(audit_industry,'source_bytes',side_effect=lambda url:(sources[url],hashlib.sha256(sources[url]).hexdigest())) as loader:
            method=audit_industry.check({'id':'AMKR.capex','family':'capex','sourceAdapter':'packaging-operating'},point,{})
        self.assertIn('independent operating-source',method);self.assertEqual(loader.call_count,2)
    def test_sec_replay_uses_official_json_facts_not_filing_index_text(self):
        fact={'tag':'Revenues','val':100000000,'start':'2026-01-01','end':'2026-03-31','filed':'2026-04-20'}
        source={'cik':123,'facts':{'us-gaap':{'Revenues':{'units':{'USD':[{key:value for key,value in fact.items() if key!='tag'}]}}}}}
        point={'value':1,'publishedAt':'2026-04-20','originalItems':{'source_api_url':'https://data.sec.gov/api/xbrl/companyfacts/CIK0000000123.json','source_cik':'0000000123','rawSourceFacts':json.dumps([fact])}}
        loader=Mock(return_value=json.dumps(source).encode())
        self.assertEqual(verify_financial({'entity':'MU','family':'company_revenue'},point,loader),1)
        loader.assert_called_once_with(point['originalItems']['source_api_url'])
        point['originalItems']['rawSourceFacts']=json.dumps([{**fact,'val':200000000}])
        with self.assertRaises(AssertionError):verify_financial({'entity':'MU','family':'company_revenue'},point,loader)

if __name__=='__main__':unittest.main()

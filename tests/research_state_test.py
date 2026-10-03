"""Concurrent archives cannot discard signals, entry dates or completed outcomes."""
import importlib.util, json, pathlib, tempfile, unittest

spec=importlib.util.spec_from_file_location('state',pathlib.Path(__file__).resolve().parents[1]/'scripts/github-data-state.py')
state=importlib.util.module_from_spec(spec);spec.loader.exec_module(state)

def cohort(ident='A',value=10,at='2026-10-01'):
    return {'id':ident,'recordedAt':'2026-09-01T01:00:00Z','symbols':['MU'],'benchmark':'QQQ','inputHash':'input-'+ident,'costBpsPerSide':10,'entry':{'date':'2026-09-02','lockedAt':'2026-09-03'},'windows':[{'months':1,'status':'matured','netReturn':value,'excessReturn':value-2,'evaluatedAt':at},{'months':3,'status':'pending','evaluatedAt':at}],'progress':{'status':'ongoing','evaluatedAt':at}}

class ResearchStateTests(unittest.TestCase):
    def test_union_preserves_both_writers_and_first_known_dates(self):
        local=[{'recordId':'a','recordedAt':'2026-10-01'},{'recordId':'c','recordedAt':'2026-10-03'}]
        remote=[{'recordId':'a','recordedAt':'2026-10-01'},{'recordId':'b','recordedAt':'2026-10-02'}]
        self.assertEqual([r['recordId'] for r in state.ordered_union(local,remote,lambda r:r['recordId'],'recordedAt',True)],['a','b','c'])
        with self.assertRaises(ValueError):state.ordered_union(local,[{'recordId':'a','recordedAt':'2026-10-05'}],lambda r:r['recordId'],'recordedAt',True)
        history=state.ordered_union([{'inputHash':'x','generatedAt':'2026-10-03'}],[{'inputHash':'x','generatedAt':'2026-10-01'}],lambda r:r['inputHash'],'generatedAt');self.assertEqual(history[0]['generatedAt'],'2026-10-01')
    def test_completed_window_survives_concurrent_recalculation_and_union_aggregates(self):
        local={'asOf':'2026-10-03','cohorts':[cohort(at='2026-10-02'),cohort('B',value=20)]}
        remote={'asOf':'2026-10-02','cohorts':[cohort(value=99,at='2026-10-01')]}
        merged=state.merge_followup(local,remote);self.assertEqual(len(merged['cohorts']),2)
        a=merged['cohorts'][0];self.assertEqual(a['windows'][0]['netReturn'],99);self.assertEqual(a['progress']['evaluatedAt'],'2026-10-02')
        self.assertEqual(a['concurrentEvaluations'][0]['netReturn'],10);self.assertEqual(merged['byHorizon'][0]['maturedCount'],2);self.assertEqual(merged['byHorizon'][0]['meanNetReturn'],59.5)
        self.assertEqual(state.merge_followup(merged,remote),merged)
    def test_fixed_entry_and_cost_conflicts_fail_without_silent_rewrite(self):
        for field,value in [('costBpsPerSide',100),('entry',{'date':'2026-09-03','lockedAt':'2026-09-04'})]:
            other=cohort();other[field]=value
            with self.assertRaises(ValueError):state.merge_followup({'cohorts':[cohort()]},{'cohorts':[other]})
    def test_archive_files_are_merged_and_missing_sides_do_not_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            path=pathlib.Path(temp)/'research-alfred.json'
            local={'checkedAt':'2026-10-03','vintages':{'A':{'version':'a'}}};remote={'checkedAt':'2026-10-02','vintages':{'B':{'version':'b'}}}
            state.merge_research_archive(path,json.dumps(local).encode(),json.dumps(remote).encode());self.assertEqual(set(json.loads(path.read_text(encoding='utf-8'))['vintages']),{'A','B'})
            before=path.read_bytes();state.merge_research_archive(path,None,json.dumps(remote).encode());self.assertEqual(path.read_bytes(),before)
    def test_concurrent_input_keeps_earliest_capture_and_both_full_provenances(self):
        with tempfile.TemporaryDirectory() as temp:
            path=pathlib.Path(temp)/'input-hash.json'
            ours={'inputHash':'input-hash','createdAt':'2026-10-03','calculationInputHash':'new'};theirs={'inputHash':'input-hash','createdAt':'2026-10-02','calculationInputHash':'old'}
            state.merge_research_input(path,json.dumps(ours).encode(),json.dumps(theirs).encode())
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')),theirs)
            self.assertEqual(json.loads(next(path.parent.glob('*.concurrent-*.json')).read_text(encoding='utf-8')),ours)

if __name__=='__main__':unittest.main()

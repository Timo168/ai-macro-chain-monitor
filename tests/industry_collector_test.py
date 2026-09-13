import unittest,tempfile,pathlib,sys,json,sqlite3,importlib.util,io
from datetime import datetime,timedelta
from zipfile import ZipFile,ZIP_DEFLATED
from openpyxl import Workbook
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_common as common
from industry_extended import Builder
from industry_power_load import parse_archive

STATE_SPEC=importlib.util.spec_from_file_location('github_data_state',pathlib.Path(__file__).resolve().parents[1]/'scripts'/'github-data-state.py')
github_data_state=importlib.util.module_from_spec(STATE_SPEC);STATE_SPEC.loader.exec_module(github_data_state)

class RevisionTests(unittest.TestCase):
 def test_public_reviewed_projects_do_not_masquerade_as_operational(self):
  data=json.loads((common.DATA/'public-reviewed.json').read_text(encoding='utf-8'))
  self.assertEqual(len({p['id'] for p in data['projects']}),len(data['projects']))
  self.assertTrue(all(p['status']=='construction' and p['sourceUrls'] and p['notes'] for p in data['projects']))
  self.assertFalse(data['definitions'][0]['recommendationEligible'])
  self.assertTrue(all(p['isEstimated'] for p in data['series']['POWER.interconnection']['observations']))
  self.assertTrue(all(s['status']=='reviewed' for s in data['series'].values()))
  self.assertEqual(next(d for d in data['definitions'] if d['id']=='MU.inventory_days')['nameZh'],'Micron公司整体库存周转天数')
  self.assertTrue(all(p['publishedAt'] and p['fiscalPeriod'] for p in data['series']['MU.inventory_days']['observations']))

 def test_annual_stock_does_not_gain_monthly_aggregation(self):
  builder=Builder()
  builder.add('X','x','backlog','x','power','MW','url','stamp','version','2025-12-31',1,{},frequency='annual',eligible=False)
  self.assertEqual(builder.defs['X']['aggregation'],'none')
  self.assertFalse(builder.defs['X']['recommendationEligible'])

 def test_current_transformer_proxy_never_merges_discontinued_series(self):
  source=pathlib.Path(__file__).resolve().parents[1]/'scripts'/'industry_extended.py'
  code=source.read_text(encoding='utf-8')
  self.assertIn("code='WPU117409'",code)
  self.assertIn("get('source_series')=='WPU117409'",code)

 def test_concurrent_data_branch_merge_unions_revision_rows(self):
  with tempfile.TemporaryDirectory(prefix='data-state-test-') as temp:
   local=pathlib.Path(temp)/'local.sqlite';remote=pathlib.Path(temp)/'remote.sqlite'
   schema='CREATE TABLE observations(metric_id TEXT,period_end TEXT,version TEXT,payload TEXT,first_seen TEXT,PRIMARY KEY(metric_id,period_end,version))'
   for path,row in [(local,('X','2026-01-01','local','{}','a')),(remote,('X','2026-01-01','remote','{}','b'))]:
    db=sqlite3.connect(path);db.execute(schema);db.execute('INSERT INTO observations VALUES(?,?,?,?,?)',row);db.commit();db.close()
   github_data_state.merge_observations(local,remote.read_bytes())
   db=sqlite3.connect(local)
   try:self.assertEqual({r[0] for r in db.execute('SELECT version FROM observations')},{'local','remote'})
   finally:db.close()

 def test_ercot_spring_dst_month_requires_743_hours_and_uses_interval_start(self):
  workbook=Workbook();sheet=workbook.active
  sheet.append(['Hour Ending','COAST','EAST','FWEST','NORTH','NCENT','SOUTH','SCENT','WEST','TOTAL'])
  current=datetime(2026,3,1,1);end=datetime(2026,4,1,0);index=0
  while current<=end:
   if current!=datetime(2026,3,8,3):
    total=8000+index;sheet.append([current,*([total/8]*8),total]);index+=1
   current+=timedelta(hours=1)
  xlsx=io.BytesIO();workbook.save(xlsx);outer=io.BytesIO()
  with ZipFile(outer,'w',ZIP_DEFLATED) as archive:archive.writestr('Native_Load_2026.xlsx',xlsx.getvalue())
  rows,checks=parse_archive(outer.getvalue(),2026)
  self.assertEqual(len(rows),1);self.assertEqual(rows[0]['periodEnd'],'2026-03-31')
  self.assertEqual(rows[0]['items']['complete_hour_count'],743)
  self.assertEqual(checks['months']['2026-03']['expectedHours'],743)

 def test_revision_survives_unchanged_source_hash(self):
  with tempfile.TemporaryDirectory(prefix='industry-test-') as temp,patch.object(common,'DATA',pathlib.Path(temp)):
   path=pathlib.Path(temp)/'cache.json'
   def payload(value):return {'series':{'X':{'observations':[common.observation('X','2026-01-31',value,'https://example.com','2026-02-01','raw-hash',items={'raw':value})]}}}
   common.persist(payload(10),path);common.persist(payload(20),path)
   second=json.loads(path.read_text(encoding='utf-8'))['series']['X']['observations'][0]
   self.assertTrue(second['isRestated']);self.assertNotEqual(second['version'],'raw-hash')
   common.persist(payload(20),path)
   db=sqlite3.connect(pathlib.Path(temp)/'industry.sqlite')
   try:self.assertEqual(db.execute('select count(*) from observations').fetchone()[0],2)
   finally:db.close()
 def test_invalid_update_preserves_successful_file(self):
  with tempfile.TemporaryDirectory(prefix='industry-test-') as temp,patch.object(common,'DATA',pathlib.Path(temp)):
   path=pathlib.Path(temp)/'cache.json';path.write_text('{"last":"success"}')
   for value in (float('nan'),float('inf'),True):
    with self.assertRaises(ValueError):common.persist({'series':{'X':{'observations':[common.observation('X','2026-01-31',value,'url','stamp','v')]}}},path)
   self.assertEqual(json.loads(path.read_text()),{'last':'success'})
if __name__=='__main__':unittest.main()

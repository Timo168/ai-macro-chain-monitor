import unittest,tempfile,pathlib,sys,json,sqlite3,importlib.util,io
from types import SimpleNamespace
from datetime import datetime,timedelta
from zipfile import ZipFile,ZIP_DEFLATED
from openpyxl import Workbook
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_common as common
import industry_projects as projects_adapter
import industry_schedule as schedule_adapter
from industry_extended import Builder
from industry_costs import parse_eia
from industry_infrastructure import SERIES, cached_series, parse_fred_monthly, proxy_definition
from industry_power_load import parse_archive
from industry_schedule import bootstrap_extended
from industry_projects import SOURCES, parse_source, merge_project_history, operational_milestone_definition, operational_milestone_observations, retain_snapshots, restore_verified_baseline

STATE_SPEC=importlib.util.spec_from_file_location('github_data_state',pathlib.Path(__file__).resolve().parents[1]/'scripts'/'github-data-state.py')
github_data_state=importlib.util.module_from_spec(STATE_SPEC);STATE_SPEC.loader.exec_module(github_data_state)

class RevisionTests(unittest.TestCase):
 def test_census_construction_proxy_keeps_month_end_and_missing_source_values(self):
  rows=parse_fred_monthly(b'observation_date,PRPWRCONS\n2026-01-01,100\n2026-02-01,.\n')
  self.assertEqual(rows[0],{'sourceDate':'2026-01-01','periodEnd':'2026-01-31','value':100.0})
  self.assertEqual(rows[1],{'sourceDate':'2026-02-01','periodEnd':'2026-02-28','value':None})
  metric=proxy_definition({'id':'CENSUS.private_power_construction','code':'PRPWRCONS','name':'美国私营电力建设支出','name_en':'power','family':'grid_construction_spending','category':'power','stage':'power','unit':'百万美元（季调年率）','seasonal_adjustment':'SAAR','aggregation':'mean','data_role':'construction_environment_proxy','source_release_url':'https://example.com/release','methodology':'m','interpretation':'i','transmission':'t','proxy_targets':['power','overall']})
  self.assertEqual(metric['valueType'],'proxy')
  self.assertEqual(metric['directness'],'sector_proxy')
  self.assertEqual(metric['proxyTargets'],['power','overall'])
  self.assertEqual(metric['seasonalAdjustment'],'SAAR')
  self.assertEqual(metric['aggregation'],'mean')
  orders=proxy_definition(next(spec for spec in SERIES if spec['code']=='A34SNO'))
  self.assertEqual(orders['seasonalAdjustment'],'SA')
  self.assertEqual(orders['aggregation'],'sum')
  cached=cached_series({'observations':[{'periodEnd':'2026-01-31','value':100}]},'offline')
  self.assertEqual(cached['status'],'cached')
  self.assertEqual(cached['observations'][0]['value'],100)
  self.assertIn('offline',cached['error'])

 def test_eia_sales_proxy_preserves_native_mwh_instead_of_using_price(self):
  workbook=Workbook();sheet=workbook.active;sheet.title='Monthly-States'
  sheet.append([None]*16)
  header=[None]*16;header[8]='Revenue';header[9]='Sales';header[11]='Price';header[12]='Revenue';header[13]='Sales';header[15]='Price';sheet.append(header)
  units=[None]*16;units[8]='Thousand Dollars';units[9]='Megawatthours';units[11]='Cents/kWh';units[12]='Thousand Dollars';units[13]='Megawatthours';units[15]='Cents/kWh';sheet.append(units)
  row=[None]*16;row[0]=2026;row[1]=6;row[2]='VA';row[3]='Preliminary';row[8]=100;row[9]=1000;row[11]=10;row[12]=200;row[13]=2000;row[15]=10;sheet.append(row)
  payload=io.BytesIO();workbook.save(payload)
  parsed=parse_eia(payload.getvalue())
  self.assertEqual(parsed['VA.commercial'][0][1],10.0)
  self.assertEqual(parsed['VA.commercial_sales'][0][1],1000.0)
  self.assertEqual(parsed['VA.commercial_sales'][0][3]['sales_mwh'],1000)

 def test_eia_rejects_shifted_commercial_or_industrial_columns(self):
  workbook=Workbook();sheet=workbook.active;sheet.title='Monthly-States'
  sheet.append([None]*16)
  header=[None]*16;header[8]='Revenue';header[9]='Sales';header[11]='Price';header[12]='Revenue';header[13]='Sales';header[15]='Wrong';sheet.append(header)
  units=[None]*16;units[8]='Thousand Dollars';units[9]='Megawatthours';units[11]='Cents/kWh';units[12]='Thousand Dollars';units[13]='Megawatthours';units[15]='Cents/kWh';sheet.append(units)
  payload=io.BytesIO();workbook.save(payload)
  with self.assertRaisesRegex(ValueError,'Unexpected EIA-861M'):
   parse_eia(payload.getvalue())

 def test_fast_collector_retry_is_bounded_and_cached_sources_remain_retryable(self):
  self.assertEqual(schedule_adapter.retry_minutes(0),15)
  self.assertEqual(schedule_adapter.retry_minutes(1),15)
  self.assertEqual(schedule_adapter.retry_minutes(2),30)
  self.assertEqual(schedule_adapter.retry_minutes(3),60)
  self.assertEqual(schedule_adapter.retry_minutes(9),120)
  with tempfile.TemporaryDirectory(prefix='industry-fast-state-') as temp:
   data_path=pathlib.Path(temp)
   (data_path/'infrastructure.json').write_text(json.dumps({'series':{'CENSUS.x':{'status':'cached'}}}),encoding='utf-8')
   with patch.object(schedule_adapter,'DATA',data_path):
    healthy,details=schedule_adapter.source_snapshot_health('infrastructure.json')
   self.assertFalse(healthy)
   self.assertEqual(details,['CENSUS.x'])

 def test_doe_project_pages_keep_explicit_status_and_capacity_boundaries(self):
  stamp='2026-09-19T00:00:00+00:00'
  portsmouth=parse_source({'id':'DOE.US.PORTSMOUTH','publishedAt':'2026-03-24','url':'https://www.energy.gov/em/articles/partnership-ensures-affordable-energy-powers-ai-future-portsmouth-site'},b'<p>Groundbreaking for a 10-gigawatt artificial intelligence data center.</p>',stamp,'port')
  self.assertEqual(portsmouth[0]['status'],'construction');self.assertEqual(portsmouth[0]['powerCapacityMw'],10000)
  savannah=parse_source({'id':'DOE.US.SAVANNAH','publishedAt':'2026-07-20','url':'https://www.energy.gov/nnsa/articles/nnsa-selects-amentum-ai-data-center-and-energy-project-savannah-river-site'},b'<p>Selection to enter negotiations for a 1-gigawatt data center.</p>',stamp,'sav')
  self.assertEqual(savannah[0]['status'],'planning');self.assertEqual(savannah[0]['powerCapacityMw'],1000)
  inl=parse_source({'id':'DOE.US.INL.RFA','publishedAt':'2025-09-08','url':'https://www.energy.gov/ne/articles/energy-department-seeks-proposals-ai-data-centers-energy-projects-idaho-national'},b'<p>DOE seeks proposals for AI data centers.</p>',stamp,'inl')
  self.assertEqual(inl[0]['status'],'announced');self.assertIsNone(inl[0]['powerCapacityMw'])

 def test_meta_project_pages_keep_compute_capacity_and_operational_status_separate(self):
  stamp='2026-09-19T00:00:00+00:00'
  hyperion_spec=next(spec for spec in SOURCES if spec['id']=='META.US.HYPERION.EXPANSION')
  hyperion=parse_source(hyperion_spec,b'<p>Richland Parish expansion reaches 5 GW of compute capacity after breaking ground.</p>',stamp,'hyperion')
  self.assertEqual(hyperion[0]['status'],'construction');self.assertEqual(hyperion[0]['powerCapacityMw'],5000)
  self.assertEqual(hyperion[0]['capacityKind'],'compute_capacity')
  self.assertEqual(hyperion[0]['statusHistory'][0]['capacityMw'],5000)
  temple_spec=next(spec for spec in SOURCES if spec['id']=='META.US.TEMPLE.OPERATIONAL')
  temple=parse_source(temple_spec,b'<p>The Temple Data Center is serving traffic for AI workloads.</p>',stamp,'temple')
  self.assertEqual(temple[0]['status'],'operational');self.assertIsNone(temple[0]['powerCapacityMw'])
  self.assertNotIn('capacityMw',temple[0]['statusHistory'][0])

 def test_operational_milestones_are_source_linked_project_counts_not_mw(self):
  stamp='2026-09-19T00:00:00+00:00'
  events=[
   ('META-US-TN-GALLATIN','Gallatin','2024-11-14','https://example.com/gallatin'),
   ('META-US-AZ-MESA','Mesa','2025-01-30','https://example.com/mesa'),
   ('META-US-MO-KANSAS-CITY','Kansas City','2025-08-20','https://example.com/kc'),
   ('META-US-TX-TEMPLE','Temple','2026-07-22','https://example.com/temple'),
   ('META-US-ID-KUNA','Kuna','2026-09-03','https://example.com/kuna'),
  ]
  projects=[{'id':project_id,'name':name,'status':'operational','powerCapacityMw':None,'statusHistory':[{'date':date,'status':'operational','sourceUrl':url}]} for project_id,name,date,url in events]
  points=operational_milestone_observations(projects,{url for _,_,_,url in events},stamp)
  self.assertEqual([(point['periodEnd'],point['value']) for point in points],[('2024-11-14',1),('2025-01-30',2),('2025-08-20',3),('2026-07-22',4),('2026-09-03',5)])
  self.assertTrue(all(point['originalItems']['capacityDisclosure'].startswith('operational status milestone') for point in points))
  self.assertTrue(all('capacityMw' not in event for point in points for event in point['originalItems']['eventProjects']))
  definition=operational_milestone_definition()
  self.assertFalse(definition['recommendationEligible']);self.assertEqual(definition['unit'],'个项目');self.assertEqual(definition['frequency'],'event')

 def test_project_adapter_keeps_operational_mw_missing_and_caches_milestones_on_partial_failure(self):
  stamp='2026-09-19T00:00:00+00:00'
  source_text={
   'DOE.US.PORTSMOUTH':b'<p>Groundbreaking for a 10-gigawatt artificial intelligence data center.</p>',
   'DOE.US.SAVANNAH':b'<p>Selection to enter negotiations for a 1-gigawatt data center.</p>',
   'DOE.US.INL.RFA':b'<p>DOE seeks proposals for AI data centers.</p>',
   'META.US.HYPERION.EXPANSION':b'<p>Richland Parish expansion reaches 5 GW of compute capacity after breaking ground.</p>',
   'META.US.GALLATIN.OPERATIONAL':b'<p>The Gallatin Data Center is now serving traffic.</p>',
   'META.US.MESA.OPERATIONAL':b'<p>The Mesa Data Center is now serving traffic.</p>',
   'META.US.KANSAS_CITY.OPERATIONAL':b'<p>The Kansas City Data Center is operational and serving traffic.</p>',
   'META.US.TEMPLE.OPERATIONAL':b'<p>The Temple Data Center is serving traffic for AI workloads.</p>',
   'META.US.KUNA.OPERATIONAL':b'<p>The Kuna Data Center is online and operational.</p>',
  }
  by_url={spec['url']:spec for spec in SOURCES}
  def successful_fetch(url):
   spec=by_url[url];return source_text[spec['id']],stamp,'test-'+spec['id']
  with tempfile.TemporaryDirectory(prefix='project-adapter-') as temp:
   data_path=pathlib.Path(temp)
   with patch.object(projects_adapter,'DATA',data_path),patch.object(common,'DATA',data_path),patch.object(projects_adapter,'fetch',side_effect=successful_fetch):
    first=projects_adapter.build()
    self.assertEqual(first['series']['PROJECT.construction_capacity']['status'],'no_observation')
    self.assertEqual(first['series']['PROJECT.construction_capacity']['observations'],[])
    self.assertIn('口径不同',first['series']['PROJECT.construction_capacity']['note'])
    self.assertTrue(all(not metric['recommendationEligible'] and metric['scoringTier']=='leading_only' for metric in first['definitions']))
    self.assertEqual(first['series']['PROJECT.operational_capacity']['status'],'no_observation')
    self.assertEqual(first['series']['PROJECT.operational_capacity']['observations'],[])
    self.assertEqual([point['value'] for point in first['series']['PROJECT.operational_milestone_count']['observations']],[1,2,3,4,5])
    def fail_kuna(url):
     if by_url[url]['id']=='META.US.KUNA.OPERATIONAL':raise RuntimeError('simulated upstream failure')
     return successful_fetch(url)
    with patch.object(projects_adapter,'fetch',side_effect=fail_kuna):
     second=projects_adapter.build()
   self.assertEqual(second['series']['PROJECT.operational_milestone_count']['status'],'cached')
   self.assertEqual([point['value'] for point in second['series']['PROJECT.operational_milestone_count']['observations']],[1,2,3,4,5])
   self.assertEqual(second['series']['PROJECT.operational_capacity']['status'],'fetch_failed')

 def test_mixed_or_untyped_project_capacity_never_forms_a_single_mw_total(self):
  self.assertIsNone(projects_adapter.homogeneous_capacity_kind([{'capacityKind':'compute_capacity'},{'capacityKind':'data_center_planned_capacity'}]))
  self.assertIsNone(projects_adapter.homogeneous_capacity_kind([{'capacityMw':1000}]))
  self.assertEqual(projects_adapter.homogeneous_capacity_kind([{'capacityKind':'compute_capacity'},{'capacityKind':'compute_capacity'}]),'compute_capacity')
  self.assertEqual(projects_adapter.safe_capacity_snapshots([{'value':15000,'originalItems':{'projectIds':'A,B'}}]),[])
  projects=[{'id':'live','status':'construction','powerCapacityMw':5000,'capacityKind':'compute_capacity'},{'id':'old','status':'construction','powerCapacityMw':1000,'capacityKind':'compute_capacity'}]
  self.assertEqual([item['projectId'] for item in projects_adapter.capacity_project_items(projects,{'construction'},{'live'})],['live'])

 def test_project_history_and_snapshots_only_change_on_official_facts(self):
  previous={'status':'planning','powerCapacityMw':1000,'statusHistory':[{'date':'2026-07-20','status':'planning','capacityMw':1000,'sourceUrl':'a'}]}
  candidate={'status':'construction','powerCapacityMw':1000,'announcedAt':'2026-08-01','sourceUrls':['b'],'statusHistory':[{'date':'2026-08-01','status':'construction','capacityMw':1000,'sourceUrl':'b'}]}
  merged=merge_project_history(previous,candidate)
  self.assertEqual([event['status'] for event in merged['statusHistory']],['planning','construction'])
  first={'periodEnd':'2026-09-19','value':12000,'version':'old','originalItems':{'projectIds':'A,B'}}
  repeat={'periodEnd':'2026-09-21','value':12000,'version':'new','originalItems':{'projectIds':'A,B'}}
  changed={'periodEnd':'2026-09-21','value':13000,'version':'changed','originalItems':{'projectIds':'A,B,C'}}
  self.assertEqual(retain_snapshots([first],repeat),[first])
  self.assertEqual(retain_snapshots([first],changed),[first,changed])

 def test_status_transition_without_new_mw_does_not_promote_construction_capacity_to_operational(self):
  previous={'status':'construction','powerCapacityMw':5000,'capacityKind':'compute_capacity','sourceUrls':['construction'], 'statusHistory':[{'date':'2026-07-13','status':'construction','capacityMw':5000,'capacityKind':'compute_capacity','sourceUrl':'construction'}]}
  candidate={'status':'operational','powerCapacityMw':None,'sourceUrls':['operational'],'announcedAt':'2027-01-15','statusHistory':[{'date':'2027-01-15','status':'operational','sourceUrl':'operational'}]}
  merged=merge_project_history(previous,candidate)
  self.assertIsNone(merged['powerCapacityMw'])
  self.assertIsNone(merged['capacityKind'])
  self.assertEqual([event['status'] for event in merged['statusHistory']],['construction','operational'])
  self.assertNotIn('capacityMw',merged['statusHistory'][-1])

 def test_project_baseline_survives_a_transient_source_fetch_failure(self):
  stale={'id':'DOE-US-SC-SAVANNAH-AI','status':'planning','powerCapacityMw':1000}
  restored=restore_verified_baseline(stale)
  self.assertEqual(restored['stateCode'],'SC')
  self.assertEqual(restored['statusHistory'][0]['date'],'2026-07-20')
  self.assertEqual(restored['statusHistory'][0]['status'],'planning')

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

 def test_seed_adds_new_extended_metric_to_existing_cache(self):
  with tempfile.TemporaryDirectory(prefix='industry-bootstrap-') as temp:
   target=pathlib.Path(temp)/'extended.json'
   target.write_text(json.dumps({'definitions':[{'id':'OLD','sourceAdapter':'extended'}],'series':{'OLD':{'observations':[{'value':1}]}}}))
   initial={'definitions':[{'id':'OLD','sourceAdapter':'extended'},{'id':'VRT.backlog','sourceAdapter':'extended'}],'series':{'OLD':{'observations':[{'value':1}]},'VRT.backlog':{'observations':[{'value':150}]}}}
   bootstrap_extended(initial,target);result=json.loads(target.read_text(encoding='utf-8'))
   self.assertEqual({d['id'] for d in result['definitions']},{'OLD','VRT.backlog'})
   self.assertEqual(result['series']['VRT.backlog']['observations'][0]['value'],150)
   self.assertEqual(result['series']['VRT.backlog']['status'],'cached')

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
class CompanyHistoryTests(unittest.TestCase):
 def test_amd_history_requires_matching_dated_segment_and_gaap_columns(self):
  from industry_hardware import parse_amd_release
  header='<tr><td>March 28, 2026</td><td>December 27, 2025</td><td>March 29, 2025</td></tr>'
  raw=('<table>'+header+'<tr><td>Net Revenue:</td></tr><tr><td>Data Center Segment</td><td>5775</td><td>5380</td><td>3674</td></tr><tr><td>Total net revenue</td><td>10253</td><td>10270</td><td>7438</td></tr><tr><td>Operating Income:</td></tr><tr><td>Data Center Segment</td><td>1599</td><td>1752</td><td>932</td></tr></table><table>'+header+'<tr><td>Net revenue</td><td>10253</td><td>10270</td><td>7438</td></tr><tr><td>Gross margin</td><td>53%</td><td>54%</td><td>50%</td></tr></table>').encode()
  rows=parse_amd_release(raw)
  self.assertEqual(rows[-1]['periodEnd'],'2025-03-29')
  self.assertEqual(rows[-1]['datacenter_revenue'],3674)
  self.assertEqual(rows[-1]['fiscalPeriod'],'FY2025 Q1')
  self.assertEqual(rows[0]['datacenter_profit'],1599)
  # Mismatched table periods must not silently attach a margin to the wrong quarter.
  bad=raw.rsplit(b'March 29, 2025',1)
  with self.assertRaises(ValueError):parse_amd_release(bad[0]+b'June 28, 2025'+bad[1])
 def test_hpe_history_keeps_restatement_scope_and_actual_quarters(self):
  from industry_extended import parse_hpe_release
  text='Net Revenue: Cloud & AI Change (%)\nApril 30, 2026 January 31, 2026 April 30, 2025\nServer 5454 4232 4109 28.9 32.7\nGAAP gross profit margin 36.5% 35.9% 28.4%\n'
  reader=SimpleNamespace(pages=[SimpleNamespace(extract_text=lambda:text)])
  with patch('industry_extended.PdfReader',return_value=reader):rows=parse_hpe_release(b'fixture')
  self.assertEqual([r['fiscalPeriod'] for r in rows],['FY2026 Q2','FY2026 Q1','FY2025 Q2'])
  self.assertEqual(rows[-1]['server_revenue'],4109)
  self.assertEqual(rows[-1]['gross_margin'],28.4)
  reader.pages=[SimpleNamespace(extract_text=lambda:text.replace('Cloud & AI','Old Server scope'))]
  with patch('industry_extended.PdfReader',return_value=reader),self.assertRaises(ValueError):parse_hpe_release(b'fixture')

if __name__=='__main__':unittest.main()

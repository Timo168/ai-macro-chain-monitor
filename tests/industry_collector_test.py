import unittest,tempfile,pathlib,sys,json,sqlite3
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import industry_common as common

class RevisionTests(unittest.TestCase):
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

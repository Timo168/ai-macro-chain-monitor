import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from industry_sector_financials import sec_release_matches

class SectorReleaseProof(unittest.TestCase):
 def release(self,q=4):return {'fiscalYear':2026,'quarter':q,'publishedAt':'2026-09-30'}
 def row(self,end='2026-08-27',fp='FY'):
  return {'end':end,'publishedAt':'2026-10-01','inputs':[{'end':end,'fy':2026,'fp':fp},{'end':'2026-05-28','fy':2026,'fp':'Q3'}]}
 def test_micron_q4_uses_current_annual_input_not_q3_subtraction_base(self):
  self.assertTrue(sec_release_matches('MU',self.release(),self.row(),'2026-10-02'))
 def test_sec_comparative_quarter_tags_do_not_prove_current_report_ingestion(self):
  row=self.row('2026-05-28','FY')
  self.assertFalse(sec_release_matches('MU',self.release(),row,'2026-10-02'))
 def test_earnings_announcement_before_sec_filing_remains_pending(self):
  row=self.row();row['publishedAt']='2026-09-29'
  self.assertFalse(sec_release_matches('MU',self.release(),row,'2026-10-02'))
 def test_noncalendar_micron_q1_and_calendar_eaton_quarter(self):
  release={'fiscalYear':2026,'quarter':1,'publishedAt':'2025-12-17'}
  row={'end':'2025-11-27','publishedAt':'2025-12-18','inputs':[{'end':'2025-11-27','fy':2026,'fp':'Q1'}]}
  self.assertTrue(sec_release_matches('MU',release,row,'2026-10-02'))
  self.assertFalse(sec_release_matches('ETN',release,row,'2026-10-02'))

if __name__=='__main__':unittest.main()

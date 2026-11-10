import pathlib
import sys
import unittest
from datetime import date
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from policy_decisions import OFFICIAL_DECISION_SOURCES, find_latest_boj_guideline, find_latest_boe_statement, find_latest_fed_statement, find_latest_rba_statement, parse_boc_current_decision, parse_boe_statement, parse_boj_verified_guideline, parse_ecb_current_decision, parse_effective_date, parse_fed_statement, parse_rate_token, parse_rba_statement
from policy_decisions import parse_boj_guideline_rate, finalize_single_rate_decision, find_latest_dated_policy_link, parse_snb_statement, parse_rbi_statement, parse_rbnz_history, check_official_source


class PolicyDecisionParserTest(unittest.TestCase):
    def test_parses_fractional_target_range_and_raise(self):
        raw = b'''<html><body><p>The Committee decided to raise the target range for the federal funds rate by 1/4 percentage point to 3-3/4 to 4 percent.</p></body></html>'''
        decision = parse_fed_statement(raw, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm', date(2026, 9, 16))
        self.assertEqual(decision['action'], 'raise')
        self.assertEqual(decision['lower'], 3.75)
        self.assertEqual(decision['upper'], 4.0)
        self.assertEqual(decision['changeBps'], 25.0)

    def test_parses_effective_date_and_filters_future_or_wrong_feed_items(self):
        rss = b'''<rss><channel>
          <item><title>Other release</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260915a.htm</link></item>
          <item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm</link><pubDate>Wed, 16 Sep 2026 18:00:00 GMT</pubDate></item>
          <item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20271020a.htm</link></item>
        </channel></rss>'''
        statement_date, link, announced_at = find_latest_fed_statement(rss, date(2026, 9, 17))
        self.assertEqual(statement_date.isoformat(), '2026-09-16')
        self.assertEqual(link, 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm')
        self.assertEqual(announced_at, '2026-09-16T18:00:00+00:00')
        effective = parse_effective_date(b'<p>Effective September 17, 2026, the interest rate will change.</p>')
        self.assertEqual(effective, '2026-09-17')

    def test_parses_fractional_values(self):
        self.assertEqual(parse_rate_token('3-3/4'), 3.75)
        self.assertEqual(parse_rate_token('1/4'), 0.25)

    def test_finds_and_verifies_boj_guideline(self):
        index = b'''<table><tr><td>Sept. 18, 2026</td><td><a href="/en/mopo/mpmdeci/mpr_2026/k260918a.pdf">Change in the Guideline for Money Market Operations</a></td></tr></table>'''
        published, url = find_latest_boj_guideline(index, date(2026, 9, 18))
        self.assertEqual(published.isoformat(), '2026-09-18')
        self.assertEqual(url, 'https://www.boj.or.jp/en/mopo/mpmdeci/mpr_2026/k260918a.pdf')
        with self.assertRaises(ValueError):
            parse_boj_verified_guideline(b'not the official scan', url, published)

    def test_configures_all_followed_central_banks_for_official_source_checks(self):
        identifiers = [source['bankId'] for source in OFFICIAL_DECISION_SOURCES]
        self.assertEqual(len(identifiers), 14)
        self.assertEqual(len(set(identifiers)), 14)
        self.assertEqual(set(identifiers), {'fed','boj','bok','ecb','boe','boc','rba','rbnz','snb','pboc','cbr','rbi','bcb','sarb'})
        self.assertTrue(all(source['url'].startswith('https://') for source in OFFICIAL_DECISION_SOURCES))

    def test_boj_discovers_unchanged_statement_and_ignores_auxiliary_document(self):
        index = b'''<table>
        <tr><td>Sept. 18, 2026</td><td><a href="/en/mopo/mpmdeci/mpr_2026/k260918a.pdf">Change in the Guideline for Money Market Operations</a></td></tr>
        <tr><td>October 30, 2026</td><td><a href="/en/mopo/mpmdeci/mpr_2026/k261030a.pdf">Statement on Monetary Policy</a></td></tr>
        <tr><td>Nov. 1, 2026</td><td><a href="/en/mopo/mpmdeci/mpr_2026/k261101b.pdf">Reference - ETF sales</a></td></tr>
        </table>'''
        published, url = find_latest_boj_guideline(index, date(2026, 11, 10))
        self.assertEqual(published, date(2026, 10, 30))
        self.assertTrue(url.endswith('k261030a.pdf'))

    def test_boj_uses_adopted_target_not_dissent_or_etf_percentage(self):
        text = '''October 30, 202 6 Bank of Japan Statement on Monetary Policy
        1. Guideline for money market operations (an 8-1 majority vote)[Note]
        At the Monetary Policy Meeting held today, the Policy Board of the Bank of Japan
        decided to set the following guideline for money market operations:
        The Bank will encourage the uncollateralized overnight call rate to remain at around 1.25 percent.
        2. Change in the pace of sales 0.1 percent.
        Voting against the action: TAKATA. The Bank would encourage the uncollateralized overnight call rate to remain at around 1.5 percent.'''
        self.assertEqual(parse_boj_guideline_rate(text, date(2026,10,30)), 1.25)
        with self.assertRaises(ValueError):
            parse_boj_guideline_rate(text, date(2026,9,18))
        with self.assertRaises(ValueError):
            parse_boj_guideline_rate('October 30, 2026 Voting against the action: The Bank would encourage the uncollateralized overnight call rate to remain at around 1.5 percent.', date(2026,10,30))

    def test_boe_and_rba_extract_adopted_change_instead_of_zero(self):
        boe = parse_boe_statement(b'''<h1>Bank rate increased to 4%</h1><p>At its meeting ending on 4 November 2026, the Monetary Policy Committee (MPC) voted by a majority of 8-1 to increase Bank Rate by 0.25 percentage points, to 4%. One member voted to increase Bank Rate by 0.5 percentage points, to 4.25%.</p>''', 'https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/november-2026', date(2026,11,5))
        self.assertEqual((boe['midpoint'],boe['changeBps']), (4,25))
        rba = parse_rba_statement(b'<p>At its meeting today, the Board decided to increase the cash rate target by 25 basis points to 4.85 per cent.</p>', 'https://www.rba.gov.au/media-releases/2026/', date(2026,11,3))
        self.assertEqual((rba['midpoint'],rba['changeBps']), (4.85,25))

    def test_authoritative_hold_is_not_reinterpreted_against_lagged_monthly_rate(self):
        decision = parse_boe_statement(b'<h1>Bank rate maintained at 4%</h1>', 'https://www.bankofengland.co.uk/current', date(2026,11,5))
        with patch('policy_decisions.latest_monthly_rate', return_value=3.75), patch('policy_decisions.archive_raw',return_value=('hash','path')):
            result = finalize_single_rate_decision(decision,b'official source','2026-11-10T00:00:00Z','BOE_POLICY')
        self.assertEqual((result['action'],result['changeBps']), ('maintain',0))

    def test_snb_discovers_dated_release_and_preserves_zero_rate(self):
        raw=b'<a href="/en/publications/communication/press-releases-restricted/pre_20260924">Monetary policy assessment of 24 September 2026</a><a href="https://untrusted.example/pre_20261101">Monetary policy assessment of 1 November 2026</a>'
        published,url=find_latest_dated_policy_link(raw,'snb',date(2026,11,10))
        decision=parse_snb_statement(b'<h1>Monetary policy assessment of 24 September 2026</h1><h3>Swiss National Bank leaves SNB policy rate unchanged at 0%</h3><p>The discount is 0.25 percentage points.</p>',url,published)
        self.assertEqual((decision['midpoint'],decision['action'],decision['changeBps']),(0,'maintain',0))

    def test_rbi_uses_repo_not_deposit_or_bank_rate(self):
        raw=b'<a href="/Scripts/BS_PressReleaseDisplay.aspx?prid=63744">Governor\'s Statement: October 7, 2026</a>'
        published,url=find_latest_dated_policy_link(raw,'rbi',date(2026,11,10))
        decision=parse_rbi_statement(b'<p>Date : Oct 07, 2026</p><p>The MPC voted unanimously to increase the policy repo rate under the liquidity adjustment facility (LAF) by 25 bps to 5.50 per cent. The SDF stands at 5.25 per cent and Bank Rate at 5.75 per cent.</p>',url,published)
        self.assertEqual((decision['midpoint'],decision['action'],decision['changeBps']),(5.5,'raise',25))
        with self.assertRaises(ValueError):
            parse_rbi_statement(b'<p>Date : Oct 07, 2026</p><p>Bank Rate at 5.75 per cent.</p>',url,published)

    def test_rbnz_uses_two_actual_decision_rows_not_monthly_or_future(self):
        raw=b'''<table><tr><th>Date</th><th>OCR</th><th>Decision documents</th></tr>
        <tr><td>28 October 2026</td><td>2.75</td><td><a href="/news-and-events/news/2026/10/ocr-held-at-2-75-percent">Media release</a></td></tr>
        <tr><td>2 September 2026</td><td>2.75</td><td><a href="/news-and-events/news/2026/09/ocr">Media release</a></td></tr>
        <tr><td>1 December 2026</td><td>3.00</td><td><a href="/future">Media release</a></td></tr></table>'''
        d=parse_rbnz_history(raw,'https://www.rbnz.govt.nz/monetary-policy/monetary-policy-decisions',date(2026,11,10))
        self.assertEqual((d['announcementDate'],d['midpoint'],d['changeBps']),('2026-10-28',2.75,0))

    def test_source_reachability_does_not_claim_current_rate_verification(self):
        source=next(s for s in OFFICIAL_DECISION_SOURCES if s['bankId']=='boj')
        old={'boj':{'announcementDate':'2026-09-18','fetchedAt':'2026-09-18T01:00:00Z'}}
        with patch('policy_decisions.download',return_value=b'official index'):
            cached=check_official_source(source,'2026-11-10T00:00:00Z',set(),old,{'boj':'new PDF unreadable'})
            unparsed=check_official_source(next(s for s in OFFICIAL_DECISION_SOURCES if s['bankId']=='pboc'),'2026-11-10T00:00:00Z',set())
        self.assertEqual((cached['status'],cached['decisionStatus'],cached['rateVerificationStatus']),('ready','source_checked','cached'))
        self.assertEqual(cached['latestVerifiedAnnouncementDate'],'2026-09-18')
        self.assertEqual(unparsed['rateVerificationStatus'],'not_configured')

    def test_parses_boe_ecb_boc_and_rba_official_decisions(self):
        boe_rss = b'''<rss><channel><item><title>Bank rate maintained at 3.75% - September 2026 Monetary Policy Summary and Minutes</title><link>https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/september-2026</link><pubDate>Thu, 17 Sep 2026 12:00:00 +0100</pubDate></item></channel></rss>'''
        announced, boe_url, _ = find_latest_boe_statement(boe_rss, date(2026, 9, 18))
        boe = parse_boe_statement(b'<h1>Bank rate maintained at 3.75%</h1>', boe_url, announced)
        self.assertEqual((boe['announcementDate'], boe['midpoint'], boe['action']), ('2026-09-17', 3.75, 'maintain'))
        ecb = parse_ecb_current_decision(b'<p>PREVIOUS 23 July 2026 10 September 2026 NEXT</p><p>With effect from: 16 September 2026</p><p>Deposit facility 2.50 %</p>', 'https://www.ecb.europa.eu/current')
        self.assertEqual((ecb['announcementDate'], ecb['effectiveDate'], ecb['midpoint']), ('2026-09-10', '2026-09-16', 2.5))
        boc = parse_boc_current_decision(b'<p>September 2, 2026 2.25 --- July 15, 2026 2.25 ---</p>', 'https://www.bankofcanada.ca/current')
        self.assertEqual((boc['announcementDate'], boc['midpoint'], boc['action']), ('2026-09-02', 2.25, 'maintain'))
        rba_index = b'<a href="/media-releases/2026/mr-26-19.html">11 August 2026</a>'
        rba_date, rba_url = find_latest_rba_statement(rba_index, date(2026, 9, 18))
        rba = parse_rba_statement(b'<p>The Board decided to leave the cash rate target unchanged at 4.35 per cent.</p>', rba_url, rba_date)
        self.assertEqual((rba['announcementDate'], rba['midpoint'], rba['action']), ('2026-08-11', 4.35, 'maintain'))


if __name__ == '__main__':
    unittest.main()

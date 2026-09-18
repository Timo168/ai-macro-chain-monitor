import pathlib
import sys
import unittest
from datetime import date

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from policy_decisions import OFFICIAL_DECISION_SOURCES, find_latest_boj_guideline, find_latest_fed_statement, parse_boj_verified_guideline, parse_effective_date, parse_fed_statement, parse_rate_token


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


if __name__ == '__main__':
    unittest.main()

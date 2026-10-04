"""Official-list structures plus state-boundary and unknown-quarter regressions."""
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import industry_releases as releases

# Short structural excerpts from the official AMD media list and Dell NIR
# accordion list, sampled 2026-10-02. Financial facts are synthetic in tests.
AMD_LIST = b'''<div class="media-body col-md-8"><div class="media-heading">
<a href="https://ir.amd.com/news-events/press-releases/detail/1399/amd-reports-third-quarter-2027-financial-results">AMD Reports Third Quarter 2027 Financial Results</a>
</div><div class="date"><time datetime="2026-09-30T16:15:00">Sep 30, 2026 4:15 pm EDT</time></div></div>'''
DELL_LIST = b'''<article class="node--nir-news--nir-widget-list">
<a class="nir-widget--accordion-toggle">Dell Technologies Delivers Third Quarter Fiscal 2028 Financial Results</a>
<div class="nir-widget--news--date-time">September 30, 2026</div>
<div class="nir-widget--news--read-more"><a href="/news-releases/new-actual-release">Read More</a></div></article>'''
# Minimal official page structures sampled on 2026-10-04. No full reports or
# licensed tables are embedded; the detail-page financial sentence is synthetic.
AMKR_LIST = b'''<article class="node node--nir-news--teaser node--type-nir-news node--view-mode-teaser node--promoted"><h2><a href="/news-releases/news-release-details/amkor-technology-reports-financial-results-second-quarter-2026" rel="bookmark"><span class="field field--name-title field--type-string field--label-hidden">Amkor Technology Reports Financial Results for the Second Quarter 2026</span></a></h2><div class="node__content"></div><div class="node__links"><a href="/news-releases/news-release-details/amkor-technology-reports-financial-results-second-quarter-2026">Read more</a></div></article>'''
ENTG_LIST = b'''<div class="item"><div class="date">Published Aug 4, 2026</div><a href="/en/home/about-us/news/entegris-reports-results-for-second-quarter-2026.html">Entegris Reports Results for Second Quarter 2026</a></div>'''
AMKR_DETAIL = b'''<html><meta property="article:published_time" content="2026-07-27T16:03:28-04:00"><h1>Press Releases</h1><h2><div class="field field--name-field-nir-news-title field--type-string field--label-hidden"><div class="field__item">Amkor Technology Reports Financial Results for the Second Quarter 2026</div></div></h2><main>Revenue was $100 million.</main></html>'''
ENTG_DETAIL = b'''<html><h1 class="module_title">News Details</h1><h3 class="evergreen-item-detail-title evergreen-news-title"><span>Entegris Reports Results for Second Quarter of 2026</span></h3><span class="evergreen-news-date-text">Aug 4, 2026</span><main>Revenue was $100 million.</main></html>'''


def document(title, content='Revenue was $100 million.', date='2026-09-30'):
    return f'<html><meta property="article:published_time" content="{date}"><main><h1>{title}</h1><p>{content}</p></main></html>'.encode()


class ReleaseDiscoveryTests(unittest.TestCase):
    def test_amkor_actual_index_structure_keeps_fiscal_quarter_and_reads_detail_date(self):
        items = releases.parse_index('AMKR', AMKR_LIST, releases.SOURCES['AMKR'][0])
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]['fiscalYear'], items[0]['quarter']), (2026, 2))
        self.assertIsNone(items[0]['publishedAt'])
        item = releases.validate_release(items[0], AMKR_DETAIL)
        self.assertEqual(item['publishedAt'], '2026-07-27T16:03:28-04:00')
        self.assertEqual(item['title'], 'Amkor Technology Reports Financial Results for the Second Quarter 2026')

    def test_entegris_corporate_index_keeps_actual_link_date_and_report_headline(self):
        item = releases.parse_index('ENTG', ENTG_LIST, releases.SOURCES['ENTG'][0])[0]
        self.assertEqual((item['fiscalYear'], item['quarter']), (2026, 2))
        self.assertEqual(item['publishedAt'], '2026-08-04')
        self.assertTrue(item['url'].startswith('https://www.entegris.com/en/home/about-us/news/'))
        verified = releases.validate_release(item, ENTG_DETAIL)
        self.assertEqual(verified['title'], 'Entegris Reports Results for Second Quarter of 2026')
        self.assertEqual(verified['publishedAt'], '2026-08-04')

    def test_new_issuer_discovery_validates_detail_then_preserves_cache_on_failure(self):
        for entity, index, body in [('AMKR', AMKR_LIST, AMKR_DETAIL), ('ENTG', ENTG_LIST, ENTG_DETAIL)]:
            with self.subTest(entity=entity):
                def get(url, force=False):
                    return (index if url == releases.SOURCES[entity][0] else body), '2026-10-03T01:00:00+00:00', 'official-hash'
                ready = releases._entity(entity, {}, True, get)
                self.assertEqual(ready['status'], 'ready')
                self.assertEqual(len(ready['releases']), 1)
                def fail(url, force=False):
                    raise RuntimeError('upstream timeout')
                cached = releases._entity(entity, ready, True, fail)
                self.assertEqual(cached['status'], 'cached')
                self.assertEqual(cached['releases'], ready['releases'])
                self.assertEqual(cached['lastSuccessfulAt'], ready['lastSuccessfulAt'])

    def test_entegris_upcoming_notice_is_not_an_actual_financial_release(self):
        raw = ENTG_LIST.replace(b'Entegris Reports Results', b'Entegris to Report Results')
        item = releases.parse_index('ENTG', raw, releases.SOURCES['ENTG'][0])[0]
        body = ENTG_DETAIL.replace(b'Entegris Reports Results', b'Entegris to Report Results').replace(b'Revenue was $100 million.', b'Entegris will report financial results on October 20, 2026.')
        value = releases.validate_release(item, body)
        self.assertEqual(value['kind'], 'upcoming')
        self.assertEqual(value['eventAt'], '2026-10-20')

    def test_unknown_future_fiscal_quarter_is_discovered_without_guessing_url(self):
        items = releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])
        self.assertEqual(len(items), 1)
        self.assertEqual((items[0]['fiscalYear'], items[0]['quarter']), (2027, 3))
        self.assertEqual(items[0]['publishedAt'], '2026-09-30')
        self.assertIn('/1399/', items[0]['url'])

    def test_dell_read_more_uses_article_heading_and_source_date(self):
        items = releases.parse_index('DELL', DELL_LIST, releases.SOURCES['DELL'][0])
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['fiscalYear'], 2028)
        self.assertEqual(items[0]['quarter'], 3)
        self.assertEqual(items[0]['url'], 'https://investors.delltechnologies.com/news-releases/new-actual-release')
        self.assertEqual(items[0]['publishedAt'], '2026-09-30')

    def test_microsoft_alias_reads_actual_canonical_fiscal_year(self):
        raw = b'''<link rel="canonical" href="https://www.microsoft.com/en-us/investor/earnings/fy-2027-q1/press-release-webcast"><main><h1>Press Release &amp; Webcast</h1><p>REDMOND, Wash. September 30, 2026. Revenue grew.</p></main>'''
        item = releases.parse_index('MSFT', raw, releases.SOURCES['MSFT'][0])[0]
        self.assertEqual((item['fiscalYear'], item['quarter']), (2027, 1))
        self.assertTrue(item['url'].startswith('https://www.microsoft.com/'))
        self.assertEqual(releases.validate_release(item, raw)['publishedAt'], '2026-09-30')

    def test_fiscal_formats_are_stated_not_calendar_converted(self):
        for text, expected in [('Q2 FY27 Press Release.pdf', (2027, 2)), ('FY-2027-Q1', (2027, 1)), ('Fiscal Year 2026 Third Quarter Results', (2026, 3)), ('Second Quarter and Full Year 2025 Financial Results', (2025, 2)), ('/2026/q3', (2026, 3))]:
            with self.subTest(text=text):
                self.assertEqual(releases.fiscal_period(text), expected)

    def test_official_hosts_reject_similar_domains_credentials_and_bad_ports(self):
        for url in ['https://ir.amd.com.evil.test/reports', 'https://evil.test/ir.amd.com/reports', 'https://user@ir.amd.com/reports', 'http://ir.amd.com/reports', 'https://ir.amd.com:bad/reports']:
            self.assertFalse(releases.official_url('AMD', url))
        self.assertTrue(releases.official_url('AMD', 'https://ir.amd.com/reports'))

    def test_external_report_link_is_never_candidate(self):
        raw = AMD_LIST.replace(b'https://ir.amd.com/', b'https://example.com/')
        self.assertEqual(releases.parse_index('AMD', raw, releases.SOURCES['AMD'][0]), [])

    def test_preannouncement_is_separate_from_published_results(self):
        raw = AMD_LIST.replace(b'AMD Reports Third Quarter', b'AMD to Report Fiscal Third Quarter')
        item = releases.parse_index('AMD', raw, releases.SOURCES['AMD'][0])[0]
        body = document(item['title'], 'AMD will report financial results on October 20, 2026. A webcast will be available.')
        verified = releases.validate_release(item, body)
        self.assertEqual(verified['kind'], 'upcoming')
        self.assertEqual(verified['eventAt'], '2026-10-20')
        self.assertEqual(verified['publishedAt'], '2026-09-30')

    def test_dell_to_hold_call_is_preannouncement(self):
        raw = DELL_LIST.replace(b'Delivers Third', b'to Hold Conference Call to Discuss Third')
        self.assertEqual(releases.parse_index('DELL', raw, releases.SOURCES['DELL'][0])[0]['kind'], 'upcoming')

    def test_future_earnings_day_is_not_notice_publication_day(self):
        raw = AMD_LIST.replace(b'AMD Reports Third Quarter', b'AMD to Report Fiscal Third Quarter')
        item = releases.parse_index('AMD', raw, releases.SOURCES['AMD'][0])[0]
        body = document(item['title'], 'September 30, 2026. AMD today announced that it will report financial results on October 20, 2026.')
        value = releases.validate_release(item, body)
        self.assertEqual(value['publishedAt'], '2026-09-30')
        self.assertEqual(value['eventAt'], '2026-10-20')

    def test_tsm_future_meeting_does_not_create_published_data(self):
        item = {'entity': 'TSM', 'fiscalYear': 2026, 'quarter': 3, 'publishedAt': None, 'url': 'https://investor.tsmc.com/english/quarterly-results/2026/q3', 'indexUrl': releases.SOURCES['TSM'][0], 'title': 'Q3', 'kind': 'release'}
        raw = b'<main><h1>Financial Results - 2026Q3</h1><p>TSMC Third Quarter 2026 Earnings Conference will be held on Thursday, October 15, 2026, at 14:00 Taiwan time.</p></main>'
        result = releases.validate_release(item, raw)
        self.assertEqual(result['kind'], 'upcoming')
        self.assertEqual(result['eventAt'], '2026-10-15')
        self.assertIsNone(result['publishedAt'])

    def test_missing_publication_date_is_not_published(self):
        item = releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])[0]
        item['publishedAt'] = None
        raw = b'<h1>AMD Reports Third Quarter 2027 Financial Results</h1><p>Revenue rose.</p>'
        with self.assertRaisesRegex(ValueError, '发布日期'):
            releases.validate_release(item, raw)

    def test_future_publication_date_is_not_published(self):
        item = releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])[0]
        item['publishedAt'] = '2099-01-01'
        with self.assertRaisesRegex(ValueError, '未来'):
            releases.validate_release(item, document(item['title']))

    def test_oracle_short_title_year_is_verified_in_body(self):
        item = {'entity': 'ORCL', 'fiscalYear': None, 'quarter': None, 'publishedAt': None, 'url': 'https://investor.oracle.com/news/q1', 'title': 'Oracle Announces Q1 Results Driven by Cloud', 'indexUrl': releases.SOURCES['ORCL'][0], 'kind': 'release'}
        result = releases.validate_release(item, document(item['title'], 'Oracle announced Q1 FY27 results. Revenue was $100 million.'))
        self.assertEqual((result['fiscalYear'], result['quarter']), (2027, 1))

    def test_failed_request_preserves_original_dates_and_cache(self):
        item = releases.validate_release(releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])[0], document('AMD Reports Third Quarter 2027 Financial Results'))
        item.update(discoveredAt='2026-09-30T01:00:00+00:00', fetchedAt='2026-09-30T01:00:00+00:00', version='v1')
        prior = {'releases': [item], 'upcoming': [], 'lastSuccessfulAt': '2026-09-30T01:00:00+00:00'}
        def fail(url, force=False):
            raise RuntimeError('HTTP 403')
        result = releases._entity('AMD', prior, True, fail)
        self.assertEqual(result['status'], 'cached')
        self.assertEqual(result['releases'], prior['releases'])
        self.assertEqual(result['lastSuccessfulAt'], prior['lastSuccessfulAt'])
        self.assertIn('403', result['error'])

    def test_failed_first_request_is_failure_not_unpublished(self):
        def fail(url, force=False):
            raise RuntimeError('HTTP 404')
        result = releases._entity('AMD', {}, True, fail)
        self.assertEqual(result['status'], 'fetch_failed')
        self.assertFalse(result['upcoming'])
        self.assertIsNone(result['lastSuccessfulAt'])

    def test_http_200_without_financial_links_is_not_success(self):
        result = releases._entity('AMD', {}, False, lambda url, force=False: (b'<h1>Latest news</h1>', '2026-09-30T01:00:00+00:00', 'hash'))
        self.assertEqual(result['status'], 'fetch_failed')

    def test_success_discovery_preserves_first_discovery_and_candidate_read_is_offline(self):
        url = releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])[0]['url']
        def get(value, force=False):
            raw = AMD_LIST if value == releases.SOURCES['AMD'][0] else document('AMD Reports Third Quarter 2027 Financial Results')
            return raw, '2026-09-30T01:00:00+00:00', 'hash'
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'discovery.json'
            first = releases.run(True, ['AMD'], path, get)
            stamp = first['entities']['AMD']['releases'][0]['discoveredAt']
            second = releases.run(True, ['AMD'], path, get)
            self.assertEqual(second['entities']['AMD']['status'], 'ready')
            self.assertEqual(second['entities']['AMD']['releases'][0]['discoveredAt'], stamp)
            self.assertEqual(releases.candidates('AMD', path)[0]['url'], url)

    def test_unknown_entity_is_not_configured(self):
        with tempfile.TemporaryDirectory() as folder:
            result = releases.run(entities=['UNKNOWN'], path=Path(folder) / 'discovery.json')
            self.assertEqual(result['entities']['UNKNOWN']['status'], 'not_configured')
            self.assertFalse(result['entities']['UNKNOWN']['releases'])

    def test_date_only_and_timezone_metadata_keep_their_distinction(self):
        self.assertEqual(releases.parse_date('2026-08-04T16:15:00'), '2026-08-04')
        self.assertEqual(releases.parse_date('2026-08-04T20:15:00Z'), '2026-08-04T20:15:00+00:00')
        self.assertEqual(releases.parse_date('September 10th, 2026'), '2026-09-10')

    def test_nvidia_actual_body_is_used_instead_of_related_news_articles(self):
        item = {'entity': 'NVDA', 'fiscalYear': 2027, 'quarter': 2, 'publishedAt': None, 'url': 'https://nvidianews.nvidia.com/news/results', 'indexUrl': releases.SOURCES['NVDA'][0], 'title': 'NVIDIA Announces Financial Results for Second Quarter Fiscal 2027', 'kind': 'release'}
        raw = b'''<h1 class="article-title">NVIDIA Announces Financial Results for Second Quarter Fiscal 2027</h1><div class="article-date">August 26, 2026</div><div class="article-body">Revenue was $100 million.</div><article class="index-item">Related news without financial facts September 28, 2026</article>'''
        result = releases.validate_release(item, raw)
        self.assertEqual(result['publishedAt'], '2026-08-26')
        self.assertEqual(result['kind'], 'release')

    def test_bootstrap_validated_cache_keeps_success_time_after_first_failure(self):
        item = releases.validate_release(releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])[0], document('AMD Reports Third Quarter 2027 Financial Results'))
        item.update(fiscalYear=2027, discoveredAt='2026-09-30T01:00:00+00:00', fetchedAt='2026-09-30T01:00:00+00:00', version='hash')
        seed = {'entities': {'AMD': {'releases': [item], 'upcoming': [], 'lastSuccessfulAt': '2026-09-30T01:00:00+00:00'}}}
        def fail(url, force=False):
            raise RuntimeError('HTTP 403')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = root / 'data' / 'industry'
            data.mkdir(parents=True)
            path = data / 'release-discovery.json'
            (data / 'release-discovery.seed.json').write_text(json.dumps(seed), encoding='utf-8')
            with patch.object(releases, 'ROOT', root), patch.object(releases, 'DATA', data), patch.object(releases, 'PATH', path):
                result = releases.run(True, ['AMD'], fetcher=fail)
            value = result['entities']['AMD']
            self.assertEqual(value['status'], 'cached')
            self.assertEqual(value['lastSuccessfulAt'], seed['entities']['AMD']['lastSuccessfulAt'])
            self.assertEqual(value['releases'][0]['fetchedAt'], item['fetchedAt'])

    def test_bootstrap_rejects_external_url_future_publication_and_fake_quarter(self):
        item = releases.validate_release(releases.parse_index('AMD', AMD_LIST, releases.SOURCES['AMD'][0])[0], document('AMD Reports Third Quarter 2027 Financial Results'))
        item.update(discoveredAt='2026-09-30T01:00:00+00:00', fetchedAt='2026-09-30T01:00:00+00:00', version='hash')
        for edits in ({'url': 'https://evil.test/data'}, {'publishedAt': '2099-01-01'}, {'quarter': True}):
            with self.subTest(edits=edits), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                data = root / 'data' / 'industry'
                data.mkdir(parents=True)
                path = data / 'release-discovery.json'
                seed = {'entities': {'AMD': {'releases': [dict(item, **edits)], 'upcoming': [], 'lastSuccessfulAt': '2026-09-30T01:00:00+00:00'}}}
                (data / 'release-discovery.seed.json').write_text(json.dumps(seed), encoding='utf-8')
                with patch.object(releases, 'ROOT', root), patch.object(releases, 'DATA', data), patch.object(releases, 'PATH', path):
                    self.assertFalse(releases._seed_prior(path)['entities'])

    def test_custom_test_path_never_reads_workspace_seed(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(releases._seed_prior(Path(folder) / 'release-discovery.json'), {})


if __name__ == '__main__':
    unittest.main()

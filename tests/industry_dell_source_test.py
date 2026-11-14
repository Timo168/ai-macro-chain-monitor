"""Synthetic reports exercise the official IR migration, not financial values."""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import industry_dell_source as dell

OLD = f'https://{dell.HOST}/news-releases/news-release-details/dell-technologies-delivers-second-quarter-fiscal-2027-financial'
NEW = dell.INDEX + '/detail/1653/dell-technologies-delivers-second-quarter-fiscal-2027-financial-results'
INDEX = dell.INDEX + '?year=2026&category=financial'
TITLE = 'Dell Technologies Delivers Second Quarter Fiscal 2027 Financial Results'
REPORT = f'<html><title>{TITLE}</title><h1>{TITLE}</h1><table><tr><td>Three Months Ended</td><td>July 31, 2026</td></tr><tr><td>Total net revenue</td><td>100</td></tr></table></html>'.encode()
LIST = f'<html><h1>Press Releases</h1><a href="{NEW}">{TITLE}</a></html>'.encode()


def migrated_request(url):
    if url == OLD:
        return LIST, dell.INDEX
    if url == INDEX:
        return LIST, INDEX
    if url == NEW:
        return REPORT, NEW
    raise AssertionError('Unexpected URL: ' + url)


class DellMigrationTests(unittest.TestCase):
    def test_resolves_same_fiscal_quarter_from_official_index(self):
        self.assertEqual(dell.resolve_report(OLD, migrated_request), (REPORT, NEW))

    def test_existing_report_needs_no_index(self):
        calls = []
        def request(url):
            calls.append(url)
            return REPORT, url
        self.assertEqual(dell.resolve_report(NEW, request), (REPORT, NEW))
        self.assertEqual(calls, [NEW])

    def test_missing_news_entry_uses_the_exact_archived_earnings_release(self):
        other = NEW.replace('second-quarter', 'third-quarter')
        archive = f'<a href="{other}">Earnings Release HTML</a><a href="{NEW}">Earnings Release Q2 2027 HTML</a>'.encode()
        def request(url):
            if url == INDEX:
                return b'<h1>Press Releases</h1>', INDEX
            if url == dell.RESULTS:
                return archive, dell.RESULTS
            return migrated_request(url)
        self.assertEqual(dell.resolve_report(OLD, request), (REPORT, NEW))

    def test_archive_rejects_other_quarters_and_non_release_links(self):
        archive = f'<a href="{NEW}">Webcast transcript</a>'.encode()
        with self.assertRaisesRegex(ValueError, '同财政期'):
            dell.resolve_report(OLD, lambda url: (archive, dell.RESULTS) if url == dell.RESULTS else (b'no releases', dell.INDEX))

    def test_old_404_can_resolve_from_index(self):
        def request(url):
            if url == OLD:
                raise dell.requests.HTTPError('404')
            return migrated_request(url)
        self.assertEqual(dell.resolve_report(OLD, request), (REPORT, NEW))

    def test_wrong_quarter_index_is_not_used(self):
        wrong = LIST.replace(b'second-quarter', b'third-quarter').replace(b'Second Quarter', b'Third Quarter')
        with self.assertRaisesRegex(ValueError, '同财政期'):
            dell.resolve_report(OLD, lambda url: (wrong, dell.INDEX))

    def test_wrong_quarter_detail_is_rejected_even_with_right_link(self):
        def request(url):
            return (REPORT.replace(b'Second Quarter', b'Third Quarter'), NEW) if url == NEW else migrated_request(url)
        with self.assertRaisesRegex(ValueError, '财政期不一致'):
            dell.resolve_report(OLD, request)

    def test_list_page_and_tableless_report_cannot_pass(self):
        with self.assertRaisesRegex(ValueError, '列表'):
            dell.validate_report(REPORT, dell.INDEX, (2027, 2))
        with self.assertRaisesRegex(ValueError, '财务表格'):
            dell.validate_report(f'<h1>{TITLE}</h1>'.encode(), NEW, (2027, 2))

    def test_nonofficial_redirect_and_candidates_are_rejected(self):
        with self.assertRaisesRegex(ValueError, '非官方'):
            dell.resolve_report(OLD, lambda url: (REPORT, 'https://example.com/report'))
        bad = LIST.replace(dell.HOST.encode(), b'example.com')
        with self.assertRaisesRegex(ValueError, '同财政期'):
            dell.resolve_report(OLD, lambda url: (bad, dell.INDEX))
        for url in ['http://' + dell.HOST, f'https://user@{dell.HOST}', f'https://{dell.HOST}:444', f'https://{dell.HOST}.example.com']:
            self.assertFalse(dell.official(url))

    def test_duplicate_same_quarter_reports_are_not_arbitrarily_selected(self):
        ambiguous = LIST + LIST.replace(b'/detail/1653/', b'/detail/9999/')
        with self.assertRaisesRegex(ValueError, '唯一'):
            dell.resolve_report(OLD, lambda url: (ambiguous, dell.INDEX))

    def test_cache_preserves_requested_and_resolved_urls_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            raw, stamp, digest = dell.fetch_report(OLD, folder, request=migrated_request)
            self.assertEqual(raw, REPORT)
            meta = dell.source_metadata(OLD, folder)
            self.assertEqual((meta['url'], meta['resolvedUrl'], meta['hash']), (OLD, NEW, digest))
            self.assertEqual(digest, hashlib.sha256(REPORT).hexdigest())
            def no_network(url):
                raise AssertionError('valid recent cache should be reused')
            self.assertEqual(dell.fetch_report(OLD, folder, request=no_network), (raw, stamp, digest))

    def test_failed_refresh_does_not_replace_last_successful_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            dell.fetch_report(OLD, folder, request=migrated_request)
            before = {path.name: path.read_bytes() for path in folder.iterdir()}
            with self.assertRaises(ValueError):
                dell.fetch_report(OLD, folder, force=True, request=lambda url: (b'<h1>Press Releases</h1>', dell.INDEX))
            self.assertEqual(before, {path.name: path.read_bytes() for path in folder.iterdir()})

    def test_previous_list_page_cache_is_never_returned_as_a_report(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            digest = hashlib.sha256(LIST).hexdigest()
            (folder / (digest + '.html')).write_bytes(LIST)
            meta = {'url': OLD, 'file': digest + '.html', 'hash': digest, 'fetchedAt': dell.datetime.now(dell.timezone.utc).isoformat()}
            (folder / (hashlib.sha256(OLD.encode()).hexdigest() + '.meta.json')).write_text(json.dumps(meta), encoding='utf-8')
            self.assertEqual(dell.fetch_report(OLD, folder, request=migrated_request)[0], REPORT)

    def test_known_numeric_legacy_nodes_keep_their_exact_fiscal_identity(self):
        self.assertEqual(dell.requested_period(f'https://{dell.HOST}/node/19176'), (2026, 4))
        self.assertEqual(dell.requested_period(f'https://{dell.HOST}/node/19036'), (2026, 3))
        self.assertIsNone(dell.requested_period(f'https://{dell.HOST}/node/99999'))

    def test_upcoming_conference_notice_does_not_resolve_into_actual_results(self):
        url = dell.INDEX + '/detail/1651/dell-technologies-to-hold-conference-call-sept-1-to-discuss-second-quarter-fiscal-2027-financial-results'
        self.assertFalse(dell.is_report_url(url))

    def test_collector_and_audit_use_same_validated_loader(self):
        import industry_releases
        import audit_industry
        audit_industry.source_bytes.cache_clear()
        try:
            with patch.object(dell, 'fetch_report', return_value=(REPORT, 'stamp', 'hash')) as loader:
                self.assertEqual(industry_releases.fetch_official(OLD), (REPORT, 'stamp', 'hash'))
                self.assertEqual(audit_industry.source_bytes(OLD), (REPORT, 'hash'))
                self.assertEqual(loader.call_count, 2)
        finally:
            audit_industry.source_bytes.cache_clear()


if __name__ == '__main__':
    unittest.main()

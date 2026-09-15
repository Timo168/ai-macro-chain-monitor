import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from policy_rates import parse_policy_rates


class PolicyRatesParserTest(unittest.TestCase):
    def test_parses_all_selected_countries_and_keeps_month_end_values(self):
        header = 'FREQ,REF_AREA,UNIT_MEASURE,TITLE,TIME_PERIOD,OBS_VALUE\n'
        rows = []
        months=[f'{year}-{month:02d}' for year in [2022,2023] for month in range(1,13)]
        for area, value in [('US', '4.5'), ('JP', '0.5'), ('KR', '3.5'), ('XM', '3.75'), ('GB', '5.25'), ('CA', '4.75')]:
            for month in months:
                rows.append(f'M,{area},368,Policy {area},{month},{value}')
        series = parse_policy_rates((header + '\n'.join(rows)).encode())
        self.assertEqual([item['sourceArea'] for item in series], ['US', 'JP', 'KR', 'XM', 'GB', 'CA'])
        self.assertEqual(series[0]['latestObservationDate'], '2023-12-01')
        self.assertEqual(series[0]['latestValue'], 4.5)

    def test_rejects_duplicate_months(self):
        header = 'FREQ,REF_AREA,UNIT_MEASURE,TITLE,TIME_PERIOD,OBS_VALUE\n'
        rows = []
        for area in ['US', 'JP', 'KR', 'XM', 'GB', 'CA']:
            rows.extend([f'M,{area},368,Policy {area},2023-01,1.0'] * 24)
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            parse_policy_rates((header + '\n'.join(rows)).encode())


if __name__ == '__main__':
    unittest.main()

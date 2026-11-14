"""Taiwan Stock Exchange monthly archive. Revenue is reported in TWD thousands."""
import re
from datetime import timedelta

from bs4 import BeautifulSoup


def last_closed_month(today):
    return today.replace(day=1) - timedelta(days=1)


def report_url(end):
    return f'https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_{end.year-1911}_{end.month}_0.html'


def current_revenue(raw, end):
    soup = BeautifulSoup(raw.decode('cp950'), 'html.parser')
    year, month = end.year - 1911, end.month
    if not soup.find(string=re.compile(rf'上市公司\s*{year}年\s*{month}月份')):
        raise ValueError('证交所月报的年月与请求不符')
    matches = [cell.parent for cell in soup.find_all('td', string=re.compile(r'^\s*2330\s*$'))]
    if len(matches) != 1:
        raise ValueError('证交所月报需要唯一的台积电 2330 行')
    row = matches[0]
    table = row.find_parent('table')
    fields = [cell.get_text(strip=True) for cell in row.find_all('td', recursive=False)]
    headers = [cell.get_text(strip=True).replace(' ','') for cell in table.find_all('th')]
    if (fields[:2] != ['2330', '台積電'] or not table.find_previous(string=re.compile(r'^\s*單位[：:]\s*千元\s*$'))
            or '當月營收' not in headers):
        raise ValueError('证交所公司名称、当月营收列或千元单位不符')
    header = next(row for row in table.find_all('tr') if any(cell.get_text(strip=True)=='當月營收' for cell in row.find_all('th', recursive=False)))
    column = [cell.get_text(strip=True) for cell in header.find_all('th', recursive=False)].index('當月營收')
    if not re.fullmatch(r'[\d,]+', fields[column]):
        raise ValueError('台积电当月营收尚无可核对金额')
    return int(fields[column].replace(',', ''))


def fill_latest(snapshot, today, fetch):
    key='TSM.revenue'
    series=snapshot['series'].get(key)
    if not series:
        return False
    end=last_closed_month(today)
    points=series['observations']
    latest=max((p['periodEnd'] for p in points if p.get('value') is not None),default='')
    url=report_url(end)
    if latest>end.isoformat():
        return False
    existing=next((p for p in points if p['periodEnd']==end.isoformat() and p.get('value') is not None),None)
    if existing and existing['sourceUrl']!=url:
        return False
    raw,stamp,digest=fetch(url)
    thousand=current_revenue(raw,end)
    # Keep the issuer annual table's million-TWD precision and record the
    # exchange's full integer in the dated point, including rounding basis.
    million=(thousand+500)//1000
    from industry_common import observation
    point=observation(key,end.isoformat(),million/100,url,stamp,digest,start=end.replace(day=1).isoformat(),
                      formula='证交所当月营收（千新台币）四舍五入至百万 / 100',
                      items={'companyCode':'2330','reportedThousandTwd':thousand,'reportedMillionTwd':million})
    point.update(sourceDocumentVersion=digest,originalValue=thousand,originalUnit='TWD thousand',originalCurrency='TWD')
    series.update(observations=sorted([p for p in points if p['periodEnd']!=end.isoformat()]+[point],key=lambda p:p['periodEnd']),
                  status='ready',checkedAt=stamp,fetchedAt=stamp,error=None)
    for definition in snapshot.get('definitions',[]):
        if definition['id']==key:
            definition.update(sourceName='台积电投资者关系 / 台湾证交所',sourceUrl=url,
                              methodology='台积电公布每月合并营收。台湾证交所月报按公司代码 2330 提取当月数，将千新台币四舍五入至百万，再换算为亿新台币。每期保留实际来源。')
    return True

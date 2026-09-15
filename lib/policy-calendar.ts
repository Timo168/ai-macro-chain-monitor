export type PolicyCalendarEvent={
 id:string;
 bankId:string;
 bank:string;
 country:string;
 startDate:string;
 decisionDate:string;
 title:string;
 timezone:string;
 sourceUrl:string;
 scheduleType:'official'|'cadence';
 note?:string;
};

export const policyBanks=[
 {id:'fed',name:'美联储',country:'美国',shortName:'FOMC',sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'},
 {id:'boj',name:'日本银行',country:'日本',shortName:'BOJ',sourceUrl:'https://www.boj.or.jp/en/mopo/mpmsche_minu/'},
 {id:'bok',name:'韩国银行',country:'韩国',shortName:'BOK',sourceUrl:'https://www.bok.or.kr/eng/main/contents.do?menuNo=400020'},
 {id:'ecb',name:'欧洲央行',country:'欧元区',shortName:'ECB',sourceUrl:'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html'},
 {id:'boe',name:'英格兰银行',country:'英国',shortName:'BoE',sourceUrl:'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates'},
 {id:'boc',name:'加拿大银行',country:'加拿大',shortName:'BoC',sourceUrl:'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/'},
] as const;

// 会议日期均来自各央行已公布的 2026 年日程；决议日采用最后一个会议日或
// 央行明确列出的公告日。时间未由来源统一确认时不虚构为北京时间。
export const policyCalendar=([
 {id:'fed-202609',bankId:'fed',bank:'美联储',country:'美国',startDate:'2026-09-15',decisionDate:'2026-09-16',title:'FOMC 两日会议 · 含新闻发布会',timezone:'美国东部时间',sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',scheduleType:'official'},
 {id:'fed-202610',bankId:'fed',bank:'美联储',country:'美国',startDate:'2026-10-27',decisionDate:'2026-10-28',title:'FOMC 两日会议 · 含新闻发布会',timezone:'美国东部时间',sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',scheduleType:'official'},
 {id:'fed-202612',bankId:'fed',bank:'美联储',country:'美国',startDate:'2026-12-08',decisionDate:'2026-12-09',title:'FOMC 两日会议 · 含新闻发布会与预测材料',timezone:'美国东部时间',sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',scheduleType:'official'},
 {id:'boj-202609',bankId:'boj',bank:'日本银行',country:'日本',startDate:'2026-09-17',decisionDate:'2026-09-18',title:'货币政策会议（两日）',timezone:'日本标准时间',sourceUrl:'https://www.boj.or.jp/en/mopo/mpmsche_minu/',scheduleType:'official'},
 {id:'boj-202610',bankId:'boj',bank:'日本银行',country:'日本',startDate:'2026-10-29',decisionDate:'2026-10-30',title:'货币政策会议（两日）· 展望报告',timezone:'日本标准时间',sourceUrl:'https://www.boj.or.jp/en/mopo/mpmsche_minu/',scheduleType:'official'},
 {id:'boj-202612',bankId:'boj',bank:'日本银行',country:'日本',startDate:'2026-12-17',decisionDate:'2026-12-18',title:'货币政策会议（两日）',timezone:'日本标准时间',sourceUrl:'https://www.boj.or.jp/en/mopo/mpmsche_minu/',scheduleType:'official'},
 {id:'bok-202610',bankId:'bok',bank:'韩国银行',country:'韩国',startDate:'2026-10-22',decisionDate:'2026-10-22',title:'货币政策委员会利率决定',timezone:'韩国标准时间',sourceUrl:'https://www.bok.or.kr/eng/main/contents.do?menuNo=400020',scheduleType:'official'},
 {id:'bok-202611',bankId:'bok',bank:'韩国银行',country:'韩国',startDate:'2026-11-26',decisionDate:'2026-11-26',title:'货币政策委员会利率决定',timezone:'韩国标准时间',sourceUrl:'https://www.bok.or.kr/eng/main/contents.do?menuNo=400020',scheduleType:'official'},
 {id:'ecb-202610',bankId:'ecb',bank:'欧洲央行',country:'欧元区',startDate:'2026-10-28',decisionDate:'2026-10-29',title:'管理委员会货币政策会议（两日）· 新闻发布会',timezone:'中欧时间',sourceUrl:'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',scheduleType:'official'},
 {id:'ecb-202612',bankId:'ecb',bank:'欧洲央行',country:'欧元区',startDate:'2026-12-16',decisionDate:'2026-12-17',title:'管理委员会货币政策会议（两日）· 新闻发布会',timezone:'中欧时间',sourceUrl:'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html',scheduleType:'official'},
 {id:'boe-202609',bankId:'boe',bank:'英格兰银行',country:'英国',startDate:'2026-09-17',decisionDate:'2026-09-17',title:'货币政策委员会利率决定',timezone:'英国时间',sourceUrl:'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates',scheduleType:'official'},
 {id:'boe-202611',bankId:'boe',bank:'英格兰银行',country:'英国',startDate:'2026-11-05',decisionDate:'2026-11-05',title:'货币政策委员会利率决定 · 货币政策报告',timezone:'英国时间',sourceUrl:'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates',scheduleType:'official'},
 {id:'boe-202612',bankId:'boe',bank:'英格兰银行',country:'英国',startDate:'2026-12-17',decisionDate:'2026-12-17',title:'货币政策委员会利率决定',timezone:'英国时间',sourceUrl:'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates',scheduleType:'official'},
 {id:'boc-202610',bankId:'boc',bank:'加拿大银行',country:'加拿大',startDate:'2026-10-28',decisionDate:'2026-10-28',title:'隔夜利率目标公告 · 货币政策报告',timezone:'美国东部时间',sourceUrl:'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/',scheduleType:'official'},
 {id:'boc-202612',bankId:'boc',bank:'加拿大银行',country:'加拿大',startDate:'2026-12-09',decisionDate:'2026-12-09',title:'隔夜利率目标公告',timezone:'美国东部时间',sourceUrl:'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/',scheduleType:'official'},
 ...[['2027-01-26','2027-01-27'],['2027-03-16','2027-03-17'],['2027-04-27','2027-04-28'],['2027-06-08','2027-06-09'],['2027-07-27','2027-07-28'],['2027-09-14','2027-09-15'],['2027-10-26','2027-10-27'],['2027-12-07','2027-12-08']].map(([startDate,decisionDate]):PolicyCalendarEvent=>({id:`fed-${decisionDate.replaceAll('-','')}`,bankId:'fed',bank:'美联储',country:'美国',startDate,decisionDate,title:'FOMC 两日会议',timezone:'美国东部时间',sourceUrl:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',scheduleType:'official'})),
 ...[['2027-01-21','2027-01-22'],['2027-03-17','2027-03-18'],['2027-04-27','2027-04-28'],['2027-06-10','2027-06-11'],['2027-07-21','2027-07-22'],['2027-09-21','2027-09-22'],['2027-10-28','2027-10-29'],['2027-12-16','2027-12-17']].map(([startDate,decisionDate]):PolicyCalendarEvent=>({id:`boj-${decisionDate.replaceAll('-','')}`,bankId:'boj',bank:'日本银行',country:'日本',startDate,decisionDate,title:'货币政策会议（两日）',timezone:'日本标准时间',sourceUrl:'https://www.boj.or.jp/en/mopo/mpmsche_minu/',scheduleType:'official'})),
 ...['2027-02-04','2027-03-18','2027-04-29','2027-06-17','2027-07-29','2027-09-16','2027-11-04','2027-12-16'].map((decisionDate):PolicyCalendarEvent=>({id:`boe-${decisionDate.replaceAll('-','')}`,bankId:'boe',bank:'英格兰银行',country:'英国',startDate:decisionDate,decisionDate,title:'货币政策委员会利率决定',timezone:'英国时间',sourceUrl:'https://www.bankofengland.co.uk/monetary-policy/upcoming-mpc-dates',scheduleType:'official'})),
 ...['2027-01-27','2027-03-03','2027-04-28','2027-06-02','2027-07-21','2027-09-08','2027-10-27','2027-12-08'].map((decisionDate):PolicyCalendarEvent=>({id:`boc-${decisionDate.replaceAll('-','')}`,bankId:'boc',bank:'加拿大银行',country:'加拿大',startDate:decisionDate,decisionDate,title:'隔夜利率目标公告',timezone:'美国东部时间',sourceUrl:'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/',scheduleType:'official'})),
] satisfies PolicyCalendarEvent[]).sort((a,b)=>a.decisionDate.localeCompare(b.decisionDate)||a.bank.localeCompare(b.bank));

export const policyCalendarSourceCheckedAt='2026-09-15';

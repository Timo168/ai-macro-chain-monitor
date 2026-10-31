import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
let server,buildObserverCatalog;
before(async()=>{server=await createServer({configFile:false,server:{middlewareMode:true},logLevel:'error'});({buildObserverCatalog}=await server.ssrLoadModule('/lib/observer-catalog.ts'));});
after(async()=>{await server?.close()});
const inputs=()=>({macro:{generatedAt:'',series:{}},industry:null,research:null,policyRates:null,policyDecisions:null});
const series=(id,observations,status='ready')=>({id,observations,status,fetchedAt:'2026-10-30T00:00:00Z',checkedAt:'2026-10-31T00:00:00Z',sourceUrl:'https://example.org/'+id,revision:'v1'});
test('unloaded domains never become a wall of unconfigured-source warnings',()=>{assert.deepEqual(buildObserverCatalog(inputs()),[])});
test('catalog reuses the displayed transformations, units and distinct Treasury bases',()=>{
 const data=inputs();data.macro={generatedAt:'2026-10-31',series:{ICSA:series('ICSA',[{date:'2026-10-24',value:194000}]),PAYEMS:series('PAYEMS',[{date:'2026-08-01',value:160000},{date:'2026-09-01',value:160100}]),DGS10:series('DGS10',[{date:'2026-10-29',value:4.5},{date:'2026-10-30',value:null}]),DFII10:series('DFII10',[{date:'2026-10-29',value:2.1}]),PCEPILFE:series('PCEPILFE',[{date:'2025-09-01',value:100},{date:'2026-08-01',value:102},{date:'2026-09-01',value:103}])}};
 const catalog=buildObserverCatalog(data),byId=id=>catalog.find(item=>item.id===id);
 assert.equal(byId('macro:ICSA').value,'194.0');assert.equal(byId('macro:ICSA').unit,'千人');
 assert.equal(byId('macro:PAYEMS').value,'100.00');
 assert.equal(byId('macro:DGS10').value,'4.50');assert.match(byId('macro:DGS10').title,/名义/);assert.equal(byId('macro:DGS10').period,'2026-10-29');
 assert.equal(byId('macro:DFII10').value,'2.10');assert.match(byId('macro:DFII10').title,/实际/);
 assert.equal(byId('macro:PCEPILFE:yoy').value,'3.00');assert.equal(byId('macro:PCEPILFE:mom').value,'0.98');
 assert.equal(byId('macro:PCEPILFE:yoy').sourceUrl,'https://example.org/PCEPILFE');assert.match(byId('macro:PCEPILFE:mom').href,/chartMode=mom/);
 assert.equal(byId('macro:GOLD').value,'—');assert.equal(byId('macro:GOLD').status,'来源未配置');assert.match(byId('macro:GOLD').href,/commodityMode=monthly/);
 assert.match(byId('macro:MKT_GOLD').href,/commodityMode=market/);
});
test('missing inflation bases stay missing rather than showing an index as a rate',()=>{
 const data=inputs();data.macro={generatedAt:'2026-10-31',series:{PCEPILFE:series('PCEPILFE',[{date:'2026-09-01',value:103}])}};
 const item=buildObserverCatalog(data).find(row=>row.id==='macro:PCEPILFE:yoy');assert.equal(item.value,'—');assert.equal(item.status,'计算基期不足');
});
test('an official decision is visible separately from monthly history and preserves failure state',()=>{
 const data=inputs();data.policyRates={generatedAt:'2026-10-01',checkedAt:'2026-10-31',status:'ready',series:[{id:'fed',name:'美联储',country:'美国',shortName:'FOMC',sourceTitle:'政策月末',sourceUrl:'https://example.org/history',status:'ready',observations:[{date:'2026-08-31',value:3.625}]}]};
 data.policyDecisions={generatedAt:'2026-10-31',checkedAt:'2026-10-31',status:'cached',decisions:[{bankId:'fed',bank:'美联储',country:'美国',announcementDate:'2026-09-16',effectiveDate:'2026-09-17',lower:3.75,upper:4,midpoint:3.875,statementUrl:'https://example.org/decision'}]};
 const item=buildObserverCatalog(data).find(row=>row.id==='policy:fed');assert.equal(item.value,'3.75–4.00');assert.equal(item.period,'2026-09-16');assert.equal(item.sourceUrl,'https://example.org/decision');assert.equal(item.status,'获取失败 · 保留缓存');assert.deepEqual(item.points,[{date:'2026-08-31',value:3.625}]);
});

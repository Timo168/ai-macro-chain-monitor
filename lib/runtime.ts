declare global {interface Window {__MACRO_BASE__?:string;__MACRO_DATA_URL__?:string}}
export function appBase(){return typeof window!=='undefined'?window.__MACRO_BASE__??'/':'/'}
export function dataEndpoint(){return typeof window!=='undefined'?window.__MACRO_DATA_URL__??'/api/data':'/api/data'}
export function manifestEndpoint(){return appBase()==='/'?'/api/manifest':appBase()+'data/manifest.json'}
export function industryEndpoint(){return appBase()==='/'?'/api/industry':appBase()+'data/industry.json'}
export function industryHistoryEndpoint(){return appBase()==='/'?'/api/industry/history':appBase()+'data/industry-history.json'}
export function policyRatesEndpoint(){return appBase()==='/'?'/api/policy-rates':appBase()+'data/policy-rates.json'}
export function policyDecisionsEndpoint(){return appBase()==='/'?'/api/policy-decisions':appBase()+'data/policy-decisions.json'}
export function versionedEndpoint(endpoint:string,version?:string){return version?`${endpoint}${endpoint.includes('?')?'&':'?'}v=${encodeURIComponent(version)}`:endpoint}

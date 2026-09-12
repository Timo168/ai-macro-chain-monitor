declare global {interface Window {__MACRO_BASE__?:string;__MACRO_DATA_URL__?:string}}
export function appBase(){return typeof window!=='undefined'?window.__MACRO_BASE__??'/':'/'}
export function dataEndpoint(){return typeof window!=='undefined'?window.__MACRO_DATA_URL__??'/api/data':'/api/data'}

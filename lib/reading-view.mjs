export const READING_VIEW_KEY='macro-observatory:reading:v1';
const allowedPages=new Set(['overview','economy','materials','financing','impact','policy-calendar','methodology','workbench','notebook']);
export function validReadingView(value){
 if(typeof value!=='string'||value.length>3000||!value.startsWith('?')||/[\r\n]/.test(value))return false;
 const query=new URLSearchParams(value.split('#')[0]);
 return allowedPages.has(query.get('page'))&&(!query.has('range')||['1','3','5','all'].includes(query.get('range')));
}
export function rememberReadingView(){
 if(typeof location==='undefined')return;
 const value=location.search+location.hash;if(!validReadingView(value))return;
 try{localStorage.setItem(READING_VIEW_KEY,value)}catch{}
}

export function panelAnchor(hash){try{return decodeURIComponent(String(hash??'').replace(/^#/,''));}catch{return '';}}
export function resolvePanelSelection(items,saved,hash=''){
 const anchor=panelAnchor(hash);
 return items.find(item=>anchor&&(item.id===anchor||item.anchor===anchor||item.aliases?.includes(anchor)))
  ??items.find(item=>item.id===saved)??items[0]??null;
}
export function panelSelectionUrl(href,anchor){const url=new URL(href);url.hash=anchor||'';return url.pathname+url.search+url.hash;}

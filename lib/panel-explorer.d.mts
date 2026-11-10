export function panelAnchor(hash:unknown):string;
export function resolvePanelSelection<T extends {id:string;anchor?:string;aliases?:string[]}>(items:T[],saved:string,hash?:string):T|null;
export function panelSelectionUrl(href:string,anchor?:string):string;

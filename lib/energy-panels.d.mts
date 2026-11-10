export type EnergyView={id:string;label:string;groupId?:string;anchor:string;aliases:string[]};
export type EnergyTopic={id:string;title:string;anchor:string;aliases:string[];views:EnergyView[]};
export const energyTopics:EnergyTopic[];
export function resolveEnergyTopic(anchor:string,regionalIds?:string[]):EnergyTopic|undefined;
export function resolveEnergyView(topicId:string,anchor:string,saved?:string,regionalIds?:string[]):EnergyView|null;
export function energySelectionUrl(href:string,anchor:string):string;

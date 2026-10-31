import type {Dataset} from './data';
import type {IndustryDataset,IndustryResearch} from './industry/types';
import type {PolicyRatesDataset} from './policy-rates';
import type {PolicyDecisionsDataset} from './policy-decisions';

export type ObserverInputs={macro:Dataset;industry:IndustryDataset|null;research:IndustryResearch|null;policyRates:PolicyRatesDataset|null;policyDecisions:PolicyDecisionsDataset|null};
export type ObservationItem={
 id:string;title:string;subtitle:string;kind:'macro'|'industry'|'valuation'|'policy';
 href:string;panelKey?:string;anchorId?:string;searchTerms:string;
 value:string;unit:string;period:string;status:string;warning:boolean;
 checkedAt?:string|null;nextExpectedAt?:string|null;sourceUrl?:string|null;sourceVersion?:string|null;
 points?:{date:string;value:number|null}[];
};

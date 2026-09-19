export type MetricDefinition = {
 id:string; nameZh:string; nameEn:string; category:string; entity?:string; family:string;
 frequency:'daily'|'monthly'|'quarterly'|'annual'|'event'; unit:string; currency?:string;
 valueType:'reported'|'calculated'|'guidance'|'official'|'project_announcement'|'third_party'|'proxy'|'demo';
 sourceName:string; sourceUrl:string; methodology:string; aiChainStage:string[];
 isComparableAcrossEntities:boolean; normalUpdateDelayDays:number; recommendationEligible:boolean;
 exportAllowed:boolean; sourceOwner?:string; accessMethod?:string; licenseNote?:string;
 interpretation?:string; transmission?:string; crossCheck?:string; aggregation?:'sum'|'mean'|'last'|'none';
};
export type MetricObservation = {
 metricId:string; periodStart?:string; periodEnd:string; fiscalPeriod?:string; value:number|null;
 originalValue?:number; originalUnit?:string; originalCurrency?:string; filingDate?:string; publishedAt?:string|null;
 fetchedAt:string; sourceUrl:string; version:string; isEstimated:boolean; isRestated:boolean;
 formula?:string; originalItems?:Record<string,number|string>; basis?:string;
};
export type MetricSeries = {observations:MetricObservation[]; status:'ready'|'reviewed'|'cached'|'fetch_failed'|'pending'|'authorization_required'|'not_configured'|'no_observation'; fetchedAt?:string; lastSuccessfulAt?:string; checkedAt?:string; error?:string; nextCheckAt?:string; note?:string};
export type DataCenterProject = {id:string;name:string;owner:string;operator?:string;country:string;region?:string;city?:string;status:'announced'|'planning'|'approval'|'construction'|'partially_operational'|'operational'|'delayed'|'cancelled'|'unknown';announcedAt?:string;expectedConstructionAt?:string;expectedOperationalAt?:string;investmentValue?:number;investmentCurrency?:string;powerCapacityMw?:number;sourceUrls:string[];lastVerifiedAt:string;isEstimated:boolean;notes?:string};
export type IndustryEvent = {id:string;entity:string;title:string;date:string;sourceUrl:string;kind:'guidance'|'release'|'project'|'supply';description:string;valueLow?:number;valueHigh?:number;unit?:string;period?:string;fetchedAt:string;isConfirmed:boolean};
export type EvidenceItem={metricId:string;observationVersion:string;direction:'positive'|'neutral'|'negative';explanation:string;periodEnd?:string;dimension?:string};
export type Recommendation={id:string;targetType:'industry';targetId:string;targetName:string;level:'positive_allocation'|'gradual_attention'|'neutral_hold'|'cautious_watch'|'reduce_exposure'|'insufficient_data';confidence:'high'|'medium'|'low';horizon:'short'|'medium'|'long';generatedAt:string;dataCutoffAt:string;evidencePeriodStart?:string;evidencePeriodEnd?:string;positiveEvidence:EvidenceItem[];negativeEvidence:EvidenceItem[];neutralEvidence:EvidenceItem[];invalidationConditions:string[];watchMetrics:string[];ruleVersion:string;previousRecommendationId?:string;reason:string;dimensions:{id:string;name:string;state:'positive'|'neutral'|'negative'|'missing';metricIds:string[]}[];missingMetrics:string[];changeReason?:string;previousLevel?:string;coverage:number;requiredDimensionCount?:number;availableDimensionCount?:number};
export type IndustryDataset={schemaVersion:string;generatedAt:string;definitions:MetricDefinition[];series:Record<string,MetricSeries>;projects:DataCenterProject[];events:IndustryEvent[];recommendations?:Recommendation[];recommendationHistory?:Recommendation[];sources?:{id:string;name:string;url:string;status:string;fetchedAt?:string;checkedAt?:string;error?:string;note?:string}[];scheduler?:{mode:string;lastRunAt:string;nextCheckAt?:string};verification?:unknown};

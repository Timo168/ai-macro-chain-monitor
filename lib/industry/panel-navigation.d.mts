import type {MetricDefinition} from './types';
export function researchRouteTopic(href: string): string | null;
export function researchTopicFromLocation(href: string, saved?: string): string;
export function sourceCatalogPage(definitions: MetricDefinition[], options?: {search?: string; category?: string; page?: number; pageSize?: number}): {items: MetricDefinition[]; count: number; pages: number; page: number};

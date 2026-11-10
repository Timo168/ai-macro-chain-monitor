const researchTopics = new Set(['sectors', 'progress', 'plans', 'rules']);
const researchSections = new Set(['attention', 'changes', 'robustness', 'tracking', 'validation', 'valuation', 'crossCompany', 'modelEvaluation']);

/** A specific visible anchor wins over an older research query in a saved URL. */
export function researchRouteTopic(href) {
  let url;
  try { url = new URL(href, 'https://local.invalid'); } catch { return null; }
  let hash = '';
  try { hash = decodeURIComponent(url.hash.slice(1)); } catch { /* Invalid fragments do not hide the default summary. */ }
  const anchors = {'research-progress': 'progress', 'plan-delivery': 'plans', 'research-conclusions': 'sectors', 'research-rules': 'rules'};
  if (anchors[hash]) return anchors[hash];
  if (researchSections.has(url.searchParams.get('research'))) return 'progress';
  return null;
}

export function researchTopicFromLocation(href, saved = 'sectors') {
  const explicit = researchRouteTopic(href);
  if (explicit) return explicit;
  return researchTopics.has(saved) ? saved : 'sectors';
}

/** Filtering preserves catalog order and never changes observations or units. */
export function sourceCatalogPage(definitions, {search = '', category = 'all', page = 0, pageSize = 8} = {}) {
  const query = String(search).trim().toLocaleLowerCase();
  const items = (Array.isArray(definitions) ? definitions : []).filter(def => (category === 'all' || def.category === category) && (!query || [def.id, def.entity, def.nameZh, def.nameEn, def.sourceName].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)));
  const size = Math.max(1, Math.min(50, Number.isFinite(pageSize) ? Math.floor(pageSize) : 8));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const selectedPage = Math.max(0, Math.min(pages - 1, Number.isFinite(page) ? Math.floor(page) : 0));
  return {items: items.slice(selectedPage * size, (selectedPage + 1) * size), count: items.length, pages, page: selectedPage};
}

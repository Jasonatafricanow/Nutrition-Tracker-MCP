/** Read-only USDA FDC adapter for an external MCP agent. No writes or inferred nutrients. */
export const USDA_FDC_BASE = 'https://api.nal.usda.gov/fdc/v1';
const accepted = new Set(['Foundation', 'SR Legacy']);
const NUTRIENTS = {p:1003, f:1004, c:1005};

export function extractMacros(food) {
  const entries = food?.foodNutrients;
  if (!accepted.has(food?.dataType) || !Array.isArray(entries)) return null;
  const values = {};
  for (const [key,id] of Object.entries(NUTRIENTS)) {
    const found = entries.find(n => Number(n.nutrient?.id ?? n.nutrientId) === id &&
      String(n.nutrient?.unitName ?? n.unitName ?? '').toUpperCase() === 'G');
    const amount = found?.amount ?? found?.value;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 100) return null;
    values[key] = amount;
  }
  if (values.p + values.c + values.f > 100.5) return null;
  return values;
}

export function createUSDAClient({apiKey=process.env.FDC_API_KEY, fetchImpl=globalThis.fetch, timeoutMs=7000}={}) {
  const request = async (path,params={}) => {
    if (!apiKey) throw new Error('USDA_DISABLED: configure FDC_API_KEY to enable external search');
    const url = new URL(USDA_FDC_BASE + path);
    url.searchParams.set('api_key',apiKey);
    for (const [k,v] of Object.entries(params)) url.searchParams.set(k,String(v));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(),timeoutMs);
    try {
      const r = await fetchImpl(url.toString(), {signal:abort.signal,headers:{Accept:'application/json'},redirect:'error'});
      if (!r.ok) throw new Error(`USDA_UPSTREAM_HTTP_${r.status}`);
      return await r.json();
    } finally {clearTimeout(timer);}
  };
  return {
    async search(query,limit=10) {
      if (typeof query !== 'string' || !query.trim() || query.length>120) throw new Error('query must be 1–120 characters');
      if (!Number.isInteger(limit)||limit<1||limit>20) throw new Error('limit must be 1–20');
      const body=await request('/foods/search',{query:query.trim(),dataType:'Foundation,SR Legacy',pageSize:limit});
      return {ok:true,provider:'USDA FoodData Central',query,foods:(body.foods??[]).filter(f=>accepted.has(f.dataType)).map(f=>({
        fdcId:f.fdcId, name:f.description, dataType:f.dataType, per100g:extractMacros(f),
        verified:false, note:'Search result only; verify details and preparation state before saving'
      }))};
    },
    async details(fdcId) {
      if (!Number.isSafeInteger(fdcId)||fdcId<=0) throw new Error('Invalid FDC identifier');
      const raw=await request('/food/'+fdcId);
      const macros=extractMacros(raw);
      return {ok:true,provider:'USDA FoodData Central',fdcId:raw.fdcId, name:raw.description,
        dataType:raw.dataType, per100g:macros, unit:'g / 100g',
        usable:!!macros, reasons:macros?[]:['Unsupported data type, incomplete nutrients or invalid mass balance'],
        note:'Confirm identity and raw/cooked state with user; external food is NOT saved automatically'};
    }
  };
}

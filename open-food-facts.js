/** Read-only Open Food Facts lookup: barcode in, source-attributed per-100g macros out.
 * No writes to the local nutrition database: ODbL and source quality remain explicit. */
const BASE='https://world.openfoodfacts.org/api/v2/product/';
export function normalizeBarcode(code){
  if(typeof code!=='string'||!/^[0-9]{8,14}$/.test(code))throw Error('barcode must be 8–14 decimal digits');
  return code; // preserve leading zero UPC/EAN codes
}
export function normalizeProduct(code, data){
  if(!data||data.status!==1||!data.product)return {ok:true,found:false,barcode:code,source:'Open Food Facts'};
  const p=data.product,n=p.nutriments||{};
  const macros={p:n.proteins_100g,c:n.carbohydrates_100g,f:n.fat_100g};
  const valid=Object.values(macros).every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=100)
      &&macros.p+macros.c+macros.f<=100.1;
  const name=(p.product_name||'').trim();
  if(!valid||!name)return {ok:true,found:false,barcode:code,source:'Open Food Facts',reason:'incomplete_product_data'};
  const kcal=n['energy-kcal_100g'];
  return {ok:true,found:true,barcode:code,name,brand:p.brands||null,
    per100g:macros,kcal100g:Number.isFinite(kcal)&&kcal>=0?kcal:null,
    source:'Open Food Facts',external:true,verifiedLocally:false,
    license:'ODbL — https://world.openfoodfacts.org/terms-of-use',
    note:'Crowdsourced packaging values, not a local food ID. Review label/serving before optional add_food_to_library.'};
}
export function createOpenFoodFactsClient({fetchImpl=fetch,timeoutMs=7000}={}){
  return {async lookup(barcode){
    const code=normalizeBarcode(barcode);
    const url=BASE+code+'.json?fields=code,product_name,brands,nutriments';
    const response=await fetchImpl(url,{headers:{'User-Agent':'NutritionTrackerMCP/0.2 (https://github.com/Jasonatafricanow/Nutrition-Tracker-MCP)','Accept':'application/json'},signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok)throw Error('Open Food Facts lookup failed ('+response.status+')');
    return normalizeProduct(code,await response.json());
  }};
}

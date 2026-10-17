import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';
import {createAgentInterface} from '../agent-interface.js';
import {summarizeNutritionExport} from '../health-summary.js';
import {createOpenFoodFactsClient,normalizeBarcode} from '../open-food-facts.js';
const NOW=new Date('2026-10-18T07:00:00+08:00');
function setup(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-usage-'));
  const configPath=path.join(dir,'household.json');
  writeFileSync(configPath,JSON.stringify({timeZone:'Asia/Shanghai',members:[
    {id:'alex',name:'Alex',mode:'performance'},{id:'jo',name:'Jo',mode:'general'}
  ]}));
  const engine=createEngine(path.join(dir,'single.db'),{now:()=>NOW,timeZone:'Asia/Shanghai'});
  const household=createHousehold({configPath,dir,engineFactory:createEngine,now:()=>NOW});
  const api=createAgentInterface({engine,household});
  return {engine,household,api,close(){household.close();engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('one Agent command locates, corrects and audits a recent named meal, retry is idempotent',()=>{
  const t=setup();try{
    const a={mealSlot:'午餐',source:'text',requestId:'lunch',items:[{name:'米饭',weightGrams:150,foodId:'f7'}]};
    t.api.execute({operation:'quick_meal',memberId:'alex',args:a});
    const req={operation:'recent_correction',memberId:'alex',args:{foodName:'米饭',weightGrams:220,requestId:'fix-1'}};
    const first=t.api.execute(req);assert.equal(first.ok,true);assert.equal(first.after.weightGrams,220);
    assert.equal(first.context.memberId,'alex');
    assert.equal(t.api.execute(req).duplicate,true);
    const rows=t.household.memberTool('alex','get_meal_history',{}).meals;
    assert.equal(rows.length,1);assert.equal(rows[0].weight_g,220);assert.equal(rows[0].revision,1);
    assert.equal(t.household.memberTool('alex','get_meal_corrections',{mealId:rows[0].id}).corrections.length,1);
    assert.throws(()=>t.api.execute({...req,args:{...req.args,weightGrams:230}}),/requestId/);
    assert.equal(t.household.memberTool('jo','get_meal_history',{}).meals.length,0);
  }finally{t.close();}
});
test('uncertain duplicate name does not silently change the wrong entry; yesterday fallback works',()=>{
 const t=setup();try{
   t.api.execute({memberId:'jo',operation:'quick_meal',args:{mealSlot:'早餐',source:'text',requestId:'rice-one',
      items:[{name:'米饭',weightGrams:100,foodId:'f7'}]}});
   t.api.execute({memberId:'jo',operation:'quick_meal',args:{mealSlot:'午餐',source:'text',requestId:'rice-two',
      items:[{name:'米饭',weightGrams:160,foodId:'f7'}]}});
   assert.throws(()=>t.api.execute({memberId:'jo',operation:'recent_correction',
     args:{foodName:'米饭',weightGrams:200,requestId:'ambiguous'}}),/多条同名/);
   const result=t.api.execute({memberId:'jo',operation:'recent_correction',
     args:{foodName:'米饭',mealSlot:'午餐',weightGrams:200,requestId:'specific'}});
   assert.equal(result.after.weightGrams,200);
   t.api.execute({memberId:'jo',operation:'quick_meal',args:{date:'2026-10-17',mealSlot:'晚餐',
     source:'text',requestId:'older-dinner',items:[{name:'香蕉',weightGrams:100,p:1,c:23,f:0.2}]}});
   const older=t.api.execute({memberId:'jo',operation:'recent_correction',args:{foodName:'香蕉',weightGrams:120,requestId:'older-fix'}});
   assert.equal(older.after.weightGrams,120);
 }finally{t.close();}
});
test('existing templates become reusable household recipe candidates without new kitchen tables',async()=>{
 const t=setup();try{
  t.api.execute({memberId:'alex',operation:'meal',args:{mealSlot:'晚餐',requestId:'dinner',
    items:[{foodId:'f7',weightGrams:150},{foodId:'f2',weightGrams:130}]}});
  const saved=t.api.execute({memberId:'alex',operation:'template_save',args:{name:'家庭鸡肉饭',mealSlot:'晚餐'}});
  const r=await t.api.query({view:'family_recipes',query:'鸡肉'});
  assert.equal(r.recipes.length,1);
  assert.equal(r.recipes[0].sourceMemberId,'alex');
  assert.equal(r.recipes[0].templateId,saved.templateId);
  assert.equal(r.recipes[0].items.length,2);
  // A general household member gets recipe access but no performance carb quotas.
  const general=await t.api.query({view:'household',focus:'food'});
  assert.equal(general.members[1].nutrition,undefined);
 }finally{t.close();}
});
test('weekly and monthly reports count observed dates without treating unlogged days as zero',async()=>{
 const t=setup();try{
  t.api.execute({memberId:'jo',operation:'quick_meal',args:{mealSlot:'早餐',source:'text',
    requestId:'report-one',items:[{name:'米饭',foodId:'f7',weightGrams:120}]}});
  t.api.execute({memberId:'jo',operation:'checkin',args:{sleepHours:6.5,rhrBpm:61}});
  const week=await t.api.query({view:'report',memberId:'jo',days:7});
  const month=await t.api.query({view:'report',memberId:'jo',days:30});
  assert.equal(week.periodDays,7);assert.equal(month.periodDays,30);
  assert.equal(week.nutrition.daysWithMeals,1);assert.equal(week.nutrition.estimatedItems,1);
  assert.equal(week.health.sleepDays,1);assert.equal(week.health.averageSleepHours,6.5);
  assert.ok(week.nutrition.meanKcalOnLoggedDays>0);
  assert.equal(month.nutrition.daysWithMeals,1);
  await assert.rejects(t.api.query({view:'report',memberId:'jo',days:14}),/7 or 30/);
 }finally{t.close();}
});
test('report math separates missing observations, estimated meals and measured values',()=>{
 const r=summarizeNutritionExport({fromDate:'2026-10-12',toDate:'2026-10-18',ledger:[
   {date:'2026-10-16',intake_kcal:1200,sleep_hours:6,scale_weight_kg:72,rhr_bpm:65,intake_complete:0},
   {date:'2026-10-18',intake_kcal:1800,sleep_hours:8,scale_weight_kg:71.5,rhr_bpm:null,intake_complete:1}
 ],meals:[{date:'2026-10-18',source_kind:'agent_text_estimate'}]},7);
 assert.equal(r.nutrition.daysWithMeals,1);
 assert.equal(r.nutrition.meanKcalOnLoggedDays,1800);
 assert.equal(r.health.averageSleepHours,7);
 assert.equal(r.health.rhrDays,1);
 assert.equal(r.health.weightChangeKg,-0.5);
});
test('barcode lookup validates user input and surfaces only complete, source-attributed products',async()=>{
 const samples=[];const client=createOpenFoodFactsClient({fetchImpl:async(url,opts)=>{
   samples.push({url,opts});return {ok:true,json:async()=>({status:1,product:{
     product_name:'Plain biscuits',brands:'Example',nutriments:{proteins_100g:7,carbohydrates_100g:65,fat_100g:18,'energy-kcal_100g':450}
   }})};
 }});
 const barcode='0123456789012';
 const good=await client.lookup(barcode);
 assert.equal(good.barcode,barcode);assert.equal(good.per100g.c,65);
 assert.equal(good.external,true);assert.equal(good.verifiedLocally,false);
 assert.ok(samples[0].url.includes(barcode));
 assert.ok(samples[0].opts.headers['User-Agent'].includes('NutritionTrackerMCP'));
 for(const bad of ['','123','a12345678','0'.repeat(22),'1234567?']){
   assert.throws(()=>normalizeBarcode(bad),/barcode/);
 }
 const missing=createOpenFoodFactsClient({fetchImpl:async()=>({ok:true,json:async()=>({status:1,product:{product_name:'Incomplete',nutriments:{}}})})});
 assert.equal((await missing.lookup('12345678')).found,false);
 const invalid=createOpenFoodFactsClient({fetchImpl:async()=>({ok:true,json:async()=>({status:1,product:{product_name:'Bad',nutriments:{proteins_100g:60,carbohydrates_100g:80,fat_100g:10}}})})});
 assert.equal((await invalid.lookup('12345678')).found,false);
});

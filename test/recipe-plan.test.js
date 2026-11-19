import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from '../engine.js';
import {createAgentInterface} from '../agent-interface.js';
import {createEverydayInterface} from '../everyday-interface.js';

const NOW=new Date('2026-11-15T03:00:00Z'); // 2026-11-15 Shanghai, Sunday
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'nutrition-recipe-'));
 const engine=createEngine(path.join(dir,'r.db'),{now:()=>NOW,timeZone:'Asia/Shanghai'});
 const api=createEverydayInterface(createAgentInterface({engine}));
 return {api,engine,close(){engine.close();rmSync(dir,{recursive:true,force:true})}};
}
const run=(api,operation,args)=>api.execute({operation,args});

test('recipe -> plan -> shopping -> log one meal, through the everyday surface',async()=>{
 const f=fixture();try{
  const bowl=run(f.api,'recipe_save',{name:'鸡胸饭',servings:2,requestId:'r1',
    items:[{foodId:'f1',weightGrams:300},{foodId:'f7',weightGrams:400},{foodId:'f11',weightGrams:10}],
    steps:['鸡胸煎熟','配饭']}).recipe;
  // per serving: 150g chicken + 200g rice + 5g oil
  assert.equal(bowl.perServing.p,round(24*1.5+2.6*2));
  assert.equal(bowl.perServing.grams,355);
  const oats=run(f.api,'recipe_save',{name:'燕麦牛奶',servings:1,
    items:[{foodId:'f6',weightGrams:50},{foodId:'f14',weightGrams:250}]}).recipe;
  assert.equal(run(f.api,'recipe_save',{name:'鸡胸饭',servings:2,requestId:'r1',
    items:[{foodId:'f1',weightGrams:300},{foodId:'f7',weightGrams:400},{foodId:'f11',weightGrams:10}],
    steps:['鸡胸煎熟','配饭']}).duplicate,true);
  assert.throws(()=>run(f.api,'recipe_save',{name:'x',servings:1,items:[{foodId:'nope',weightGrams:1}]}),/食材库没有/);

  const listed=await f.api.query({view:'recipes',query:'鸡'});
  assert.equal(listed.recipes.length,1);

  const lunch=run(f.api,'plan_set',{date:'2026-11-15',mealSlot:'午餐',recipeId:bowl.recipeId,servings:1});
  run(f.api,'plan_set',{date:'2026-11-15',mealSlot:'早餐',recipeId:oats.recipeId,servings:1});
  run(f.api,'plan_set',{date:'2026-11-16',mealSlot:'晚餐',recipeId:bowl.recipeId,servings:1.5});
  const plan=await f.api.query({view:'plan',fromDate:'2026-11-15',toDate:'2026-11-16'});
  assert.equal(plan.days.length,2);
  assert.deepEqual(plan.days[0].entries.map(e=>e.mealSlot),['早餐','午餐']);
  assert.equal(plan.days[0].target.basis,'ledger');
  assert.equal(plan.days[1].target.basis,'weekly_schedule');
  assert.equal(plan.days[0].gap.kcal,plan.days[0].target.kcal-plan.days[0].projected.kcal);

  const shop=await f.api.query({view:'shopping',fromDate:'2026-11-15',toDate:'2026-11-16'});
  const chicken=shop.items.find(i=>i.foodId==='f1');
  assert.equal(chicken.totalGrams,375); // 150 + 225, merged across two entries
  assert.equal(shop.items.find(i=>i.foodId==='f7').libraryWeightIsCooked,true);

  assert.throws(()=>run(f.api,'plan_log',{entryId:plan.days[1].entries[0].entryId,requestId:'future'}),/未来日期/);
  const logged=run(f.api,'plan_log',{entryId:lunch.entryId,requestId:'eat-1'});
  assert.equal(logged.mealIds.length,3);
  assert.deepEqual(logged.items.map(i=>i.w),[150,200,5]);
  assert.equal(run(f.api,'plan_log',{entryId:lunch.entryId,requestId:'eat-1'}).duplicate,true);
  assert.throws(()=>run(f.api,'plan_log',{entryId:lunch.entryId,requestId:'eat-2'}),/已经记入账本/);
  assert.throws(()=>run(f.api,'plan_remove',{entryId:lunch.entryId}),/已记入账本/);
  const meals=await f.api.query({view:'meals'});
  assert.equal(meals.meals.length,3);
  assert.ok(meals.meals.every(m=>m.source_kind==='recipe_plan'));

  const after=await f.api.query({view:'plan',fromDate:'2026-11-15'});
  assert.equal(after.days[0].entries.find(e=>e.entryId===lunch.entryId).status,'logged');
  assert.equal(after.days[0].loggedIntake.kcal,logged.dayIntakeKcal);
  const shop2=await f.api.query({view:'shopping',fromDate:'2026-11-15',toDate:'2026-11-16'});
  assert.equal(shop2.items.find(i=>i.foodId==='f1').totalGrams,225); // logged entry no longer to buy
 }finally{f.close()}
});

function round(v){return Math.round(v*10)/10}

test('food_add searches similar foods first, then adds only distinct reviewed entries, with daily cap',async()=>{
 const f=fixture();try{
  const add=(extra)=>run(f.api,'food_add',{name:'番茄',aliases:['西红柿'],state:'raw',p:0.9,c:3.9,f:0.2,
    dataSource:'中国食物成分表 番茄',...extra});
  assert.throws(()=>run(f.api,'food_add',{name:'番茄',state:'raw',p:1,c:4,f:0,requestId:'nos'}),/dataSource/);
  const first=add({requestId:'t1'});
  assert.equal(first.added,true);
  assert.match(first.name,/番茄\/西红柿\(生重\) · 中国食物成分表/);
  // Synonym: same food, same state -> hard duplicate, cannot be overridden.
  const dup=run(f.api,'food_add',{name:'西红柿',state:'raw',p:1,c:4,f:0.2,dataSource:'USDA 170457',requestId:'t2',confirmDistinct:true,reviewedCandidateIds:[first.foodId]});
  assert.equal(dup.added,false);assert.equal(dup.reason,'duplicate');assert.equal(dup.existing.foodId,first.foodId);
  // Similar name (contains 鸡蛋 / 全鸡蛋 seed) -> blocked until reviewed and declared distinct.
  const egg={name:'鸡蛋饼',state:'as_sold',p:7,c:30,f:10,dataSource:'中国食物成分表 鸡蛋饼'};
  const blocked=run(f.api,'food_add',{...egg,requestId:'e1'});
  assert.equal(blocked.reason,'similar_foods_found');
  const ids=blocked.candidates.map(c=>c.foodId);assert.ok(ids.includes('f4'));
  assert.equal(run(f.api,'food_add',{...egg,requestId:'e2',confirmDistinct:true}).added,false);
  const ok=run(f.api,'food_add',{...egg,requestId:'e3',confirmDistinct:true,reviewedCandidateIds:ids});
  assert.equal(ok.added,true);
  const found=await f.api.query({view:'foods',queries:['番茄']});
  assert.equal(found.results[0].foods[0].id,first.foodId);
  const rec=run(f.api,'recipe_save',{name:'番茄炒蛋',servings:2,items:[{foodId:'f4',weightGrams:150},{foodId:first.foodId,weightGrams:300}]});
  assert.ok(rec.recipe.perServing.kcal>0);
  // Two added so far today; eight more reach the cap of 10, the 11th is refused.
  const names=['芦笋','秋葵','荸荠','山药','莲子','芋头','菱角','茭白','慈姑'];
  const addDistinct=(name,k)=>{
    const base={name,state:'raw',p:1,c:5,f:0.1,dataSource:'unit test source',confirmDistinct:true};
    const r=run(f.api,'food_add',{...base,requestId:'cap-'+k});
    return r.reason==='similar_foods_found'?run(f.api,'food_add',{...base,requestId:'cap2-'+k,reviewedCandidateIds:r.candidates.map(c=>c.foodId)}):r;
  };
  for(let k=0;k<8;k++)assert.equal(addDistinct(names[k],k).added,true,names[k]);
  assert.throws(()=>addDistinct(names[8],8),/每日上限 10/);
 }finally{f.close()}
});

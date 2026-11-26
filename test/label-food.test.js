import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';
import {createAgentInterface} from '../agent-interface.js';
import {createEverydayInterface} from '../everyday-interface.js';

// Package nutrition labels: the label energy is what gets booked, the food is the household's (like the fridge),
// intake stays per member. Photo/text estimates keep the old 4/4/9 path untouched.
const NOW=()=>new Date('2026-11-22T04:00:00Z');
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'label-food-'));
 const cfg=path.join(dir,'household.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',primary:'owner',members:[
  {id:'owner',name:'Owner',mode:'performance'},{id:'gao',name:'Gao',mode:'general'},{id:'kid',name:'Kid',mode:'general'}]}));
 const engine=createEngine(path.join(dir,'nutrition.db'),{now:NOW,timeZone:'Asia/Shanghai'});
 const family=createHousehold({configPath:cfg,dir:path.join(dir,'household'),engineFactory:createEngine,primaryEngine:engine,now:NOW});
 const api=createEverydayInterface(createAgentInterface({engine,household:family}));
 return {engine,family,api,close(){family.close();engine.close();try{rmSync(dir,{recursive:true,force:true});}catch{}}};
}
// 康师傅 大食袋 115g: per 100g 2056 kJ (491 kcal); the macros alone would say 477.
const NOODLE={brand:'康师傅',name:'红烧牛肉面',variant:'大食袋',aliases:['大盒面'],netAmount:115,energyKj:2056,p:9,c:62.4,f:21.3,barcode:'6900873000017'};
const addLabel=(api,label,requestId,memberId='owner')=>api.execute({memberId,operation:'food_add',args:{label,requestId}});
const meal=(api,memberId,items,requestId)=>api.execute({memberId,operation:'meal',args:{mealSlot:'午餐',source:'text',requestId,items}});
const foods=async(api,memberId,q)=>(await api.query({view:'foods',memberId,queries:[q]})).results[0].foods;
const intake=(family,memberId)=>family.memberTool(memberId,'get_meal_history',{}).intakeKcal;

test('label energy is booked: whole box 565 kcal, half box 283 kcal',()=>{
 const f=fixture();
 try{
  const added=addLabel(f.api,NOODLE,'lbl-1');
  assert.equal(added.added,true);
  assert.equal(added.food.kcal,491);
  assert.equal(added.food.kcalFrom,'label');
  assert.equal(added.food.name,'康师傅红烧牛肉面 大食袋 115g');
  const id=added.food.id;
  meal(f.api,'owner',[{name:'大盒面',foodId:id,weightGrams:115}],'m-1');
  assert.equal(intake(f.family,'owner'),565);
  meal(f.api,'gao',[{name:'大盒面',foodId:id,weightGrams:57.5}],'m-2');
  assert.equal(intake(f.family,'gao'),283);
  assert.equal(intake(f.family,'owner'),565,'intake stays per member');
 }finally{f.close();}
});

test('the same label again returns the existing food; a retry does not add twice',()=>{
 const f=fixture();
 try{
  const first=addLabel(f.api,NOODLE,'lbl-1');
  assert.equal(addLabel(f.api,NOODLE,'lbl-1').duplicate,true);
  const again=addLabel(f.api,{...NOODLE,barcode:undefined},'lbl-2'); // same brand/name/variant/net, no barcode this time
  assert.equal(again.added,false);
  assert.equal(again.existing.id,first.food.id);
  const byCode=addLabel(f.api,{...NOODLE,name:'红烧牛肉面（新包装）'},'lbl-3');
  assert.equal(byCode.existing.id,first.food.id,'barcode match wins');
  assert.equal(f.engine.labelFoods().length,1);
 }finally{f.close();}
});

test('a different size of the same product is its own entry',()=>{
 const f=fixture();
 try{
  const big=addLabel(f.api,NOODLE,'lbl-1');
  const small=addLabel(f.api,{...NOODLE,variant:'',netAmount:85,barcode:undefined},'lbl-2');
  assert.equal(small.added,true);
  assert.notEqual(small.food.id,big.food.id);
  assert.deepEqual(small.otherSpecs.map(x=>x.foodId),[big.food.id]);
 }finally{f.close();}
});

test('label foods are shared by the household, also with a member opened later',async()=>{
 const f=fixture();
 try{
  const id=addLabel(f.api,NOODLE,'lbl-1','gao').food.id; // recorded while talking about gao
  for(const m of ['owner','gao','kid']){
   const hit=(await foods(f.api,m,'大盒面')).find(x=>x.id===id);
   assert.ok(hit,`${m} finds it by alias`);
   assert.equal(hit.kcal,491);
  }
 }finally{f.close();}
});

test('"那个面": label noodle and home-cooked noodle are told apart in search',async()=>{
 const f=fixture();
 try{
  f.engine.execute('add_food_to_library',{name:'家里煮的面条(熟)',p:5.8,c:30.9,f:0.9},'TEST');
  const id=addLabel(f.api,NOODLE,'lbl-1').food.id;
  const hits=await foods(f.api,'owner','面');
  const label=hits.filter(x=>x.kcalFrom==='label');
  assert.deepEqual(label.map(x=>x.id),[id]);
  assert.equal(label[0].label.netAmount,115);
  assert.ok(hits.some(x=>x.name.startsWith('家里煮的面条')&&!x.label));
 }finally{f.close();}
});

test('earlier meals keep the numbers they were booked with',()=>{
 const f=fixture();
 try{
  meal(f.api,'owner',[{name:'那个面（估）',weightGrams:115,p:10,c:70,f:20}],'m-0'); // before the label was recorded
  const before=intake(f.family,'owner');
  addLabel(f.api,NOODLE,'lbl-1');
  assert.equal(intake(f.family,'owner'),before);
  assert.equal(before,Math.round(10*4+70*4+20*9));
 }finally{f.close();}
});

test('a correction scales the booked label energy, not the macros',()=>{
 const f=fixture();
 try{
  const id=addLabel(f.api,NOODLE,'lbl-1').food.id;
  meal(f.api,'owner',[{name:'大盒面',foodId:id,weightGrams:115}],'m-1');
  f.api.execute({memberId:'owner',operation:'correct',args:{foodName:'大盒面',weightGrams:57.5,requestId:'c-1'}});
  assert.equal(intake(f.family,'owner'),283);
 }finally{f.close();}
});

test('misread labels are refused and nothing is written',()=>{
 const f=fixture();
 try{
  assert.throws(()=>addLabel(f.api,{...NOODLE,energyKj:491},'bad-1'),/kJ/);          // kcal typed as kJ
  assert.throws(()=>addLabel(f.api,{...NOODLE,energyKj:undefined},'bad-2'),/energyKj/); // no energy at all
  assert.throws(()=>addLabel(f.api,{...NOODLE,basis:'perServing'},'bad-3'),/servingAmount/);
  assert.equal(f.engine.labelFoods().length,0);
 }finally{f.close();}
});

test('per-serving labels and drinks per 100 mL',()=>{
 const f=fixture();
 try{
  // 每份 30g：480 kJ, P 2 C 18 F 5 → per 100g 1600 kJ = 382 kcal
  const biscuit=addLabel(f.api,{brand:'某牌',name:'苏打饼干',basis:'perServing',servingAmount:30,energyKj:480,p:2,c:18,f:5},'lbl-b');
  assert.equal(biscuit.food.kcal,382);
  assert.equal(biscuit.food.c,60);
  const milk=addLabel(f.api,{brand:'某牌',name:'纯牛奶',unit:'ml',netAmount:250,energyKj:271,p:3.2,c:4.8,f:3.6},'lbl-m');
  assert.equal(milk.food.unit,'ml');
  assert.equal(milk.food.name,'某牌纯牛奶 250mL');
  meal(f.api,'kid',[{name:'牛奶',foodId:milk.food.id,weightGrams:250}],'m-k');
  assert.equal(intake(f.family,'kid'),162);
 }finally{f.close();}
});

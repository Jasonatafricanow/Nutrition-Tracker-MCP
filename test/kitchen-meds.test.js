import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';
import {createAgentInterface} from '../agent-interface.js';
import {createEverydayInterface} from '../everyday-interface.js';

// Task book items 2 and 3: fridge → menu → shopping/timeline, and medicine cabinet → doses → symptom timeline.
// All test data is made up; it never goes near a real database.
const NOW=()=>new Date('2026-11-22T09:00:00Z'); // 17:00 Beijing
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'kitchen-'));
 const cfg=path.join(dir,'household.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',primary:'owner',members:[
  {id:'owner',name:'Owner',mode:'performance'},{id:'gao',name:'Gao',mode:'general'},{id:'kid',name:'Kid',mode:'general'}]}));
 const engine=createEngine(path.join(dir,'nutrition.db'),{now:NOW,timeZone:'Asia/Shanghai'});
 const family=createHousehold({configPath:cfg,dir:path.join(dir,'household'),engineFactory:createEngine,primaryEngine:engine,now:NOW});
 const api=createEverydayInterface(createAgentInterface({engine,household:family}));
 return {engine,family,api,x:(memberId,operation,args)=>api.execute({memberId,operation,args}),
  close(){family.close();engine.close();try{rmSync(dir,{recursive:true,force:true});}catch{}}};
}
const meals=async(f,m)=>(await f.api.query({view:'meals',memberId:m})).meals;

test('croissants: 150 g ÷ 6 per piece; a receipt is not a meal and a meal does not move the fridge',async()=>{
 const f=fixture();
 try{
  const label={brand:'某牌',name:'小可颂',pieces:6,netAmount:150,energyKj:1800,p:8,c:48,f:22};
  const food=f.x('owner','food_add',{label,requestId:'lbl-c'}).food;
  assert.equal(food.label.pieceAmount,25);
  const add=f.x('owner','pantry',{action:'add',source:'receipt',items:[{name:'小可颂',quantity:'6个',foodId:food.id}],requestId:'rc-1'});
  assert.equal(add.added[0].foodId,food.id);
  assert.equal((await meals(f,'owner')).length,0,'a receipt books nothing');
  const m=f.x('owner','meal',{mealSlot:'早餐',items:[{name:'小可颂',foodId:food.id,weightGrams:25}],requestId:'m-c'});
  assert.equal(f.x('owner','meal',{mealSlot:'早餐',items:[{name:'小可颂',foodId:food.id,weightGrams:25}],requestId:'m-c'}).duplicate,true);
  assert.equal(m.mealIds.length,1);
  const p=await f.api.query({view:'pantry'});
  assert.equal(p.items[0].quantity,'6个','one eaten does not set the stock to 5 — someone else may have had some');
  assert.equal(f.x('owner','pantry',{action:'add',source:'receipt',items:[{name:'小可颂',quantity:'6个'}],requestId:'rc-1'}).duplicate,true);
  assert.equal((await f.api.query({view:'pantry'})).count,1);
  assert.throws(()=>f.x('owner','pantry',{action:'add',items:[{name:'小可颂',foodId:'no-such-food'}],requestId:'rc-2'}),/食品库里没有/);
 }finally{f.close();}
});

// Two adults and a kid, four dishes and a soup, 冬瓜汤 asked for by name.
const dish=(name,kind,ingredients,cookMin,more={})=>({name,kind,ingredients:ingredients.map(n=>typeof n==='string'?{name:n}:n),
 prepMin:10,cookMin,heat:'中火',seasoning:'先盐后酱油',doneness:'筷子能扎透',...more});
const MENU=[
 dish('红烧排骨','荤',['排骨','姜','生抽','冰糖'],40),
 dish('蒜蓉西兰花','素',['西兰花','蒜'],5),
 dish('青椒炒肉片','荤',['五花肉','青椒'],8),
 dish('凉拌黄瓜','凉菜',['黄瓜','醋'],0,{appliance:'无'}),
 dish('冬瓜虾皮汤','汤',['冬瓜','虾皮'],25),
];
function stockKitchen(f){
 f.x('owner','pantry',{action:'add',source:'receipt',requestId:'k-1',items:[
  {name:'冬瓜',quantity:'半个'},{name:'排骨',quantity:'500g',shelfLifeDays:1},{name:'五花肉',quantity:'300g'},
  {name:'西兰花',quantity:'1颗'},{name:'番薯',quantity:'3个'},{name:'黄瓜',quantity:'2根'}]});
 f.x('owner','pantry',{action:'use',name:'黄瓜',remaining:'用完了',requestId:'k-2'});
 f.x('owner','meal',{mealSlot:'晚餐',date:'2026-11-21',items:[{name:'番茄炒蛋',weightGrams:200,p:6,c:4,f:8}],requestId:'k-3'});
 f.x('owner','kitchen_pref',{action:'add',kind:'avoid_main',text:'番薯',requestId:'k-4'});
 f.x('owner','kitchen_pref',{action:'add',kind:'not_default',text:'鲈鱼',requestId:'k-5'});
}

test('a menu from the fridge: asked shape, what to buy / check at home, stove order; a draft moves nothing',async()=>{
 const f=fixture();
 try{
  stockKitchen(f);
  const k=await f.api.query({view:'kitchen'});
  assert.ok(k.recentDishes.some(d=>d.name==='番茄炒蛋'));
  assert.deepEqual(k.prefs.map(p=>p.text),['番薯','鲈鱼']);
  assert.ok(k.recentlyGone.some(g=>g.name==='黄瓜'));
  const before=(await f.api.query({view:'pantry'})).items;
  const r=f.x('owner','menu',{action:'draft',diners:'两大一小',serveAt:'18:30',burners:4,want:{dishes:4,soups:1,must:['冬瓜']},dishes:MENU,requestId:'menu-1'});
  assert.deepEqual(r.warnings,[]);
  assert.ok(r.shopping.buy.some(l=>l.name==='黄瓜'),'used up lately → buy');
  assert.ok(r.shopping.checkAtHome.some(l=>l.name==='青椒'),'never recorded → unknown, check at home');
  assert.ok(r.shopping.checkAtHome.some(l=>l.name==='虾皮'));
  assert.ok(r.shopping.have.some(l=>l.name==='冬瓜'&&l.quantity==='半个'));
  assert.ok(!r.dishes.some(d=>d.name.includes('番薯')));
  assert.ok(r.shopping.expiringNotUsed.every(x=>x.name!=='排骨'),'the expiring ribs are used');
  assert.equal(r.timeline.steps.find(s=>s.what.startsWith('上灶')).what,'上灶：红烧排骨（约 40 分钟）');
  assert.equal(r.timeline.steps.at(-1).at,'18:30');
  assert.equal(r.timeline.startPrepAt,'17:40'); // one person preps, each dish ready right before its own fire
  assert.deepEqual((await f.api.query({view:'pantry'})).items,before,'a draft takes nothing out of the fridge');
  assert.equal((await meals(f,'owner')).length,0);
  assert.equal(f.x('owner','menu',{action:'draft',dishes:MENU,requestId:'menu-1'}).duplicate,true);
 }finally{f.close();}
});

test('swap one meat dish for a vegetable one: only that dish, its shopping and the timeline change',async()=>{
 const f=fixture();
 try{
  stockKitchen(f);
  const r=f.x('owner','menu',{action:'draft',burners:4,want:{dishes:4,soups:1,must:['冬瓜']},dishes:MENU,requestId:'menu-1'});
  const target=r.dishes.find(d=>d.name==='青椒炒肉片');
  const s=f.x('owner','menu',{action:'swap',menuId:r.menuId,dishId:target.id,requestId:'sw-1',
   dish:dish('清炒豆角','素',['豆角','蒜'],8)});
  assert.deepEqual(s.dishes.filter(d=>d.id!==target.id&&d.name!=='清炒豆角'),r.dishes.filter(d=>d.id!==target.id),'the other dishes are untouched');
  assert.equal(s.dishes.findIndex(d=>d.name==='清炒豆角'),r.dishes.findIndex(d=>d.id===target.id),'same place in the menu');
  assert.ok(!s.shopping.checkAtHome.some(l=>l.name==='青椒'));
  assert.ok(s.shopping.checkAtHome.some(l=>l.name==='豆角'));
  assert.equal(s.dishes.filter(d=>d.kind==='荤').length,1);
 }finally{f.close();}
});

test('warnings: a recent repeat, 番薯 as a main dish, an unasked 鲈鱼, a missing must-have, too few burners',async()=>{
 const f=fixture();
 try{
  stockKitchen(f);
  const r=f.x('owner','menu',{action:'draft',burners:2,want:{dishes:4,soups:1,must:['冬瓜']},requestId:'menu-w',dishes:[
   dish('番茄炒蛋','荤',['番茄','鸡蛋'],5),dish('红烧番薯','素',['番薯'],20),dish('清蒸鲈鱼','荤',['鲈鱼'],12,{appliance:'蒸锅'}),
   dish('蒜蓉西兰花','素',['西兰花'],5),dish('紫菜蛋花汤','汤',['紫菜','鸡蛋'],10)]});
  const w=r.warnings.join('\n');
  assert.match(w,/番茄炒蛋.*刚吃过/);
  assert.match(w,/番薯不做正菜/);
  assert.match(w,/不默认上鲈鱼/);
  assert.match(w,/冬瓜.*不在菜单里/);
  assert.match(w,/灶眼/);
 }finally{f.close();}
});

test('a broken dish writes nothing; confirm and cooked keep the ledger and fridge apart',async()=>{
 const f=fixture();
 try{
  stockKitchen(f);
  assert.throws(()=>f.x('owner','menu',{action:'draft',requestId:'bad-1',dishes:[{name:'红烧肉',kind:'荤',ingredients:[{name:'五花肉'}],cookMin:60}]}),/heat/);
  assert.equal((await f.api.query({view:'kitchen'})).openMenus.length,0);
  const r=f.x('owner','menu',{action:'draft',burners:4,dishes:MENU,requestId:'menu-1'});
  assert.throws(()=>f.x('owner','menu',{action:'confirm',menuId:r.menuId,plan:[{memberId:'owner',dishId:'d1',servings:1}],requestId:'c-0'}),/没有存过菜谱/);
  assert.equal(f.x('owner','menu',{action:'confirm',menuId:r.menuId,requestId:'c-1'}).status,'confirmed');
  const done=f.x('owner','menu',{action:'cooked',menuId:r.menuId,requestId:'c-2'});
  assert.equal(done.status,'cooked');
  assert.equal((await meals(f,'owner')).length,0,'cooking books nobody');
  const ribs=(await f.api.query({view:'pantry'})).items.find(i=>i.name==='排骨');
  assert.equal(ribs.quantity,'500g（做红烧排骨用过，剩多少待确认）','no amount on the dish: unknown, not zero, not a guess');
  assert.ok(done.pantry.toCheck.some(x=>x.name==='排骨'));
  assert.ok((await f.api.query({view:'kitchen'})).recentDishes.some(d=>d.name==='红烧排骨'&&d.from==='menu'));
 }finally{f.close();}
});

test('cooked: the dishes made take what they used out of the fridge, once; dishes not made take nothing',async()=>{
 const f=fixture();
 try{
  f.x('owner','pantry',{action:'add',requestId:'s-1',items:[{name:'排骨',quantity:'1斤'},{name:'五花肉',quantity:'300g'},{name:'鸡蛋',quantity:'10个'},
   {name:'青椒',quantity:'3个'},{name:'西兰花',quantity:'1颗'}]});
  const amt=(n,a)=>({name:n,amount:a});
  const r=f.x('owner','menu',{action:'draft',requestId:'m-1',dishes:[
   dish('红烧排骨','荤',[amt('排骨','300g'),amt('生抽','2勺')],40),dish('青椒炒肉片','荤',[amt('五花肉','300克'),amt('青椒','2个')],8),
   dish('番茄炒蛋','荤',[amt('鸡蛋','3个'),amt('番茄','2个')],5),dish('蒜蓉西兰花','素',[amt('西兰花','一把')],5)]});
  const id=n=>r.dishes.find(d=>d.name===n).id;
  // "今天做了排骨、青椒肉片和西兰花" — not the eggs.
  const c=f.x('owner','menu',{action:'cooked',menuId:r.menuId,dishIds:[id('红烧排骨'),id('青椒炒肉片'),id('蒜蓉西兰花')],requestId:'c-1',by:'tester'});
  const p=Object.fromEntries((await f.api.query({view:'pantry'})).items.map(i=>[i.name,i.quantity]));
  assert.equal(p['排骨'],'200g','1斤 − 300g');
  assert.equal(p['五花肉'],undefined,'300g − 300克 = used up');
  assert.equal(p['青椒'],'1个');
  assert.equal(p['鸡蛋'],'10个','the eggs were not cooked');
  assert.match(p['西兰花'],/待确认/,'一把 of 1颗 cannot be subtracted');
  assert.deepEqual(c.pantry.usedUp.map(x=>x.name),['五花肉']);
  assert.ok(!(await f.api.query({view:'kitchen'})).recentDishes.some(d=>d.name==='番茄炒蛋'),'not made, not a recent dish');
  assert.equal(f.x('owner','menu',{action:'cooked',menuId:r.menuId,requestId:'c-1'}).duplicate,true);
  assert.equal((await f.api.query({view:'pantry'})).items.find(i=>i.name==='排骨').quantity,'200g','a retry takes nothing twice');
  // Cooked without a menu, from a sentence.
  f.x('owner','menu',{action:'cooked',requestId:'c-2',dishes:[dish('蒸蛋','荤',[amt('鸡蛋','2个')],10)]});
  assert.equal((await f.api.query({view:'pantry'})).items.find(i=>i.name==='鸡蛋').quantity,'8个');
  assert.equal((await meals(f,'owner')).length,0,'cooking books nobody');
 }finally{f.close();}
});

test('cookbook: a dish the user approved is kept, comes back whole in a later menu, and counts when cooked',async()=>{
 const f=fixture();
 try{
  const r=f.x('owner','menu',{action:'draft',requestId:'m-1',dishes:[dish('可乐鸡翅','荤',[{name:'鸡翅',amount:'500g'},{name:'可乐',amount:'1罐'}],25,{steps:['焯水','煎到两面金黄','加可乐收汁']})]});
  const s=f.x('owner','kitchen_recipe',{action:'save',menuId:r.menuId,dishId:'d1',requestId:'kr-1'});
  assert.equal(s.recipe.name,'可乐鸡翅');
  assert.deepEqual(s.recipe.steps,['焯水','煎到两面金黄','加可乐收汁']);
  assert.throws(()=>f.x('owner','kitchen_recipe',{action:'save',menuId:r.menuId,dishId:'d1',requestId:'kr-2'}),/已有同名菜谱/);
  const book=await f.api.query({view:'cookbook'});
  assert.equal(book.count,1);
  assert.deepEqual((await f.api.query({view:'kitchen'})).cookbook.map(x=>x.name),['可乐鸡翅']);
  const m2=f.x('owner','menu',{action:'draft',requestId:'m-2',dishes:[{fromRecipe:s.recipe.recipeId,cookMin:30}]});
  assert.equal(m2.dishes[0].heat,'中火');
  assert.equal(m2.dishes[0].cookMin,30,'a field given next to fromRecipe overrides it');
  f.x('owner','menu',{action:'cooked',menuId:m2.menuId,requestId:'c-1'});
  const one=await f.api.query({view:'cookbook',recipeId:s.recipe.recipeId});
  assert.equal(one.recipe.timesCooked,1);
  const changed=f.x('owner','kitchen_recipe',{action:'save',recipeId:s.recipe.recipeId,dish:{...dish('可乐鸡翅','荤',[{name:'鸡翅'}],20)},requestId:'kr-3'});
  assert.equal(changed.updated,true);
  f.x('owner','kitchen_recipe',{action:'remove',recipeId:s.recipe.recipeId,requestId:'kr-4'});
  assert.equal((await f.api.query({view:'cookbook'})).count,0);
 }finally{f.close();}
});

// ---------- medicine cabinet → doses → symptoms ----------
const sb=(f)=>f.family.stock; // what the statebar webhooks call
function cabinet(f){
 f.x('owner','med',{name:'布洛芬片',ingredient:'布洛芬',strength:'0.2g',form:'普通',dose:'1片',minIntervalHours:6,maxPerDay:4,ruleSource:'说明书',expiresOn:'2027-03',requestId:'med-1'});
 f.x('owner','med',{name:'布洛芬缓释胶囊',ingredient:'布洛芬',strength:'0.3g',form:'缓释',dose:'1粒',minIntervalHours:12,maxPerDay:2,ruleSource:'说明书',requestId:'med-2'});
}

test('cabinet → sore throat → a dose taken → no longer sore: saved boxes are not doses, nothing is inferred',async()=>{
 const f=fixture();
 try{
  cabinet(f);
  const cab=(await f.api.query({view:'meds'})).cabinet;
  assert.equal(cab.find(m=>m.name==='布洛芬片').expiresOn,'2027-03-31');
  let t=await f.api.query({view:'timeline',memberId:'owner'});
  assert.equal(t.members[0].events.length,0,'saving the cabinet logs no dose');
  sb(f).logSymptom({memberId:'owner',symptom:'喉咙疼',status:'active',at:'2026-11-22T08:00:00+08:00',episodeId:'ep1',sourceEventId:'s1'});
  const d=sb(f).logDose({memberId:'owner',medication:'布洛芬缓释胶囊',takenAt:'2026-11-22T09:00:00+08:00',amount:'1粒',sourceEventId:'d1'});
  assert.equal(sb(f).logDose({memberId:'owner',medication:'布洛芬缓释胶囊',takenAt:'2026-11-22T09:00:00+08:00',amount:'1粒',sourceEventId:'d1'}).duplicate,true);
  assert.equal(sb(f).logSymptom({memberId:'owner',symptom:'喉咙疼',status:'active',at:'2026-11-22T08:00:00+08:00',episodeId:'ep1',sourceEventId:'s1'}).duplicate,true);
  sb(f).logSymptom({memberId:'owner',symptom:'喉咙疼',status:'resolved',at:'2026-11-22T15:00:00+08:00',episodeId:'ep1',sourceEventId:'s2'});
  t=(await f.api.query({view:'timeline',memberId:'owner'})).members[0];
  assert.deepEqual(t.events.map(e=>e.type+':'+(e.status??e.medication)),['symptom:active','dose:布洛芬缓释胶囊','symptom:resolved']);
  assert.deepEqual(t.events[1].forSymptom,[],'close in time is not a link');
  assert.equal(t.episodes[0].now,'resolved');
  const meds=(await f.api.query({view:'meds',memberId:'owner'})).recent[0];
  assert.equal(meds.nextAllowedAt,'2026-11-22T13:00:00.000Z','the 缓释 rule (12 h), not the 普通 one');
  assert.equal(meds.ruleSource,'说明书');
  // The user says it: "喉咙疼才吃的那粒"
  assert.throws(()=>f.x('owner','med',{action:'link',doseId:d.id,episodeId:'ep1',requestId:'l-0'}),/userWords/);
  const l=f.x('owner','med',{action:'link',doseId:d.id,symptom:'喉咙',userWords:'喉咙疼才吃的那粒',requestId:'l-1'});
  assert.equal(l.episodeId,'ep1');
  t=(await f.api.query({view:'timeline',memberId:'owner'})).members[0];
  assert.equal(t.events[1].forSymptom[0].symptom,'喉咙疼');
  f.x('owner','med',{action:'unlink',linkId:l.linkId,requestId:'l-2'});
  assert.deepEqual((await f.api.query({view:'timeline',memberId:'owner'})).members[0].events[1].forSymptom,[]);
 }finally{f.close();}
});

test('普通 vs 缓释 with the same ingredient, unknown amount, other members and a retraction',async()=>{
 const f=fixture();
 try{
  cabinet(f);
  const amb=sb(f).logDose({memberId:'gao',medication:'布洛芬',takenAt:'2026-11-22T10:00:00+08:00',sourceEventId:'d2'});
  assert.equal(amb.match,'ambiguous');
  assert.deepEqual(amb.candidates.toSorted(),['布洛芬片','布洛芬缓释胶囊']);
  const g=(await f.api.query({view:'meds',memberId:'gao'})).recent[0];
  assert.equal(g.canTakeNow,null);
  assert.match(g.note,/无法判断/);
  const slow=sb(f).logDose({memberId:'kid',medication:'布洛芬缓释',takenAt:'2026-11-22T10:00:00+08:00',sourceEventId:'d3'});
  assert.equal(slow.medication,'布洛芬缓释胶囊','缓释 said → never the plain tablet');
  const k=(await f.api.query({view:'meds',memberId:'kid'})).recent[0];
  assert.equal(k.lastAmount,'没说');
  assert.match(k.note,/剂量没说/);
  // members stay apart
  sb(f).logSymptom({memberId:'owner',symptom:'头疼',status:'active',at:'2026-11-22T08:00:00+08:00',episodeId:'ep9',sourceEventId:'s9'});
  const gt=await f.api.query({view:'timeline',memberId:'gao'});
  assert.deepEqual(gt.members.map(m=>m.memberId),['gao']);
  assert.ok(gt.members[0].events.every(e=>e.type==='dose'&&e.medication==='布洛芬'));
  assert.throws(()=>f.x('kid','med',{action:'link',doseId:amb.id,episodeId:'ep9',userWords:'头疼吃的',requestId:'l-x'}),/不是这位成员/);
  // a retraction keeps the row but drops it from the views
  assert.equal(sb(f).logDose({sourceEventId:'d2',void:true,reason:'说错了'}).voided,true);
  assert.equal((await f.api.query({view:'timeline',memberId:'gao'})).members[0].events.length,0);
  assert.equal((await f.api.query({view:'meds',memberId:'gao'})).recent.length,0);
 }finally{f.close();}
});

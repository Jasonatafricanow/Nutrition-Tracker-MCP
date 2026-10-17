import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createEngine,TOOL_DEFS} from '../engine.js';
const TODAY='2026-10-17T12:00:00+08:00';
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),'photo-agent-'));const file=path.join(dir,'ledger.db');const e=createEngine(file,{now:()=>new Date(TODAY),timeZone:'Asia/Shanghai'});return {e,file,close(){e.close();rmSync(dir,{recursive:true,force:true});}};}
function prepare(e,items=[{name:'看起来是熟米饭',foodId:'f7',estimatedWeightGrams:180,confidence:'medium',note:'有遮挡'}],opts={}) {
  return e.execute('prepare_photo_meal',{date:'2026-10-16',mealSlot:'午餐',items,...opts});
}
function confirm(e,draftId,extra={}){
  return e.execute('confirm_photo_meal',{draftId,confirmed:true,requestId:'photo-turn-1',decisions:[{index:0,include:true,weightGrams:180,portionSource:'visual_estimate'}],...extra});
}
test('photo tools are exposed to an agent and drafts do not write food or binary image',()=>{
  const f=fixture();try{
    for(const name of ['prepare_photo_meal','get_photo_meal_draft','confirm_photo_meal','discard_photo_meal']) assert.ok(TOOL_DEFS[name]);
    const a=prepare(f.e);assert.ok(a.draftId.startsWith('photo_'));assert.equal(a.photoStored,false);assert.equal(a.isLogged,false);
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,0);
    const read=f.e.execute('get_photo_meal_draft',{draftId:a.draftId});assert.equal(read.items[0].estimated.c,50.4);
    assert.equal(f.e.execute('get_agent_context',{}).pendingPhotoDrafts[0].id,a.draftId);
  }finally{f.close();}
});
test('unknown ingredient remains unresolved: no invented nutrition',()=>{
  const f=fixture();try{
    const a=prepare(f.e,[{name:'不明酱汁',estimatedWeightGrams:60,confidence:'low'}]);
    assert.equal(a.items[0].estimated.p,undefined);
    assert.equal(a.items[0].needsFoodMatch,true);
    assert.throws(()=>confirm(f.e,a.draftId),/nutritionSource/);
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,0);
  }finally{f.close();}
});
test('confirmation requires user confirmation flag and explicit reviewed portion',()=>{
  const f=fixture();try{
    const a=prepare(f.e);
    assert.throws(()=>f.e.execute('confirm_photo_meal',{draftId:a.draftId,confirmed:false,requestId:'x',decisions:[{index:0,include:true,weightGrams:180,portionSource:'visual_estimate'}]}),/参数错误/);
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[{index:0,include:true,weightGrams:180}]}),/份量来源/);
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[{index:0,include:true,portionSource:'visual_estimate'}]}),/确认份量/);
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[]}),/参数错误/);
    assert.equal(f.e.execute('get_photo_meal_draft',{draftId:a.draftId}).status,'open');
  }finally{f.close();}
});
test('confirmed photograph is logged once, keeps estimation provenance and day incomplete',()=>{
  const f=fixture();try{
    const a=prepare(f.e);f.e.execute('mark_intake_complete',{date:'2026-10-16'});
    const r=confirm(f.e,a.draftId);assert.equal(r.ok,true);assert.equal(r.mealIds.length,1);
    const hist=f.e.execute('get_meal_history',{date:'2026-10-16'});
    assert.equal(hist.intakeComplete,false);assert.equal(hist.meals.length,1);
    assert.equal(hist.meals[0].source_kind,'agent_photo_confirmed');assert.equal(hist.meals[0].source_ref,a.draftId);
    assert.equal(hist.meals[0].portion_source,'visual_estimate');
    assert.equal(f.e.execute('get_photo_meal_draft',{draftId:a.draftId}).status,'logged');
    assert.deepEqual(f.e.execute('get_agent_context',{}).pendingPhotoDrafts,[]);
  }finally{f.close();}
});
test('MCP retries are idempotent; a second distinct confirmed request cannot log the same draft',()=>{
  const f=fixture();try{
    const a=prepare(f.e);const first=confirm(f.e,a.draftId);
    const again=confirm(f.e,a.draftId);assert.equal(again.duplicate,true);assert.deepEqual(again.mealIds,first.mealIds);
    assert.throws(()=>confirm(f.e,a.draftId,{requestId:'different-id'}),/已经提交|已被记录/);
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[{index:0,include:true,weightGrams:140,portionSource:'visual_estimate'}]}),/requestId/);
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,1);
  }finally{f.close();}
});
test('two candidates require complete unique decision list; unknown can be explicitly excluded',()=>{
  const f=fixture();try{
    const a=prepare(f.e,[{name:'鸡胸肉',foodId:'f1',estimatedWeightGrams:150,confidence:'high'},{name:'不明蘸酱',confidence:'low'}]);
    assert.throws(()=>confirm(f.e,a.draftId),/每个照片候选/);
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[{index:0,include:true,weightGrams:150,portionSource:'measured'},{index:0,include:false}]}),/index/);
    const good=confirm(f.e,a.draftId,{decisions:[{index:0,include:true,weightGrams:150,portionSource:'measured'},{index:1,include:false}]});
    assert.equal(good.partial,true);assert.deepEqual(good.excludedItems,['不明蘸酱']);
    const hist=f.e.execute('get_meal_history',{date:'2026-10-16'});assert.equal(hist.meals[0].portion_source,'measured');
  }finally{f.close();}
});
test('verified direct nutrition values allowed, photo-based nutrition guesses rejected',()=>{
  const f=fixture();try{
    const a=prepare(f.e,[{name:'不明食物',confidence:'low'}]);
    const d={index:0,include:true,weightGrams:100,portionSource:'user_estimate',p:10,c:15,f:2};
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[d]}),/nutritionSource/);
    const r=confirm(f.e,a.draftId,{decisions:[{...d,nutritionSource:'food_label',name:'标签核验后的食物'}]});
    assert.equal(r.items[0].p,10);assert.equal(r.items[0].name,'标签核验后的食物');
  }finally{f.close();}
});
test('invalid macro mass atomically preserves draft and ledger, allows corrected retry',()=>{
  const f=fixture();try{
    const a=prepare(f.e,[{name:'未识别',confidence:'low'}]);
    const bad={index:0,include:true,weightGrams:30,portionSource:'visual_estimate',nutritionSource:'user_supplied',p:20,c:20,f:10};
    assert.throws(()=>confirm(f.e,a.draftId,{decisions:[bad]}),/质量/);
    assert.equal(f.e.execute('get_photo_meal_draft',{draftId:a.draftId}).status,'open');
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,0);
    const good=confirm(f.e,a.draftId,{decisions:[{...bad,weightGrams:200}]});assert.equal(good.ok,true);
  }finally{f.close();}
});
test('draft cancellation cannot be confirmed or used to delete logged meals',()=>{
  const f=fixture();try{
    const a=prepare(f.e);const canceled=f.e.execute('discard_photo_meal',{draftId:a.draftId});assert.equal(canceled.status,'discarded');
    assert.throws(()=>confirm(f.e,a.draftId),/已取消/);
    const b=prepare(f.e);confirm(f.e,b.draftId);
    assert.throws(()=>f.e.execute('discard_photo_meal',{draftId:b.draftId}),/已入账/);
  }finally{f.close();}
});
test('no undefined draft, no empty confirmed meal, no future draft',()=>{
  const f=fixture();try{
    assert.throws(()=>f.e.execute('get_photo_meal_draft',{draftId:'unknown'}),/找不到/);
    assert.throws(()=>prepare(f.e,undefined,{date:'2026-10-18'}),/未来/);
    const a=prepare(f.e);assert.throws(()=>confirm(f.e,a.draftId,{decisions:[{index:0,include:false}]}),/空餐食/);
  }finally{f.close();}
});
test('photo draft state persists between MCP engine instances',()=>{
  const f=fixture();try{
    const a=prepare(f.e);const other=createEngine(f.file,{timeZone:'Asia/Shanghai',now:()=>new Date(TODAY)});
    try{assert.equal(other.execute('get_photo_meal_draft',{draftId:a.draftId}).status,'open');}
    finally{other.close();}
  }finally{f.close();}
});

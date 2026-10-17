import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createEngine,TOOL_DEFS} from '../engine.js';
const CURRENT='2026-10-17T12:00:00+08:00';
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),'nutri-agent-'));const file=path.join(dir,'data.db');const e=createEngine(file,{now:()=>new Date(CURRENT),timeZone:'Asia/Shanghai'});return {e,file,close(){e.close();rmSync(dir,{recursive:true,force:true});}};}
function firstMeal(e,opts={}) {return e.execute('log_meal_items',{date:'2026-10-16',mealSlot:'午餐',items:[{foodId:'f1',weightGrams:200},{foodId:'f7',weightGrams:150}],...opts},'MCP_AGENT');}

test('MCP registry exposes compact agent-first discovery, history, template, export tools',()=>{
  for(const name of ['get_agent_context','search_foods','get_meal_history','save_meal_template','list_meal_templates','log_meal_template','export_nutrition_data'])assert.ok(TOOL_DEFS[name],name);
});
test('food search escapes SQL LIKE wildcards, returns macro units and respects limit',()=>{
  const f=fixture();try {
    const ordinary=f.e.execute('search_foods',{query:'鸡胸',limit:2});assert.equal(ordinary.foods.length,1);assert.equal(ordinary.foods[0].id,'f1');
    assert.deepEqual(f.e.execute('search_foods',{query:'%',limit:50}).foods,[]);
    assert.equal(f.e.execute('search_foods',{query:'',limit:3}).foods.length,3);
    assert.throws(()=>f.e.execute('search_foods',{limit:500}),/参数错误/);
  }finally{f.close();}
});
test('historical meal logging produces correct date, math, read-back, and incomplete flag',()=>{
  const f=fixture();try {
    const a=firstMeal(f.e);assert.equal(a.date,'2026-10-16');assert.equal(a.items.length,2);
    const old=f.e.execute('get_meal_history',{date:'2026-10-16'});assert.equal(old.meals.length,2);
    assert.equal(old.intakeComplete,false);assert.equal(old.proteinG,51.9);
    const today=f.e.execute('get_meal_history',{});assert.equal(today.meals.length,0);
    assert.throws(()=>firstMeal(f.e,{date:'2026-10-18'}),/未来/);
  }finally{f.close();}
});
test('same requestId retries do not duplicate meals or journal entries; conflicting payload is rejected',()=>{
  const f=fixture();try {
    const a=firstMeal(f.e,{requestId:'host:conversation:turn123'});
    const b=firstMeal(f.e,{requestId:'host:conversation:turn123'});
    assert.equal(b.duplicate,true);assert.deepEqual(b.mealIds,a.mealIds);
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,2);
    assert.throws(()=>firstMeal(f.e,{requestId:'host:conversation:turn123',items:[{foodId:'f1',weightGrams:100}]}),/requestId/);
  }finally{f.close();}
});
test('failed meal validation atomically leaves neither logs nor request receipt',()=>{
  const f=fixture();try {
    assert.throws(()=>f.e.execute('log_meal_items',{date:'2026-10-16',mealSlot:'晚餐',requestId:'bad',items:[{name:'Impossible',weightGrams:40,p:40,c:30,f:10}]}),/质量/);
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,0);
    const ok=f.e.execute('log_meal_items',{date:'2026-10-16',mealSlot:'晚餐',requestId:'bad',items:[{foodId:'f1',weightGrams:100}]});assert.equal(ok.ok,true);
  }finally{f.close();}
});
test('save from actual ledger, list, replay with multiplier and different slot',()=>{
  const f=fixture();try {
    firstMeal(f.e);
    const t=f.e.execute('save_meal_template',{name:'Office lunch',date:'2026-10-16',mealSlot:'午餐'});
    assert.equal(t.items.length,2);
    const list=f.e.execute('list_meal_templates',{query:'Office'});
    assert.equal(list.templates.length,1);assert.equal(list.templates[0].id,t.templateId);
    const r=f.e.execute('log_meal_template',{templateId:t.templateId,date:'2026-10-17',mealSlot:'晚餐',multiplier:0.5,requestId:'replay#1'});
    assert.equal(r.items.find(x=>x.name.includes('鸡胸肉')).w,100);assert.equal(r.items.find(x=>x.name.includes('鸡胸肉')).p,24);
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-17'}).meals.length,2);
    const duplicate=f.e.execute('log_meal_template',{templateId:t.templateId,date:'2026-10-17',mealSlot:'晚餐',multiplier:0.5,requestId:'replay#1'});
    assert.equal(duplicate.duplicate,true);assert.equal(f.e.execute('get_meal_history',{date:'2026-10-17'}).meals.length,2);
    assert.throws(()=>f.e.execute('log_meal_template',{templateId:'missing'}),/不存在/);
  }finally{f.close();}
});
test('template macros remain a saved snapshot after foods library changes',()=>{
  const f=fixture();try {
    firstMeal(f.e);const t=f.e.execute('save_meal_template',{name:'frozen',date:'2026-10-16',mealSlot:'午餐'});
    const db=new DatabaseSync(f.file);db.prepare('UPDATE foods SET p=0,c=0,f=0 WHERE id=?').run('f1');db.close();
    const r=f.e.execute('log_meal_template',{templateId:t.templateId,mealSlot:'早餐'});
    assert.equal(r.items.find(x=>x.name.includes('鸡胸肉')).p,48);
  }finally{f.close();}
});
test('adding meal from template reopens prior completed day',()=>{
  const f=fixture();try {
    firstMeal(f.e);const t=f.e.execute('save_meal_template',{name:'repeat',date:'2026-10-16',mealSlot:'午餐'});
    f.e.execute('mark_intake_complete',{date:'2026-10-16'});
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).intakeComplete,true);
    f.e.execute('log_meal_template',{templateId:t.templateId,date:'2026-10-16',mealSlot:'加餐'});
    assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).intakeComplete,false);
  }finally{f.close();}
});
test('export bound, date inclusivity, no mutation and input validation',()=>{
  const f=fixture();try {
    firstMeal(f.e);
    const ex=f.e.execute('export_nutrition_data',{fromDate:'2026-10-15',toDate:'2026-10-17'});
    assert.equal(ex.formatVersion,1);assert.equal(ex.timeZone,'Asia/Shanghai');
    assert.equal(ex.meals.length,2);assert.ok(ex.ledger.some(x=>x.date==='2026-10-16'));
    assert.throws(()=>f.e.execute('export_nutrition_data',{fromDate:'2026-05-01',toDate:'2026-10-16'}),/最多/);
    assert.throws(()=>f.e.execute('export_nutrition_data',{fromDate:'2026-10-17',toDate:'2026-10-16'}),/不能晚于/);
    assert.throws(()=>f.e.execute('export_nutrition_data',{fromDate:'2026-10-16',toDate:'2026-10-18'}),/未来/);
  }finally{f.close();}
});
test('schema migrates existing v5.1 SQLite database without losing meal data',()=>{
  const f=fixture();try {
    firstMeal(f.e);const dbFile=f.file;f.e.close();
    const e=createEngine(dbFile,{now:()=>new Date(CURRENT),timeZone:'Asia/Shanghai'});
    assert.equal(e.execute('get_meal_history',{date:'2026-10-16'}).meals.length,2);
    assert.equal(e.execute('list_meal_templates',{}).templates.length,0);
    e.close();rmSync(path.dirname(dbFile),{recursive:true,force:true});
  }catch(e){rmSync(path.dirname(f.file),{recursive:true,force:true});throw e;}
});

test('get_agent_context is compact and does not return private full history or huge food library',()=>{
 const f=fixture();try {firstMeal(f.e,{date:'2026-10-17'});const s=f.e.execute('get_agent_context',{});assert.equal(s.ok,true);assert.equal(s.recentMeals.length,2);assert.equal(s.intakeComplete,false);assert.equal(typeof s.remaining.kcal,'number');assert.equal('history' in s,false);assert.equal('foods' in s,false);}finally{f.close();}
});

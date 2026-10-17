import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHousehold,validateHouseholdConfig} from '../household.js';
import {createEngine} from '../engine.js';
const NOW=new Date('2026-10-18T12:00:00Z');
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'household-test-'));
 const configPath=path.join(dir,'household.json');
 writeFileSync(configPath,JSON.stringify({timeZone:'Asia/Shanghai',members:[
 {id:'alex',name:'Alex',mode:'performance'}, {id:'jo',name:'Jo',mode:'general'}]}));
 const household=createHousehold({configPath,dir,engineFactory:createEngine,now:()=>NOW});
 return {household,close(){household.close();rmSync(dir,{recursive:true,force:true});}};
}
test('small household config has no user tokens, passwords or sharing grants',()=>{
 assert.equal(validateHouseholdConfig({members:[{id:'dad',name:'Dad'}]})[0].mode,'general');
 assert.throws(()=>validateHouseholdConfig({members:[{id:'one',name:'A'},{id:'one',name:'B'}]}),/duplicate/);
 assert.throws(()=>validateHouseholdConfig({members:[{id:'..',name:'bad'}]}),/invalid/);
});
test('one household context contains performance nutrition and general wellness without forcing carbs',()=>{
 const f=fixture();try{
  const c=f.household.context();assert.equal(c.scope,'household_nas');assert.equal(c.members.length,2);
  assert.ok(c.members[0].nutrition.remaining.c>=0);
  assert.equal(c.members[1].nutrition,null);
  assert.equal(c.members[1].latest.sleepHours,null);
 }finally{f.close();}
});
test('existing nutrition engine remains independently usable per member with member attribution',()=>{
 const f=fixture();try{
  f.household.memberTool('alex','log_meal_items',{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:120}],requestId:'alex-rice'});
  const a=f.household.memberTool('alex','get_meal_history',{});
  const b=f.household.memberTool('jo','get_meal_history',{});
  assert.equal(a.meals.length,1);assert.equal(b.meals.length,0);
  assert.throws(()=>f.household.memberTool('other','get_meal_history',{}),/unknown/);
  const context=f.household.context();assert.ok(context.members[0].nutrition.remaining.c<context.members[0].nutrition.targets.c);
 }finally{f.close();}
});
test('health observations are additive, scoped by member ID and deduplicated',()=>{
 const f=fixture();try{
  const a=f.household.logObservation({memberId:'jo',kind:'blood_pressure',systolic:119,diastolic:76,sourceEventId:'bp-001'});
  const again=f.household.logObservation({memberId:'jo',kind:'blood_pressure',systolic:119,diastolic:76,sourceEventId:'bp-001'});
  assert.equal(again.duplicate,true);assert.equal(a.id,again.id);
  f.household.logObservation({memberId:'jo',kind:'temperature_c',value:36.7});
  f.household.logObservation({memberId:'alex',kind:'symptom_note',note:'Sore legs'});
  const c=f.household.context();
  assert.deepEqual(c.members[1].latest.bloodPressure,{systolic:119,diastolic:76,date:'2026-10-18'});
  assert.equal(c.members[1].latest.temperatureC.value,36.7);
  assert.equal(c.members[1].observations.some(x=>x.kind==='symptom_note'),false);
  assert.equal(f.household.observations('alex').some(x=>x.note==='Sore legs'),true);
 }finally{f.close();}
});
test('invalid clinical inputs cannot be stored',()=>{
 const f=fixture();try{
  assert.throws(()=>f.household.logObservation({memberId:'jo',kind:'blood_pressure',systolic:80,diastolic:120}),/invalid/);
  assert.throws(()=>f.household.logObservation({memberId:'jo',kind:'glucose_mg_dl',value:-1}),/invalid/);
  assert.throws(()=>f.household.logObservation({memberId:'jo',kind:'symptom_note',note:' '}),/required/);
  assert.equal(f.household.observations('jo').length,0);
 }finally{f.close();}
});
test('short sleep hint is occasional and suppressed after the agent says it',()=>{
 const f=fixture();try{
  f.household.memberTool('jo','log_morning_checkin',{sleepHours:4.7,sourceEventId:'sleep-jo-01'});
  const start=f.household.context().members.find(x=>x.memberId==='jo');
  assert.equal(start.noteworthy[0].key,'short_sleep');
  assert.equal(f.household.acknowledge('jo','short_sleep').ok,true);
  assert.equal(f.household.context().members.find(x=>x.memberId==='jo').noteworthy.length,0);
  assert.throws(()=>f.household.acknowledge('alex','unknown'),/unknown/);
 }finally{f.close();}
});
test('all long-term contexts persist across server restarts',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'household-persist-'));const configPath=path.join(dir,'config.json');
 writeFileSync(configPath,JSON.stringify({members:[{id:'a',name:'A',timeZone:'UTC'}]}));
 let h=createHousehold({configPath,dir,engineFactory:createEngine,now:()=>NOW});
 try{
  h.logObservation({memberId:'a',kind:'temperature_c',value:37.1});
  h.memberTool('a','log_morning_checkin',{sleepHours:5});
  h.acknowledge('a','short_sleep');h.close();
  h=createHousehold({configPath,dir,engineFactory:createEngine,now:()=>NOW});
  const c=h.context().members[0];assert.equal(c.latest.temperatureC.value,37.1);
  assert.equal(c.latest.sleepHours,5);assert.equal(c.noteworthy.length,0);
 }finally{h.close();rmSync(dir,{recursive:true,force:true});}
});

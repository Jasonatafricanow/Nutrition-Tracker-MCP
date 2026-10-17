import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFamilyHealth,summarizeSeries} from '../family-health.js';
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'family-health-'));
 const grants=new Set(),a={id:'a'},b={id:'b'};
 const accounts={
  member:id=>{if(!['a','b'].includes(id))throw Error('Unknown member');return {id,timeZone:'UTC'};},
  canRead:(requester,target,scope)=>requester.id===target||grants.has(requester.id+':'+target+':'+scope),
  engineFor:()=>({execute:()=>({ledger:Array.from({length:15},(_,i)=>({
   date:'2026-10-'+String(i+3).padStart(2,'0'),scale_weight_kg:75-i*.1,
   sleep_hours:7+i*.05,rhr_bpm:60-i*.1,steps:6000+i*100}))})})
 };
 const health=createFamilyHealth({accounts,dir,now:()=>new Date('2026-10-18T12:00:00Z')});
 return {health,grants,a,b,close(){health.close();rmSync(dir,{recursive:true,force:true});}};
}
test('vital bounds, event idempotency and conflicting event rejection',()=>{
 const f=fixture();try{
  assert.throws(()=>f.health.record(f.a,{kind:'blood_pressure',systolic:30,diastolic:130}),/Invalid/);
  assert.throws(()=>f.health.record(f.a,{kind:'symptom_note',note:''}),/required/);
  const args={kind:'blood_pressure',observedAt:'2026-10-17T09:00:00Z',systolic:122,diastolic:78,sourceEventId:'bp-1'};
  const first=f.health.record(f.a,args),retry=f.health.record(f.a,args);
  assert.equal(first.duplicate,false);assert.equal(retry.duplicate,true);
  assert.throws(()=>f.health.record(f.a,{...args,systolic:140}),/reused/);
  assert.equal(f.health.history(f.a,{days:30}).observations.length,1);
 }finally{f.close();}
});
test('private symptom notes are never available in another members history',()=>{
 const f=fixture();try{
  f.health.record(f.b,{kind:'symptom_note',note:'private personal text',observedAt:'2026-10-18T08:00:00Z'});
  assert.equal(f.health.history(f.a,{days:7}).observations.length,0);
  assert.equal(f.health.history(f.b,{days:7}).observations[0].note,'private personal text');
 }finally{f.close();}
});
test('health_trends requires separate consent from overview',()=>{
 const f=fixture();try{
  assert.throws(()=>f.health.report(f.a,{memberId:'b',days:14}),/denied/);
  f.grants.add('a:b:overview');assert.throws(()=>f.health.report(f.a,{memberId:'b',days:14}),/denied/);
  f.grants.add('a:b:health_trends');const r=f.health.report(f.a,{memberId:'b',days:14});
  assert.equal(r.ok,true);assert.equal(r.mode,'general');assert.equal(r.series.weightKg.samples,15);
  assert.equal(r.series.weightKg.comparisonAvailable,true);assert.equal(r.dataQuality.notesExcluded,true);
 }finally{f.close();}
});
test('general mode is default and report does not invent health score',()=>{
 const f=fixture();try{
  assert.equal(f.health.settings('a'),'general');f.health.setMode(f.a,'performance');
  assert.equal(f.health.report(f.a,{memberId:'a',days:14}).mode,'performance');
  assert.throws(()=>f.health.setMode(f.a,'diagnosis'),/Invalid/);
  const report=f.health.report(f.a,{memberId:'a',days:14});
  assert.ok(!('healthScore' in report));assert.ok(report.limitations.some(x=>x.includes('No diagnosis')));
 }finally{f.close();}
});
test('too few observations means no trend difference',()=>{
 const v=summarizeSeries([{date:'2026-10-17',v:72}],'v',14,'2026-10-18');
 assert.equal(v.comparisonAvailable,false);assert.equal(v.recentMinusEarlier,null);
});
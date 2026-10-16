import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createEngine, localDateStr } from '../engine.js';

function fixture(nowIso='2026-10-17T07:00:00+08:00') {
  const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-v51-'));
  const dbPath=path.join(dir,'test.db');
  const e=createEngine(dbPath,{timeZone:'Asia/Shanghai',now:()=>new Date(nowIso)});
  const db=new DatabaseSync(dbPath);
  return {e,db,close(){db.close();e.close();rmSync(dir,{recursive:true,force:true});}};
}
function dateAt(i) {const d=new Date(Date.UTC(2026,8,18+i));return d.toISOString().slice(0,10);}
function seed(f,{nonWeigh=1500,weighIntake=2000,every=4,completed=true,omitNonWeigh=false, end=24}={}) {
  const ins=f.db.prepare(`INSERT INTO daily_ledger (date,carb_level,is_training_day,workout_focus,target_tdee,est_glycogen_g,intake_kcal,intake_complete,scale_weight_kg,ewma_weight_kg) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for(let i=0;i<=end;i++) {
    const weight=i%every===0;
    ins.run(dateAt(i),'medium',1,'synthetic',2600,360,weight?weighIntake:nonWeigh,
      (!completed || (omitNonWeigh && !weight))?0:1, weight?75:null,weight?75:null);
  }
}
function cal(nonWeigh){const f=fixture();try{seed(f,{nonWeigh});return f.e.execute('calibrate_metabolic_tdee',{windowDays:28});}finally{f.close();}}

test('calibration includes all non-weighing day calorie data',()=>{
 const a=cal(1500),b=cal(3500);
 assert.equal(a.ok,true);assert.equal(b.ok,true);
 assert.notEqual(a.expectedDeltaKg,b.expectedDeltaKg);
 assert.ok(Math.abs(a.expectedDeltaKg-b.expectedDeltaKg)>4);
});
test('calendar day count is 24 days, not 6 weigh intervals',()=>{
 const c=cal(2000); assert.equal(c.windowDays,24);assert.equal(c.weightSamples,7);
});
test('missing days block calibration instead of being interpreted as zero',()=>{
 const f=fixture();try{seed(f,{omitNonWeigh:true});const cal=f.e.execute('calibrate_metabolic_tdee',{windowDays:28});assert.equal(cal.ok,false);assert.ok(cal.unloggedDays>=18);}finally{f.close();}
});
test('uncertified food records cannot enter calibration',()=>{
 const f=fixture();try{seed(f,{completed:false});const r=f.e.buildSnapshot().calibrationPreview;assert.equal(r.ok,false);}finally{f.close();}
});
test('preview mode does not change persisted TDEE',()=>{
 const f=fixture();try{seed(f,{nonWeigh:1500});const before=f.e.buildSnapshot().profile.adaptive_tdee;const r=f.e.execute('calibrate_metabolic_tdee',{windowDays:28});assert.equal(r.previewOnly,true);assert.equal(f.e.buildSnapshot().profile.adaptive_tdee,before);}finally{f.close();}
});
test('same evidence cannot be applied twice even with force',()=>{
 const f=fixture();try{seed(f,{nonWeigh:1500});const a=f.e.execute('calibrate_metabolic_tdee',{windowDays:28,apply:true});assert.ok(a.appliedDeltaKcal!==0);const prior=f.e.buildSnapshot().profile.adaptive_tdee;const b=f.e.execute('calibrate_metabolic_tdee',{windowDays:28,force:true,apply:true});assert.equal(b.appliedDeltaKcal,0);assert.equal(f.e.buildSnapshot().profile.adaptive_tdee,prior);}finally{f.close();}
});
test('weighing is independent of unobserved glycogen estimate',()=>{
 const fn=(gly)=>{const f=fixture();try{f.db.prepare(`INSERT INTO daily_ledger(date,carb_level,is_training_day,workout_focus,target_tdee,est_glycogen_g) VALUES ('2026-10-16','low',0,'x',2600,?)`).run(gly);return f.e.execute('log_morning_checkin',{scaleWeightKg:75});}finally{f.close();}};
 const a=fn(200),b=fn(550);assert.equal(a.ewmaWeightKg,b.ewmaWeightKg);assert.equal(a.dewateredWeightKg,75);
});
test('low recovery signal reports risk but preserves training plan and supplements',()=>{
 const f=fixture('2026-10-14T07:00:00+08:00');try{assert.equal(f.e.buildSnapshot().today.carb_level,'high');const r=f.e.execute('log_morning_checkin',{hrvMs:40,hrvMetric:'RMSSD',rhrBpm:63,sleepHours:5});assert.equal(r.cnsStatus,'RECOVERY_FLAG');assert.equal(f.e.buildSnapshot().today.carb_level,'high');}finally{f.close();}
});
test('SDNN does not borrow RMSSD baseline for an arbitrary readiness score',()=>{
 const f=fixture();try{f.e.execute('log_morning_checkin',{hrvMs:60,hrvMetric:'SDNN',rhrBpm:55,sleepHours:7});assert.equal(f.e.buildSnapshot().today.readiness_score,null);}finally{f.close();}
});
test('HRV requires a declared measurement type',()=>{
 const f=fixture();try{assert.throws(()=>f.e.execute('log_morning_checkin',{hrvMs:50}),/hrvMetric/);}finally{f.close();}
});
test('food library IDs are collision-safe even if Date.now is frozen',()=>{
 const f=fixture();const orig=Date.now;try{Date.now=()=>123;const a=f.e.execute('add_food_to_library',{name:'A',p:20,c:20,f:10});const b=f.e.execute('add_food_to_library',{name:'B',p:20,c:20,f:10});assert.notEqual(a.foodId,b.foodId);}finally{Date.now=orig;f.close();}
});
test('physically impossible foods and meal items are rejected',()=>{
 const f=fixture();try{assert.throws(()=>f.e.execute('add_food_to_library',{name:'impossible',p:100,c:100,f:100}),/100g/);assert.throws(()=>f.e.execute('log_meal_items',{mealSlot:'午餐',items:[{name:'impossible',weightGrams:10,p:30,c:40,f:20}]}),/质量/);}finally{f.close();}
});
test('food edits clear day-complete status',()=>{
 const f=fixture();try{f.e.execute('mark_intake_complete',{});assert.equal(f.e.buildSnapshot().today.intake_complete,1);f.e.execute('log_meal_items',{mealSlot:'早餐',items:[{foodId:'f1',weightGrams:100}]});assert.equal(f.e.buildSnapshot().today.intake_complete,0);}finally{f.close();}
});
test('manual override renormalizes current weekly plan instead of silently changing weekly average',()=>{
 const f=fixture('2026-10-14T07:00:00+08:00');try{f.e.execute('set_day_context',{carbLevel:'low'});const s=f.e.buildSnapshot();const weekMean=s.effectiveWeekTargets.reduce((sum,d)=>sum+d.kcal,0)/7;
    assert.ok(Math.abs(weekMean-s.weeklyBase.kcal)<15,`changed week average ${weekMean} vs ${s.weeklyBase.kcal}`);
    assert.equal(s.effectiveWeekTargets[s.todayIndex].plan,'low');}finally{f.close();}
});
test('history imported with measuredAt belongs to measurement date and deduplicates',()=>{
 const f=fixture();try{const a=f.e.execute('log_morning_checkin',{scaleWeightKg:74.2,measuredAt:'2026-10-12T07:00:00+08:00',sourceEventId:'abc'},'PHONE');const b=f.e.execute('log_morning_checkin',{scaleWeightKg:74.2,measuredAt:'2026-10-12T07:00:00+08:00',sourceEventId:'abc'},'PHONE');assert.equal(a.ledgerDate,'2026-10-12');assert.equal(b.duplicate,true);assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM health_ingest_events`).get().n,1);assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM daily_ledger WHERE date='2026-10-12' AND scale_weight_kg IS NOT NULL`).get().n,1);}finally{f.close();}
});
test('cross-timezone calendar date is stable with explicit IANA zone',()=>{
 const d=new Date('2026-10-14T00:30:00+08:00');assert.equal(localDateStr(d,'Asia/Shanghai'),'2026-10-14');assert.equal(localDateStr(d,'Europe/London'),'2026-10-13');
});
test('reject invalid historical dates and future timestamps',()=>{
 const f=fixture();try{assert.throws(()=>f.e.execute('mark_intake_complete',{date:'2026-02-99'}),/参数错误/);assert.throws(()=>f.e.execute('log_morning_checkin',{measuredAt:'2028-01-02T00:00:00Z',scaleWeightKg:70}),/未来/);}finally{f.close();}
});
test('warn on implausibly low protein plan without pretending universal safe minimum',()=>{
 const f=fixture();try{f.e.execute('set_profile',{goalKcal:-1000,ratioP:10,ratioC:70,ratioF:20});const s=f.e.buildSnapshot();assert.ok(s.nutritionWarnings.some(x=>x.includes('蛋白质')));}finally{f.close();}
});

test('real directional weight trend produces appropriately signed TDEE preview',()=>{
  const f=fixture();try{
    const ins=f.db.prepare(`INSERT INTO daily_ledger(date,carb_level,is_training_day,workout_focus,target_tdee,est_glycogen_g,intake_kcal,intake_complete,scale_weight_kg) VALUES (?,?,?,?,?,?,?,?,?)`);
    for(let i=8;i<=24;i++) ins.run(dateAt(i),'medium',1,'linear synthetic',2633,360,2633,1,76-i*0.07);
    const cal=f.e.execute('calibrate_metabolic_tdee',{windowDays:14});
    assert.equal(cal.ok,true);assert.ok(cal.appliedDeltaKcal>0);
  }finally{f.close();}
});

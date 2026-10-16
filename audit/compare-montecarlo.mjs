import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createEngine as oldEngine } from '../../portfolio_build/nutrition-tracker-mcp/engine.js';
import { createEngine as newEngine } from '../engine.js';
let state=20261017;
function random(){state=(1664525*state+1013904223)>>>0;return state/2**32;}
function gauss(){return Math.sqrt(-2*Math.log(Math.max(1e-10,random())))*Math.cos(2*Math.PI*random());}
function simulation(engineFn, scaleNoise, weights) {
 const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-mc-'));
 const file=path.join(dir,'db.sqlite');
 const e=engineFn(file,{now:()=>new Date('2026-10-17T07:00:00+08:00'),timeZone:'Asia/Shanghai'});
 const db=new DatabaseSync(file);
 try {
   const insert=db.prepare('INSERT OR REPLACE INTO daily_ledger(date,carb_level,is_training_day,workout_focus,target_tdee,est_glycogen_g,intake_kcal,scale_weight_kg,ewma_weight_kg) VALUES (?,?,?,?,?,?,?,?,?)');
   let smooth=null;
   const base=Date.UTC(2026,8,26);
   for(let i=0;i<21;i++) {
     const date=new Date(base+i*86400000).toISOString().slice(0,10);
     const weight=weights[i];smooth=smooth===null?weight:0.25*weight+0.75*smooth;
     insert.run(date,'medium',1,'study simulation',2633,360,2633,weight,smooth);
   }
   // New engine: intake explicitly marked complete before comparison.
   if (engineFn === newEngine) db.exec('UPDATE daily_ledger SET intake_complete = 1');
   const cal=e.execute('calibrate_metabolic_tdee',{windowDays:14});
   return {ok:cal.ok,nonzero:cal.ok&&cal.appliedDeltaKcal!==0,bound:cal.ok&&Math.abs(cal.appliedDeltaKcal)===120,mean:cal.ok?Math.abs(cal.appliedDeltaKcal):null};
 } finally {db.close();e.close();rmSync(dir,{recursive:true,force:true});}
}
const out=[];
for(const sd of [.1,.2,.3,.5]){
 const row={noiseSdKg:sd,trials:150,old:{nonzero:0,bound:0,sum:0},updated:{nonzero:0,bound:0,sum:0}};
 for(let i=0;i<150;i++){
   const w=Array.from({length:21},()=>75+gauss()*sd);
   const [a,b]=[simulation(oldEngine,sd,w),simulation(newEngine,sd,w)];
   for(const [label,r] of [['old',a],['updated',b]]){
     if(!r.ok)throw Error('unexpected incomplete calibration '+label);
     row[label].nonzero+=r.nonzero?1:0;row[label].bound+=r.bound?1:0;row[label].sum+=r.mean;
   }
 }
 for(const k of ['old','updated']){
   row[k].nonzeroPct=+(100*row[k].nonzero/150).toFixed(1);
   row[k].boundPct=+(100*row[k].bound/150).toFixed(1);
   row[k].meanAbsKcal=+(row[k].sum/150).toFixed(1);
   delete row[k].sum;
 }
 out.push(row);
 console.log(JSON.stringify(row));
}
console.log('COMPLETE',out.length*150,'paired simulations');

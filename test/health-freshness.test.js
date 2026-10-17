import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';

const NOW=new Date('2026-10-18T04:00:00Z');
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'health-freshness-'));
 const cfg=path.join(dir,'members.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'a',name:'A',mode:'general'}]}));
 const household=createHousehold({configPath:cfg,dir,engineFactory:createEngine,now:()=>NOW});
 return {household,dir,close(){household.close();rmSync(dir,{recursive:true,force:true});}};
}
test('household context prefers today over yesterday and does not repeat yesterday short-sleep hint',()=>{
 const f=fixture();try{
   f.household.memberTool('a','log_morning_checkin',{measuredAt:'2026-10-17T07:00:00+08:00',sleepHours:4.5,rhrBpm:89});
   f.household.memberTool('a','log_morning_checkin',{measuredAt:'2026-10-18T07:00:00+08:00',sleepHours:7.5,rhrBpm:62});
   const m=f.household.context({days:7}).members[0];
   assert.equal(m.latest.sleepHours,7.5);
   assert.equal(m.latest.sleepDate,'2026-10-18');
   assert.equal(m.latest.restingHeartRate,62);
   assert.equal(m.latest.restingHeartRateDate,'2026-10-18');
   assert.equal(m.noteworthy.some(s=>s.key==='short_sleep'),false);
 }finally{f.close();}
});
test('device event ID is replay-safe but rejects a different body, preserving the original measure',()=>{
 const f=fixture();try{
   const reading={measuredAt:'2026-10-18T07:00:00+08:00',sourceEventId:'wearable-sleep-1',sleepHours:7};
   const call=a=>f.household.memberTool('a','log_morning_checkin',a);
   call(reading);
   assert.equal(call(reading).duplicate,true);
   assert.throws(()=>call({...reading,sleepHours:9}),/sourceEventId/);
   assert.equal(f.household.context({days:7}).members[0].latest.sleepHours,7);
 }finally{f.close();}
});
test('prior database rows without payload hash remain readable with explicit unverified replay flag',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'health-legacy-'));
 const file=path.join(dir,'old.db');
 const reading={measuredAt:'2026-10-18T07:00:00+08:00',sourceEventId:'legacy-measure-1',steps:1234};
 try{
   let engine=createEngine(file,{timeZone:'Asia/Shanghai',now:()=>NOW});
   engine.execute('log_morning_checkin',reading,'DEVICE');
   engine.close();
   const sqlite=new DatabaseSync(file);
   sqlite.prepare('UPDATE health_ingest_events SET payload_hash = NULL WHERE source = ?').run('DEVICE');
   sqlite.close();
   engine=createEngine(file,{timeZone:'Asia/Shanghai',now:()=>NOW});
   const duplicate=engine.execute('log_morning_checkin',reading,'DEVICE');
   assert.equal(duplicate.duplicate,true);assert.equal(duplicate.legacyUnverified,true);
   assert.throws(()=>engine.execute('log_morning_checkin',{...reading,measuredAt:'2026-10-17T07:00:00+08:00'},'DEVICE'),/sourceEventId/);
   engine.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

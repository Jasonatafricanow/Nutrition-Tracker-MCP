import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';
import {createAgentInterface} from '../agent-interface.js';
import {PHOTO_ESTIMATE_EXAMPLE} from '../photo-estimation.js';
const NOW=new Date('2026-10-18T03:00:00Z');
const fixed=()=>NOW;
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'low-friction-'));
 const cfg=path.join(dir,'household.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'alice',name:'Alice',mode:'performance'},{id:'bob',name:'Bob',mode:'general'}]}));
 const engine=createEngine(path.join(dir,'single.db'),{now:fixed,timeZone:'Asia/Shanghai'});
 const family=createHousehold({configPath:cfg,dir,engineFactory:createEngine,now:fixed});
 const api=createAgentInterface({engine,household:family});
 return {dir,cfg,engine,family,api,close(){family.close();engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('one user text request logs approximate meal with provenance, idempotency, and editable history', async()=>{
 const f=fixture();try{
  const req={memberId:'bob',operation:'quick_meal',args:{mealSlot:'午餐',source:'text',requestId:'spoken-1',items:[{name:'米饭',weightGrams:150,foodId:'f7'},{name:'番茄炒蛋',weightGrams:180,p:13,c:10,f:18}]}};
  const first=f.api.execute(req);assert.equal(first.ok,true);assert.equal(first.estimated,true);
  assert.equal(first.mealIds.length,2);assert.equal(first.context.memberId,'bob');
  const repeat=f.api.execute(req);assert.equal(repeat.duplicate,true);
  const history=await f.api.query({view:'meals',memberId:'bob'});
  assert.equal(history.meals.length,2);assert.deepEqual(history.meals.map(x=>x.source_kind),['agent_text_estimate','agent_text_estimate']);
  assert.deepEqual(history.meals.map(x=>x.portion_source),['user_estimate','user_estimate']);
  assert.equal((await f.api.query({view:'meals',memberId:'alice'})).meals.length,0);
  const meal=history.meals[0];
  const correction=f.api.execute({memberId:'bob',operation:'correction',args:{mealId:meal.id,expectedRevision:0,weightGrams:210,requestId:'fix-1'}});
  assert.equal(correction.after.revision,1);assert.equal(correction.after.weightGrams,210);
  const audited=f.family.memberTool('bob','get_meal_corrections',{mealId:meal.id});
  assert.equal(audited.corrections.length,1);
 }finally{f.close();}
});
test('photographs cannot use the shortcut; stage generates only a preview until one user approval',()=>{
 const f=fixture();try{
  assert.throws(()=>f.api.execute({memberId:'bob',operation:'quick_meal',args:{mealSlot:'午餐',source:'photo',requestId:'no-automatic-photo',items:[{name:'鸡蛋',weightGrams:100,p:12,c:1,f:10}]}}),/参数错误/);
  const estimate=structuredClone(PHOTO_ESTIMATE_EXAMPLE);
  const preview=f.api.execute({memberId:'bob',operation:'photo_stage',args:{mealSlot:'午餐',estimate,matches:[{itemId:'item-1',foodId:'f7'}]}});
  assert.equal(preview.reviewRequired,true);
  assert.equal(preview.items[0].name,'熟白米饭');
  assert.equal(f.family.memberTool('bob','get_meal_history',{}).meals.length,0);
  // Only AFTER the user confirms the single preview; the agent can translate it
  // to the original deterministic per-candidate decisions behind the scenes.
  const booked=f.api.execute({memberId:'bob',operation:'photo_confirm',args:{
    draftId:preview.draftId,confirmed:true,
    confirmationEvidence:{channel:'user_message',summary:'User accepted the one concise food/portion preview'},
    requestId:'photo-accept-1',
    decisions:[{index:0,include:true,weightGrams:180,portionSource:'visual_estimate'},{index:1,include:false}]
  }});
  assert.equal(booked.mealIds.length,1);
  assert.equal(f.family.memberTool('bob','get_meal_history',{}).meals[0].source_kind,'agent_photo_confirmed');
 }finally{f.close();}
});
test('stale or fabricated food ID rejected, reuse of health observation source ID cannot silently alter value',()=>{
 const f=fixture();try{
  assert.throws(()=>f.api.execute({memberId:'bob',operation:'quick_meal',args:{mealSlot:'午餐',source:'text',requestId:'bad-id',items:[{name:'香蕉',foodId:'f_not_a_real_id',weightGrams:100}]}}),/食材库/);
  const args={memberId:'bob',kind:'blood_pressure',systolic:120,diastolic:80,sourceEventId:'reading-1'};
  const first=f.family.logObservation(args);assert.ok(first.id);
  assert.equal(f.family.logObservation(args).duplicate,true);
  assert.throws(()=>f.family.logObservation({...args,systolic:145}),/different health observation/);
 }finally{f.close();}
});
function freePort(){return new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
test('family health webhook requires member attribution and updates only that member',async()=>{
 const f=fixture();const port=await freePort();
 const proc=spawn(process.execPath,['server.js','--no-stdio'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:path.join(f.dir,'legacy.db'),HOUSEHOLD_CONFIG:f.cfg,HOUSEHOLD_DATA_DIR:f.dir,HEALTH_WEBHOOK_TOKEN:'low-friction-webhook-test-token',NUTRITION_TIME_ZONE:'Asia/Shanghai'},stdio:['ignore','ignore','pipe']});
 let log='';proc.stderr.on('data',s=>log+=String(s));
 try{
  let ready=false;
  for(let i=0;i<100;i++){
   if(proc.exitCode!==null)throw Error('server exited: '+log);
   try{const z=await fetch(`http://127.0.0.1:${port}/api/snapshot`);if(z.ok){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(ready,true,'server start');
  const url=`http://127.0.0.1:${port}/api/health-webhook`;
  const post=payload=>fetch(url,{method:'POST',headers:{Authorization:'Bearer low-friction-webhook-test-token','Content-Type':'application/json'},body:JSON.stringify(payload)});
  const noMember=await post({sleepHours:5});assert.equal(noMember.status,400);
  const unknown=await post({memberId:'missing',sleepHours:5});assert.ok(unknown.status>=400);
  // Fixed future timestamps depend on CI clock; use a genuinely past measurement.
  const observedAt=new Date(Date.now()-2*3600_000).toISOString();
  const good=await post({memberId:'alice',sleepHours:5.25,sourceEventId:'alice-sleep-1',measuredAt:observedAt});
  assert.equal(good.status,200,await good.text());
  const family=await(await fetch(`http://127.0.0.1:${port}/api/household`)).json();
  const alice=family.members.find(x=>x.memberId==='alice'),bob=family.members.find(x=>x.memberId==='bob');
  assert.ok(alice&&bob);
  assert.equal(alice.latest.sleepHours,5.25);
  assert.equal(bob.latest.sleepHours,null);
 }finally{proc.kill();f.close();}
});
test('Dashboard offers reversible everyday view and direct correction affordance',async()=>{
 const {readFileSync}=await import('node:fs');
 const html=readFileSync(new URL('../viewport.html',import.meta.url),'utf8');
 assert.ok(html.includes('toggleViewMode()'));
 assert.ok(html.includes('nutrition.viewMode'));
 assert.ok(html.includes('editMeal('));
 assert.ok(html.includes('update_meal_item'));
});

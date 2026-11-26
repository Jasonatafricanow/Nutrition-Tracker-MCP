import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';
import {createAgentInterface} from '../agent-interface.js';

// Household mode on top of an existing single-person install: the owner ("primary") keeps the
// original database, family members get their own. No migration of the owner's data.
const MEMBERS=[{id:'owner',name:'Owner',mode:'performance'},{id:'kid',name:'Kid',mode:'general'}];
function fixture(extra={}){
 const dir=mkdtempSync(path.join(tmpdir(),'household-primary-'));
 const cfg=path.join(dir,'household.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',primary:'owner',members:MEMBERS,...extra}));
 return {dir,cfg,close(){rmSync(dir,{recursive:true,force:true});}};
}
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});

test('primary member reuses the main database; other members get their own',()=>{
 const f=fixture();
 const engine=createEngine(path.join(f.dir,'nutrition.db'),{timeZone:'Asia/Shanghai'});
 const family=createHousehold({configPath:f.cfg,dir:path.join(f.dir,'household'),engineFactory:createEngine,primaryEngine:engine});
 try{
  const api=createAgentInterface({engine,household:family});
  const meal=(memberId,requestId)=>api.execute({memberId,operation:'quick_meal',args:{mealSlot:'午餐',source:'text',requestId,items:[{name:'米饭',weightGrams:150,foodId:'f7'}]}});
  assert.equal(meal(undefined,'owner-1').ok,true);           // no memberId → owner
  assert.equal(meal('kid','kid-1').ok,true);
  assert.equal(engine.execute('get_meal_history',{},'TEST').meals.length,1); // owner's meal is in the main DB
  assert.equal(family.memberTool('owner','get_meal_history',{}).meals.length,1);
  assert.equal(family.memberTool('kid','get_meal_history',{}).meals.length,1);
  assert.equal(existsSync(path.join(f.dir,'household','nutrition-owner.db')),false);
  assert.equal(existsSync(path.join(f.dir,'household','nutrition-kid.db')),true);
 }finally{family.close();engine.close();f.close();}
});

test('primary must be a listed member',()=>{
 const f=fixture({primary:'nobody'});
 const engine=createEngine(path.join(f.dir,'nutrition.db'),{timeZone:'Asia/Shanghai'});
 try{assert.throws(()=>createHousehold({configPath:f.cfg,dir:path.join(f.dir,'household'),engineFactory:createEngine,primaryEngine:engine}),/primary/);}
 finally{engine.close();f.close();}
});

test('webhook sleep still passes the sleep gate in household mode, for owner and family',async()=>{
 const f=fixture();const port=await freePort();
 const proc=spawn(process.execPath,['server.js','--no-stdio'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',
  DB_PATH:path.join(f.dir,'nutrition.db'),HOUSEHOLD_CONFIG:f.cfg,HOUSEHOLD_DATA_DIR:path.join(f.dir,'household'),
  HEALTH_WEBHOOK_TOKEN:'household-primary-webhook-token',NUTRITION_TIME_ZONE:'Asia/Shanghai',NUTRITION_SLEEP_WEBHOOK_ONLY:'1'},stdio:['ignore','ignore','pipe']});
 let log='';proc.stderr.on('data',s=>log+=String(s));
 try{
  let ready=false;
  for(let i=0;i<100&&!ready;i++){
   if(proc.exitCode!==null)throw Error('server exited: '+log);
   try{ready=(await fetch(`http://127.0.0.1:${port}/api/snapshot`)).ok;}catch{}
   if(!ready)await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(ready,true,'server start');
  const post=payload=>fetch(`http://127.0.0.1:${port}/api/health-webhook`,{method:'POST',
   headers:{Authorization:'Bearer household-primary-webhook-token','Content-Type':'application/json'},body:JSON.stringify(payload)});
  const at=new Date(Date.now()-2*3600_000).toISOString();
  const owner={source:'statebar',events:[{sourceEventId:'statebar:owner:1',measuredAt:at,sleepHours:6.5}]};
  const r1=await post(owner);assert.equal(r1.status,200,await r1.text());
  const r2=await post({source:'statebar',memberId:'kid',events:[{sourceEventId:'statebar:kid:1',measuredAt:at,sleepHours:9.5}]});
  assert.equal(r2.status,200,await r2.text());
  const again=await(await post(owner)).json();
  assert.equal(again.results[0].duplicate,true);
  // The Dashboard (main engine) and the family view show the same owner data.
  const snap=await(await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
  assert.ok(snap.history.some(r=>r.sleep_hours===6.5),'owner sleep in main DB');
  const family=await(await fetch(`http://127.0.0.1:${port}/api/household`)).json();
  assert.equal(family.members.find(m=>m.memberId==='owner').latest.sleepHours,6.5);
  assert.equal(family.members.find(m=>m.memberId==='kid').latest.sleepHours,9.5);
 }finally{proc.kill();f.close();}
});

test('family members show the last 7 days of meals and their latest sleep with its date',()=>{
 const f=fixture();
 const engine=createEngine(path.join(f.dir,'nutrition.db'),{timeZone:'Asia/Shanghai'});
 const family=createHousehold({configPath:f.cfg,dir:path.join(f.dir,'household'),engineFactory:createEngine,primaryEngine:engine});
 try{
  const day=n=>new Date(Date.now()+n*864e5).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  family.memberTool('kid','log_meal_items',{date:day(-1),mealSlot:'晚餐',requestId:'kid-y',items:[{foodId:'f7',weightGrams:100}]});
  family.memberTool('kid','log_meal_items',{date:day(-9),mealSlot:'午餐',requestId:'kid-old',items:[{foodId:'f7',weightGrams:80}]});
  family.memberTool('kid','log_morning_checkin',{sleepHours:9.5,measuredAt:new Date(Date.now()-3*864e5).toISOString()},'HEALTH_WEBHOOK');
  const c=family.context();
  const kid=c.members.find(m=>m.memberId==='kid'),owner=c.members.find(m=>m.memberId==='owner');
  assert.deepEqual(kid.recentMeals.map(d=>d.date),[day(-1)]);            // older than 7 days is left out
  assert.equal(kid.recentMeals[0].slots[0].slot,'晚餐');
  assert.equal(kid.recentMeals[0].slots[0].items[0].weightG,100);
  assert.deepEqual(kid.latest.lastSleep,{hours:9.5,date:day(-3)});
  assert.equal(kid.latest.sleepHours,null);                               // "recent" (today/yesterday) is unchanged
  assert.equal(owner.recentMeals,null);                                   // the owner's card is unchanged
 }finally{family.close();engine.close();f.close();}
});

// Contract for the dashboard's read-only household stock views: /api/household?view=pantry|meds|workouts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';

const TOKEN='stock-dashboard-webhook-test-token';
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});

test('dashboard stock views return fridge, cabinet and workouts; cross-origin reads are denied',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'stock-dashboard-'));
 const cfg=path.join(dir,'household.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'owner',name:'我',mode:'performance'},{id:'kid',name:'娃',mode:'general'}]}));
 // Seed the fridge and the cabinet through the real store, then let the server read the same files.
 const family=createHousehold({configPath:cfg,dir,engineFactory:createEngine});
 family.stock.pantryAdd({items:[{name:'牛奶',quantity:'两盒',shelfLifeDays:5},{name:'剩菜',quantity:'一碗',shelfLifeDays:0}]});
 family.stock.medSave({name:'布洛芬混悬液',forMembers:['kid'],dose:'5ml',minIntervalHours:6,maxPerDay:4});
 family.close();
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const proc=spawn(process.execPath,['server.js','--no-stdio'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',
  DB_PATH:path.join(dir,'legacy.db'),HOUSEHOLD_CONFIG:cfg,HOUSEHOLD_DATA_DIR:dir,HEALTH_WEBHOOK_TOKEN:TOKEN,NUTRITION_TIME_ZONE:'Asia/Shanghai'},stdio:['ignore','ignore','pipe']});
 let log='';proc.stderr.on('data',s=>log+=String(s));
 try{
  for(let i=0;i<100;i++){
   if(proc.exitCode!==null)throw Error('server exited: '+log);
   try{if((await fetch(base+'/api/snapshot')).ok)break;}catch{}
   await new Promise(r=>setTimeout(r,50));
  }
  const hook=(route,body)=>fetch(base+route,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await hook('/api/dose-webhook',{memberId:'kid',medication:'布洛芬混悬液',takenAt:new Date(Date.now()-3600_000).toISOString(),sourceEventId:'d1'})).status,200);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  assert.equal((await hook('/api/workout-webhook',{memberId:'owner',activity:'跑步',date:today,durationMin:30,sourceEventId:'w1'})).status,200);
  const sym=await hook('/api/symptom-webhook',{memberId:'owner',symptom:'喉咙疼',key:'sore_throat',status:'active',at:new Date(Date.now()-7200_000).toISOString(),episodeId:'ep1',sourceEventId:'statebar:s1'});
  assert.equal(sym.status,200);assert.equal((await sym.json()).duplicate,false);
  assert.equal((await (await hook('/api/symptom-webhook',{memberId:'owner',symptom:'喉咙疼',status:'active',at:new Date().toISOString(),episodeId:'ep1',sourceEventId:'statebar:s1'})).json()).duplicate,true);
  assert.equal((await hook('/api/symptom-webhook',{memberId:'owner',symptom:'喉咙疼',status:'gone',at:new Date().toISOString(),sourceEventId:'statebar:s2'})).status,400);
  assert.equal((await fetch(base+'/api/symptom-webhook',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const view=v=>fetch(base+'/api/household?view='+v).then(r=>r.json());

  const pantry=await view('pantry');
  assert.deepEqual(pantry.items.map(i=>[i.name,i.quantity,i.daysLeft]),[['剩菜','一碗',0],['牛奶','两盒',5]]);
  const meds=await view('meds');
  assert.deepEqual(meds.cabinet.map(m=>[m.name,m.forMembers,m.dose,m.minIntervalHours]),[['布洛芬混悬液',['kid'],'5ml',6]]);
  const dose=meds.recent[0];
  assert.equal(dose.memberId,'kid');assert.equal(dose.canTakeNow,false);assert.ok(dose.waitMinutes>290&&dose.waitMinutes<=300);
  assert.ok(Date.parse(dose.lastTakenAt));
  const wo=await view('workouts');
  assert.deepEqual(wo.members.map(m=>[m.memberId,m.sessionsThisWeek,m.minutesThisWeek,m.recent.length]),[['owner',1,30,1]]);

  for(const v of ['pantry','meds','workouts'])
   assert.equal((await fetch(base+'/api/household?view='+v,{headers:{Origin:'https://untrusted.example'}})).status,403);
 }finally{proc.kill();rmSync(dir,{recursive:true,force:true});}
});

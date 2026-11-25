import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort(){return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function setupServer(withWebhookToken=true, extraEnv={}){
  const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-http-'));
  const port=await freePort();
  const url=`http://127.0.0.1:${port}`;
  const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:path.join(dir,'x.db'),NUTRITION_TIME_ZONE:'Asia/Shanghai',...extraEnv};
  delete env.NUTRITION_API_TOKEN;
  delete env.HEALTH_WEBHOOK_TOKEN;
  if(withWebhookToken) env.HEALTH_WEBHOOK_TOKEN='test-secret-not-for-production';
  const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{cwd:root,env,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',d=>stderr+=String(d));
  for(let i=0;i<200;i++) {
    if(child.exitCode!==null)throw Error('HTTP service exited: '+stderr);
    try{const r=await fetch(url+'/api/snapshot');if(r.ok)return {url,child,dir,async close(){child.kill();await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('exit',r);setTimeout(r,1500).unref()});rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});}};}catch{}
    await new Promise(r=>setTimeout(r,50));
  }
  child.kill();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});throw Error('HTTP server start timeout: '+stderr);
}
async function post(url,route,payload,headers={}){return fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(payload)});}

test('HTTP rejects unauthenticated and cross-origin writes but permits same-origin session writes',async()=>{
 const s=await setupServer();try{
   const payload={tool:'set_profile',args:{goalKcal:-700}};
   const noAuth=await post(s.url,'/api/mcp-dispatch',payload);
   assert.equal(noAuth.status,401);
   const options=await fetch(s.url+'/api/mcp-dispatch',{method:'OPTIONS',headers:{Origin:'https://untrusted.example','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Nutrition-CSRF'}});
   assert.equal(options.headers.get('access-control-allow-origin'),null);
   const csrf=(await (await fetch(s.url+'/api/session')).json()).csrfToken;
   assert.ok(csrf?.length>=32);
   const cross=await post(s.url,'/api/mcp-dispatch',payload,{'X-Nutrition-CSRF':csrf,Origin:'https://untrusted.example'});
   assert.equal(cross.status,403);
   const accepted=await post(s.url,'/api/mcp-dispatch',payload,{'X-Nutrition-CSRF':csrf,Origin:s.url});
   assert.equal(accepted.status,200);
   const snap=await (await fetch(s.url+'/api/snapshot')).json();
   assert.equal(snap.profile.goal_kcal,-700);
 } finally{await s.close();}
});

test('webhook requires bearer token and deduplicates historical measurements',async()=>{
 const s=await setupServer();try{
   const payload={source:'phone',sourceEventId:'stable-test-id',measuredAt:'2025-01-02T07:00:00+08:00',weightKg:75.1};
   assert.equal((await post(s.url,'/api/health-webhook',payload)).status,401);
   const h={Authorization:'Bearer test-secret-not-for-production'};
   const first=await post(s.url,'/api/health-webhook',payload,h);assert.equal(first.status,200);
   const data=await first.json();assert.equal(data.ledgerDate,'2025-01-02');
   const second=await post(s.url,'/api/health-webhook',payload,h);assert.equal(second.status,200);
   assert.equal((await second.json()).duplicate,true);
 }finally{await s.close();}
});

test('webhook endpoint is disabled if token is not configured',async()=>{
 const s=await setupServer(false);try{
   const r=await post(s.url,'/api/health-webhook',{weightKg:75});assert.equal(r.status,503);
 }finally{await s.close();}
});

test('HTTP inventory endpoints guard writes, update stock without touching nutrition ledger, and honor ENABLE_INVENTORY=0',async()=>{
 const s=await setupServer();try{
   const html=await (await fetch(s.url+'/')).text();
   assert.match(html,/id="inventory-panel"/);
   assert.match(html,/class="pb-hub"/);
   assert.equal((await post(s.url,'/api/inventory',{operation:'purchase',name:'黄瓜',quantity:'四根'})).status,401);
   const csrf=(await (await fetch(s.url+'/api/session')).json()).csrfToken;
   assert.equal((await post(s.url,'/api/inventory',{operation:'purchase',name:'黄瓜'},{'X-Nutrition-CSRF':csrf,Origin:'https://untrusted.example'})).status,403);
   const headers={'X-Nutrition-CSRF':csrf,Origin:s.url};
   const bought=await post(s.url,'/api/inventory',{operation:'purchase',name:'黄瓜',quantity:'四根',requestId:'http-inv-1'},headers);
   assert.equal(bought.status,200);
   const used=await post(s.url,'/api/inventory',{operation:'consume',name:'黄瓜',usedQuantity:'一根',requestId:'http-inv-2'},headers);
   assert.equal(used.status,200);
   assert.equal((await used.json()).batch.remainingQuantity,'约3根');
   const inv=await (await fetch(s.url+'/api/inventory')).json();
   assert.equal(inv.current.items.length,1);
   assert.equal(inv.current.items[0].remaining[0],'约3根');
   const itemRes=await (await fetch(s.url+'/api/inventory?view=item&name='+encodeURIComponent('黄瓜'))).json();
   assert.equal(itemRes.item.batches.length,1);
   const snap=await (await fetch(s.url+'/api/snapshot')).json();
   assert.equal(snap.meals.length,0);
 }finally{await s.close();}

 const disabled=await setupServer(false,{ENABLE_INVENTORY:'0'});try{
   assert.equal((await fetch(disabled.url+'/api/inventory')).status,404);
   const csrf=(await (await fetch(disabled.url+'/api/session')).json()).csrfToken;
   assert.equal((await post(disabled.url,'/api/inventory',{operation:'purchase',name:'黄瓜'},{'X-Nutrition-CSRF':csrf,Origin:disabled.url})).status,404);
 }finally{await disabled.close();}
});

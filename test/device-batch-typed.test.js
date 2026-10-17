import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const portFree=()=>new Promise((resolve,reject)=>{
 const sock=createServer();sock.once('error',reject);
 sock.listen(0,'127.0.0.1',()=>{const port=sock.address().port;sock.close(()=>resolve(port));});
});
async function serverFixture(){
 const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-batch-'));
 const port=await portFree(),url=`http://127.0.0.1:${port}`;
 const config=path.join(dir,'household.json');
 writeFileSync(config,JSON.stringify({timeZone:'Asia/Shanghai',members:[
  {id:'alex',name:'Alex',mode:'performance'},{id:'jo',name:'Jo',mode:'general'}]}));
 const env={...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:path.join(dir,'single.db'),
    HOUSEHOLD_CONFIG:config,HOUSEHOLD_DATA_DIR:dir,HEALTH_WEBHOOK_TOKEN:'test-webhook-batch-token'};
 const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{env,cwd:root,stdio:['ignore','ignore','pipe']});
 let log='';child.stderr.on('data',s=>log+=String(s));
 for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw Error('server unexpectedly exited '+log);
   try{if((await fetch(url+'/api/household')).ok)break;}catch{}
   if(i===99)throw Error('server startup timeout '+log);
   await pause(45);
 }
 return {dir,port,url,child,async close(){child.kill();await pause(80);rmSync(dir,{recursive:true,force:true});}};
}
test('private webhook batch routes to the specified family member, retries idempotently and reports partial failures',async()=>{
 const f=await serverFixture();
 const h={Authorization:'Bearer test-webhook-batch-token','Content-Type':'application/json'};
 const post=x=>fetch(f.url+'/api/health-webhook',{method:'POST',headers:h,body:JSON.stringify(x)});
 const time=new Date(Date.now()-4*3600_000).toISOString();
 const payload={memberId:'jo',source:'phone',events:[
  {measuredAt:time,sourceEventId:'sleep-a',sleepHours:6.5},
  {measuredAt:time,sourceEventId:'hr-a',rhrBpm:64}
 ]};
 try{
  assert.equal((await post({...payload,memberId:undefined})).status,400);
  assert.equal((await post({...payload,memberId:'missing'})).status,400);
  const first=await post(payload);assert.equal(first.status,200);
  const result=await first.json();assert.equal(result.succeeded,2);assert.equal(result.failed,0);
  const twice=await post(payload);assert.equal(twice.status,200);
  assert.ok((await twice.json()).results.every(r=>r.duplicate));
  const partial=await post({...payload,events:[{measuredAt:time,sourceEventId:'new-one',steps:1000},
     {measuredAt:time,steps:1000}]});
  assert.equal(partial.status,207);const p=await partial.json();
  assert.equal(p.partial,true);assert.equal(p.succeeded,1);assert.equal(p.failed,1);
  const family=await(await fetch(f.url+'/api/household')).json();
  const jo=family.members.find(x=>x.memberId==='jo');
  const alex=family.members.find(x=>x.memberId==='alex');
  assert.equal(alex.latest.sleepHours,null);assert.ok(jo);
 }finally{await f.close();}
});
test('compact MCP exposes typed common input and keeps same two operations with legacy advanced payloads',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-typed-'));
 const client=new Client({name:'typed-compact-schema-test',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.js')],
   env:{...process.env,MCP_TOOL_SURFACE:'compact',PORT:'0',DB_PATH:path.join(dir,'one.db')}});
 try{
  await client.connect(transport);
  const list=(await client.listTools()).tools;
  assert.deepEqual(list.map(x=>x.name).sort(),['nutrition_execute','nutrition_query']);
  const args=list.find(x=>x.name==='nutrition_execute').inputSchema?.properties?.args;
  assert.equal(args?.type,'object');
  assert.ok(args.properties?.weightGrams);
  assert.ok(args.properties?.foodName);
  assert.ok(args.properties?.items);
  const invalid=await client.callTool({name:'nutrition_execute',arguments:{
    operation:'quick_meal',args:{mealSlot:'午餐',source:'text',requestId:'wrong',items:[{name:'米饭',weightGrams:'a lot',foodId:'f7'}]}}});
  assert.equal(invalid.isError,true);
  const good=await client.callTool({name:'nutrition_execute',arguments:{
    operation:'quick_meal',args:{mealSlot:'午餐',source:'text',requestId:'valid',
      items:[{name:'米饭',weightGrams:150,foodId:'f7'}]}}});
  assert.equal(good.isError,undefined);
  const corrected=await client.callTool({name:'nutrition_execute',arguments:{
    operation:'recent_correction',args:{foodName:'米饭',weightGrams:210,requestId:'correction'}}});
  assert.equal(corrected.isError,undefined);
 }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});

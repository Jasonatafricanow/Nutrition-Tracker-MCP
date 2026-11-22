// Several clients on one household: the main agent (full), another family bot (kitchen only), and the dashboard.
// Each change to the shared fridge says which client made it; a kitchen bot never reaches a member's records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {loadClients} from '../clients.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MAIN='main-agent-token-at-least-32-bytes-long';
const BOT='kitchen-bot-token-at-least-32-bytes-long';
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});

test('client config: names, scopes and tokens are checked at start',()=>{
 const ok=loadClients({MCP_HTTP_TOKEN:MAIN,MCP_HTTP_CLIENT_NAME:'主助手',MCP_CLIENTS:JSON.stringify([{name:'家人工作bot',token:BOT,scope:'kitchen'}])});
 assert.deepEqual(ok.map(c=>[c.name,c.scope]),[['主助手','full'],['家人工作bot','kitchen']]);
 assert.throws(()=>loadClients({MCP_HTTP_TOKEN:MAIN,MCP_CLIENTS:JSON.stringify([{name:'bot',token:'short'}])}),/32 bytes/);
 assert.throws(()=>loadClients({MCP_HTTP_TOKEN:MAIN,MCP_CLIENTS:JSON.stringify([{name:'bot',token:MAIN}])}),/share a token/);
 assert.throws(()=>loadClients({MCP_HTTP_TOKEN:MAIN,MCP_CLIENTS:JSON.stringify([{name:'bot',token:BOT,scope:'admin'}])}),/scope/);
});

test('a kitchen bot manages the shared fridge under its own name and cannot reach anyone’s records',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'kitchen-clients-'));
 const config=path.join(dir,'household.json');
 writeFileSync(config,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'owner',name:'Owner',mode:'performance'},{id:'gao',name:'Gao',mode:'general'}]}));
 const port=await freePort(),ui=await freePort();
 const env={...process.env,MCP_TOOL_SURFACE:'everyday',HOUSEHOLD_CONFIG:config,HOUSEHOLD_DATA_DIR:dir,PORT:String(ui),HOST:'127.0.0.1',
  DB_PATH:path.join(dir,'legacy.db'),MCP_HTTP_ENABLED:'1',MCP_HTTP_PORT:String(port),MCP_HTTP_HOST:'127.0.0.1',MCP_HTTP_TOKEN:MAIN,
  MCP_HTTP_CLIENT_NAME:'main',MCP_CLIENTS:JSON.stringify([{name:'gao-bot',token:BOT,scope:'kitchen'}])};
 const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{env,cwd:root,stdio:['ignore','ignore','pipe']});
 let log='';child.stderr.on('data',d=>log+=String(d));
 const url=`http://127.0.0.1:${port}/mcp`;
 const clients=[];
 const connect=async token=>{const c=new Client({name:'t',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+token}}}));clients.push(c);return c;};
 const call=async(c,name,args)=>{const r=await c.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content[0].text);};
 try{
  for(let i=0;i<150;i++){
   if(child.exitCode!==null)throw Error('server failed: '+log);
   try{if((await fetch(url)).status===401)break;}catch{}
   await new Promise(r=>setTimeout(r,35));
  }
  const bot=await connect(BOT), main=await connect(MAIN);
  // The family member's bot puts a receipt into the fridge.
  await call(bot,'nutrition_execute',{operation:'pantry',args:{action:'add',source:'receipt',items:[{name:'牛奶',quantity:'2盒'},{name:'排骨',quantity:'500g'}],requestId:'r-1'}});
  const p=await call(main,'nutrition_query',{view:'pantry'});
  assert.deepEqual(p.items.map(i=>[i.name,i.addedBy,i.lastChange.by]),[['牛奶','gao-bot','gao-bot'],['排骨','gao-bot','gao-bot']].sort((a,b)=>p.items.findIndex(i=>i.name===a[0])-p.items.findIndex(i=>i.name===b[0])));
  // A caller cannot pass itself off as another client.
  await call(bot,'nutrition_execute',{operation:'pantry',args:{action:'use',name:'牛奶',remaining:'1盒',by:'main',requestId:'r-2'}});
  assert.equal((await call(main,'nutrition_query',{view:'pantry'})).items.find(i=>i.name==='牛奶').lastChange.by,'gao-bot');
  await call(main,'nutrition_execute',{operation:'pantry',args:{action:'edit',name:'排骨',quantity:'400g',requestId:'r-3'}});
  assert.equal((await call(bot,'nutrition_query',{view:'pantry'})).items.find(i=>i.name==='排骨').lastChange.by,'main');
  // Kitchen reads work; members' records do not.
  assert.ok((await call(bot,'nutrition_query',{view:'kitchen'})).ok);
  for(const view of ['meals','summary','meds','timeline','workouts'])
   await assert.rejects(call(bot,'nutrition_query',{view,memberId:'gao'}),/只能看/,view);
  await assert.rejects(call(bot,'nutrition_execute',{memberId:'gao',operation:'meal',args:{mealSlot:'午餐',items:[{name:'米饭',weightGrams:100,p:3,c:28,f:0}]}}),/只能写/);
  await assert.rejects(call(bot,'nutrition_execute',{operation:'med',args:{name:'布洛芬',dose:'1片'}}),/只能写/);
  await assert.rejects(call(bot,'nutrition_execute',{operation:'food_add',args:{name:'某菜',state:'raw',p:1,c:1,f:1,dataSource:'x'}}),/包装标签/);
  const resources=await bot.listResources().catch(()=>({resources:[]}));
  assert.ok(!resources.resources.some(r=>r.name==='snapshot'),'the owner snapshot is not for a kitchen bot');
  // The dashboard writes as 页面, kitchen scope.
  const s=await fetch(`http://127.0.0.1:${ui}/api/session`).then(r=>r.json());
  const page=(body)=>fetch(`http://127.0.0.1:${ui}/api/mcp-dispatch`,{method:'POST',headers:{'Content-Type':'application/json','X-Nutrition-CSRF':s.csrfToken},body:JSON.stringify(body)});
  const added=await page({op:'pantry',args:{action:'add',items:[{name:'青菜',quantity:'1把'}],requestId:'pg-1'}});
  assert.equal(added.status,200);
  assert.equal((await call(main,'nutrition_query',{view:'pantry'})).items.find(i=>i.name==='青菜').addedBy,'页面');
  assert.equal((await page({view:'cookbook'})).status,200);
  assert.equal((await page({view:'meals',args:{memberId:'owner'}})).status,400,'the page kitchen path reads no ledger');
  assert.equal((await page({op:'meal',args:{}})).status,400);
 }finally{
  for(const c of clients)await c.close().catch(()=>{});
  child.kill();await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('exit',r);setTimeout(r,1500).unref();});
  rmSync(dir,{force:true,recursive:true});
 }
});

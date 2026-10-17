import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {tokenHash} from '../family-accounts.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const A='a-'+randomBytes(32).toString('hex'),B='b-'+randomBytes(32).toString('hex'),LEGACY='old-'+randomBytes(32).toString('hex');
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'family-smoke',version:'1.0'}}};
async function freePort(){return new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
async function setup(){
 const dir=mkdtempSync(path.join(tmpdir(),'family-remote-'));
 const p=await freePort(),ui=await freePort();
 const users=path.join(dir,'members.json'),data=path.join(dir,'private');
 mkdirSync(data);writeFileSync(users,JSON.stringify({members:[
  {id:'alice',displayName:'Alice',timeZone:'UTC',tokenSha256:tokenHash(A)},
  {id:'bob',displayName:'Bob',timeZone:'Asia/Shanghai',tokenSha256:tokenHash(B)}
 ]}));
 const env={...process.env,PORT:String(ui),HOST:'127.0.0.1',DB_PATH:path.join(dir,'legacy.db'),
  MCP_HTTP_ENABLED:'1',MCP_HTTP_HOST:'127.0.0.1',MCP_HTTP_PORT:String(p),MCP_HTTP_TOKEN:LEGACY,
  FAMILY_REGISTRY_PATH:users,FAMILY_DATA_DIR:data};
 const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{cwd:root,env,stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',d=>err+=d.toString());const base=`http://127.0.0.1:${p}`;
 for(let i=0;i<130;i++){
  if(child.exitCode!==null)throw Error('Child failed '+err);
  try{const r=await fetch(base+'/mcp');if(r.status===401)return {base,dir,child,async close(){
     child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,900).unref()});rmSync(dir,{force:true,recursive:true});}};}catch{}
  await new Promise(r=>setTimeout(r,30));
 }
 child.kill();throw Error('Family endpoint not ready '+err);
}
async function conn(base,token){const client=new Client({name:'family-client',version:'1.0'});
 const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}});
 await client.connect(transport);return client;
}
const result=async (client,name,args={})=>{const x=await client.callTool({name,arguments:args});return {error:x.isError===true,data:JSON.parse(x.content[0].text)};};
test('remote family MCP isolates ledgers and limits sharing by caller identity',async()=>{
 const s=await setup();let a,b;
 try{
  for(const tok of [LEGACY,'bad-token']){
   const bad=await fetch(s.base+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json',Accept:'application/json,text/event-stream'},body:JSON.stringify(init)});
   assert.equal(bad.status,401);
  }
  a=await conn(s.base,A);b=await conn(s.base,B);
  const tools=await a.listTools();assert.ok(tools.tools.some(t=>t.name==='family_directory'));
  const aMeal=await result(a,'log_meal_items',{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'alice-a1'});
  assert.equal(aMeal.error,false);
  const ah=await result(a,'get_meal_history',{}),bh=await result(b,'get_meal_history',{});
  assert.equal(ah.data.meals.length,1);assert.equal(bh.data.meals.length,0);
  assert.equal((await result(a,'get_family_overview',{memberId:'bob'})).error,true);
  assert.equal((await result(b,'set_family_sharing',{granteeId:'alice',scope:'overview',enabled:true})).error,false);
  const shared=await result(a,'get_family_overview',{memberId:'bob'});
  assert.equal(shared.error,false);assert.equal(shared.data.memberId,'bob');
  assert.equal((await result(b,'set_family_sharing',{granteeId:'alice',scope:'overview',enabled:false})).error,false);
  assert.equal((await result(a,'get_family_overview',{memberId:'bob'})).error,true);
  const blank=await result(b,'export_nutrition_data',{fromDate:'2026-10-01',toDate:'2026-10-18'});
  assert.equal(blank.error,false);assert.equal(blank.data.meals.length,0);
 }finally{if(a)await a.close().catch(()=>{});if(b)await b.close().catch(()=>{});await s.close();}
});
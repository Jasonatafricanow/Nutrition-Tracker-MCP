import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import http from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TOKEN='test-'+randomBytes(24).toString('hex');
async function freePort() {return new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
async function setup(options={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'nutrition-remote-'));
  const p=await freePort(), ui=await freePort();
  const env={...process.env,MCP_TOOL_SURFACE:"full",PORT:String(ui),HOST:'127.0.0.1',DB_PATH:path.join(dir,'ledger.db'),NUTRITION_TIME_ZONE:'Asia/Shanghai',MCP_HTTP_ENABLED:'1',MCP_HTTP_PORT:String(p),MCP_HTTP_HOST:'127.0.0.1',MCP_HTTP_TOKEN:TOKEN,MCP_ALLOWED_ORIGINS:'http://agent.example.test',MCP_ALLOWED_HOSTS:'agent.example.test',...options};
  const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{cwd:root,env,stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',d=>errors+=d.toString());
  const base=`http://127.0.0.1:${p}`;
  for(let i=0;i<110;i++) {
    if(child.exitCode!==null) {rmSync(dir,{recursive:true,force:true});throw Error('server failed '+errors);}
    try {let r=await fetch(base+'/mcp');if(r.status===401) return {base,ui:`http://127.0.0.1:${ui}`,child,dir,get errors(){return errors;},async close(){child.kill();await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('exit',r);setTimeout(r,1500).unref()});rmSync(dir,{recursive:true,force:true});}};}catch{}
    await new Promise(r=>setTimeout(r,30));
  }
  child.kill();rmSync(dir,{recursive:true,force:true});throw Error('Server not ready: '+errors);
}
const post=(s,payload,token=TOKEN,extras={})=>fetch(s.base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(token?{Authorization:'Bearer '+token}:{}),...extras},body:JSON.stringify(payload)});
const rawHostPost=(port,host)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{Host:host,Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify(init));});
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'remote-smoke',version:'1.0'}}};
const connect=async base=>{const client=new Client({name:'remote-client',version:'1.0'});const transport=new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+TOKEN}}});await client.connect(transport);return {client,transport};};

test('remote endpoint enforces bearer auth, explicit hosts/origins and rejects GET',async()=>{
 const s=await setup();try{
   assert.equal((await post(s,init,null)).status,401);
   assert.equal((await post(s,init,'incorrect-token')).status,401);
   assert.equal((await post(s,init,TOKEN,{Origin:'https://evil.example'})).status,403);
   assert.equal(await rawHostPost(Number(new URL(s.base).port),'malicious.example'),403);
   assert.equal((await post(s,init,TOKEN,{Origin:'http://agent.example.test'})).status,200);
   const r=await fetch(s.base+'/mcp',{headers:{Authorization:'Bearer '+TOKEN}});
   assert.equal(r.status,405);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
   const origin=await fetch(s.base+'/mcp',{method:'OPTIONS',headers:{Origin:'https://evil.example',Authorization:'Bearer '+TOKEN}});
   assert.equal(origin.status,403);assert.equal(origin.headers.get('Access-Control-Allow-Origin'),null);
   assert.equal((await fetch(s.ui+'/api/snapshot')).status,200);
   assert.equal((await fetch(s.ui+'/mcp')).status,404);
   assert.equal((await fetch(s.base+'/api/snapshot')).status,404);
 }finally{await s.close();}
});

test('real Streamable HTTP MCP client handshake, prompts, tools and shared persisted ledger',async()=>{
 const s=await setup();let c1,c2;try{
   c1=await connect(s.base);
   const tools=await c1.client.listTools();
   for(const name of ['get_agent_context','search_foods','log_meal_items','stage_photo_estimate','update_meal_item']) assert.ok(tools.tools.some(t=>t.name===name),name);
   const prompts=await c1.client.listPrompts();
   assert.ok(prompts.prompts.some(p=>p.name==='nutrition_agent_workflow'));
   assert.ok(prompts.prompts.some(p=>p.name==='estimate_meal_photo'));
   const prompt=await c1.client.getPrompt({name:'estimate_meal_photo'});
   assert.ok(prompt.messages[0].content.text.includes('nutrition.photo_estimate.v1'));
   const food=await c1.client.callTool({name:'search_foods',arguments:{query:'米饭'}});
   assert.ok(JSON.parse(food.content[0].text).foods?.length>=1);
   const receipt=await c1.client.callTool({name:'log_meal_items',arguments:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'http-mcp-e2e-123'}});
   assert.equal(receipt.isError,undefined);
   // Stateless transport: no shared MCP session, but intentional common SQLite history.
   assert.equal(c1.transport.sessionId,undefined);
   c2=await connect(s.base);
   assert.equal(c2.transport.sessionId,undefined);
   const hist=await c2.client.callTool({name:'get_meal_history',arguments:{}});
   assert.equal(JSON.parse(hist.content[0].text).meals.length,1);
   const second=await c2.client.callTool({name:'log_meal_items',arguments:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'http-mcp-e2e-123'}});
   assert.equal(JSON.parse(second.content[0].text).duplicate,true);
 }finally{if(c1)await c1.client.close().catch(()=>{});if(c2)await c2.client.close().catch(()=>{});await s.close();}
});

test('remote refuses startup without a valid long bearer secret',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'nutrition-no-secret-'));
 const env={...process.env,MCP_TOOL_SURFACE:"full",HOST:'127.0.0.1',PORT:'0',DB_PATH:path.join(dir,'ledger.db'),MCP_HTTP_ENABLED:'1',MCP_HTTP_TOKEN:'short'};
 const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{cwd:root,env,stdio:['ignore','ignore','pipe']});
 let log='';child.stderr.on('data',d=>log+=d.toString());
 try {
   const status=await new Promise((resolve,reject)=>{child.on('exit',c=>resolve(c));child.on('error',reject);setTimeout(()=>reject(Error('server did not exit')),3000).unref()});
   assert.notEqual(status,0);assert.match(log,/MCP_HTTP_TOKEN must be a secret/);
 }finally{child.kill();rmSync(dir,{recursive:true,force:true});}
});

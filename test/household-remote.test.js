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
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TOKEN='test-household-token-32-bytes-minimum';
const freePort=()=>new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function setup(){
 const dir=mkdtempSync(path.join(tmpdir(),'household-remote-'));
 const config=path.join(dir,'config.json');
 writeFileSync(config,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'alex',name:'Alex',mode:'performance'},{id:'jo',name:'Jo'}]}));
 const port=await freePort(),ui=await freePort();
 const env={...process.env,MCP_TOOL_SURFACE:"full",HOUSEHOLD_CONFIG:config,HOUSEHOLD_DATA_DIR:dir,PORT:String(ui),HOST:'127.0.0.1',DB_PATH:path.join(dir,'legacy.db'),MCP_HTTP_ENABLED:'1',MCP_HTTP_PORT:String(port),MCP_HTTP_HOST:'127.0.0.1',MCP_HTTP_TOKEN:TOKEN};
 const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{env,cwd:root,stdio:['ignore','ignore','pipe']});
 let log='';child.stderr.on('data',d=>log+=String(d));const url=`http://127.0.0.1:${port}`;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('server failed: '+log);
  try {const r=await fetch(url+'/mcp');if(r.status===401)break;}catch{}
  await new Promise(r=>setTimeout(r,35));
  if(i===119)throw Error('server failed to start '+log);
 }
 const client=new Client({name:'household-e2e',version:'1.0'});
 const transport=new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+TOKEN}}});
 await client.connect(transport);
 return {client,ui:`http://127.0.0.1:${ui}`,async close(){await client.close();child.kill();await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('exit',r);setTimeout(r,1500).unref()});rmSync(dir,{force:true,recursive:true});}};
}
async function call(c,name,args={}){
 const r=await c.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);
 return JSON.parse(r.content[0].text);
}
test('real remote MCP provides household context, personal tools, health history and local family dashboard',async()=>{
 const s=await setup();try{
  const tools=await s.client.listTools();
  for(const name of ['get_household_context','member_nutrition_tool','log_household_observation','get_household_observations','acknowledge_household_note'])assert.ok(tools.tools.some(x=>x.name===name),name);
  const prompts=await s.client.listPrompts();assert.ok(prompts.prompts.some(x=>x.name==='household_agent_use'));
  const before=await call(s.client,'get_household_context');assert.equal(before.members.length,2);
  assert.equal(before.members[1].nutrition,null);
  await call(s.client,'member_nutrition_tool',{memberId:'jo',tool:'log_morning_checkin',args:{sleepHours:4.5}});
  await call(s.client,'member_nutrition_tool',{memberId:'alex',tool:'log_meal_items',args:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'alex-lunch'}});
  const observation=await call(s.client,'log_household_observation',{memberId:'jo',kind:'blood_pressure',systolic:117,diastolic:75});assert.ok(observation.ok);
  const context=await call(s.client,'get_household_context');assert.equal(context.members[1].latest.sleepHours,4.5);
  assert.equal(context.members[1].latest.bloodPressure.systolic,117);
  assert.equal(context.members[1].noteworthy[0].key,'short_sleep');
  assert.ok(context.members[0].nutrition.remaining.c<context.members[0].nutrition.targets.c);
  const obs=await call(s.client,'get_household_observations',{memberId:'jo'});assert.equal(obs.observations.length,1);
  await call(s.client,'acknowledge_household_note',{memberId:'jo',signal:'short_sleep'});
  assert.equal((await call(s.client,'get_household_context')).members[1].noteworthy.length,0);
  assert.equal((await fetch(s.ui+'/api/household')).status,200);
  const html=await(await fetch(s.ui+'/')).text();assert.ok(html.includes('household-panel'));
 }finally{await s.close();}
});

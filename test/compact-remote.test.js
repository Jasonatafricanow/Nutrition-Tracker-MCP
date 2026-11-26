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
const token='private-nas-bearer-very-long-sample-token';
const getPort=()=>new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
async function start(){
 const dir=mkdtempSync(path.join(tmpdir(),'compact-remote-'));
 const cfg=path.join(dir,'household.json');writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'a',name:'A',mode:'performance'},{id:'b',name:'B',mode:'general'}]}));
 const port=await getPort();
 const child=spawn(process.execPath,[path.join(root,'server.js'),'--no-stdio'],{cwd:root,env:{...process.env,MCP_TOOL_SURFACE:'compact',HOUSEHOLD_CONFIG:cfg,HOUSEHOLD_DATA_DIR:dir,DB_PATH:path.join(dir,'single.db'),PORT:'0',MCP_HTTP_ENABLED:'1',MCP_HTTP_HOST:'127.0.0.1',MCP_HTTP_PORT:String(port),MCP_HTTP_TOKEN:token},stdio:['ignore','ignore','pipe']});
 let log='';child.stderr.on('data',d=>log+=d);
 const url=`http://127.0.0.1:${port}/mcp`;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('server failed '+log);
  try{if((await fetch(url)).status===401)break;}catch{}
  await new Promise(r=>setTimeout(r,30));
  if(i===119)throw Error('remote did not start '+log);
 }
 const client=new Client({name:'remote-compact',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:'Bearer '+token}}});
 await client.connect(transport);
 return {client,async close(){await client.close();child.kill();await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('exit',r);setTimeout(r,1000).unref()});rmSync(dir,{recursive:true,force:true});}};
}
async function call(c,name,args){const r=await c.callTool({name,arguments:args});if(r.isError)throw Error(r.content[0].text);return JSON.parse(r.content[0].text);}
test('remote family host exposes only two tools; one write returns compact updated state',async()=>{
 const s=await start();try{
  const tools=await s.client.listTools();assert.deepEqual(tools.tools.map(x=>x.name).sort(),['nutrition_execute','nutrition_query']);
  let r=await call(s.client,'nutrition_execute',{operation:'checkin',memberId:'b',args:{sleepHours:5,rhrBpm:66}});
  assert.equal(r.context.memberId,'b');assert.equal(r.context.health.sleepHours,5);
  r=await call(s.client,'nutrition_query',{view:'household',focus:'health'});
  assert.equal(r.members.length,2);assert.equal(r.members[1].health.sleepHours,5);
  r=await call(s.client,'nutrition_query',{view:'foods',memberId:'a',queries:['米饭','鸡胸']});assert.equal(r.results.length,2);
  r=await call(s.client,'nutrition_execute',{operation:'meal',memberId:'a',args:{mealSlot:'晚餐',items:[{foodId:'f7',weightGrams:200}],requestId:'remote-compact-unique'}});
  assert.ok(r.context.nutrition.remaining.c<r.context.nutrition.targets.c);
  assert.equal((await call(s.client,'nutrition_query',{view:'meals',memberId:'a'})).meals.length,1);
  assert.equal((await call(s.client,'nutrition_query',{view:'meals',memberId:'b'})).meals.length,0);
 }finally{await s.close();}
});

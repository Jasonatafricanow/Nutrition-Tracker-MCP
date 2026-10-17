import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createEngine} from '../engine.js';
import {createHousehold} from '../household.js';
import {createAgentInterface} from '../agent-interface.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const NOW=new Date('2026-10-18T11:00:00Z');
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),'compact-surface-'));const config=path.join(dir,'household.json');
 writeFileSync(config,JSON.stringify({timeZone:'Asia/Shanghai',members:[{id:'a',name:'A',mode:'performance'},{id:'b',name:'B',mode:'general'}]}));
 const engine=createEngine(path.join(dir,'single.db'),{now:()=>NOW,timeZone:'Asia/Shanghai'});
 const household=createHousehold({configPath:config,dir,engineFactory:createEngine,now:()=>NOW});
 return {engine,household,api:createAgentInterface({engine,household}),close(){household.close();engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('one compact query serves household health and nutrition; no raw arrays or notes in routine output',async()=>{
 const f=fixture();try{
  f.api.execute({memberId:'b',operation:'checkin',args:{sleepHours:4.5,rhrBpm:82}});
  f.api.execute({memberId:'a',operation:'meal',args:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'a-one'}});
  f.api.execute({memberId:'b',operation:'health_observation',args:{kind:'blood_pressure',systolic:119,diastolic:76,note:'not in overview'}});
  const c=await f.api.query({view:'household'});
  assert.equal(c.members.length,2);assert.equal(c.members[1].health.sleepHours,4.5);
  assert.equal(c.members[1].health.bloodPressure.systolic,119);
  assert.equal(c.members[1].noteworthy[0].key,'short_sleep');
  assert.ok(c.members[0].nutrition.remaining.c<c.members[0].nutrition.targets.c);
  assert.equal(c.members[1].nutrition,undefined);
  assert.equal(JSON.stringify(c).includes('not in overview'),false);
  assert.equal(JSON.stringify(c).includes('observations'),false);
  const member=await f.api.query({view:'member',memberId:'b',focus:'health'});
  assert.equal(member.members.length,1);assert.equal(member.members[0].nutrition,undefined);
  const food=await f.api.query({view:'household',focus:'food'});
  assert.equal(food.members[0].health,undefined);
 }finally{f.close();}
});
test('search several foods in ONE read, bound result size and preserve source food IDs',async()=>{
 const f=fixture();try{
  const foods=await f.api.query({view:'foods',memberId:'a',queries:['米饭','鸡胸'],limit:2});
  assert.equal(foods.results.length,2);
  assert.ok(foods.results[0].foods.some(x=>x.id==='f7'));
  assert.ok(foods.results.every(x=>x.foods.length<=2));
  await assert.rejects(f.api.query({view:'foods',memberId:'a',queries:Array(7).fill('米饭')}),/1–6/);
  await assert.rejects(f.api.query({view:'foods',queries:['米饭']}),/memberId required/);
 }finally{f.close();}
});
test('one validated meal write and retry stay atomic and idempotent; wrong member rejected',async()=>{
 const f=fixture();try{
  const params={memberId:'a',operation:'meal',args:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'a-two'}};
  const saved=f.api.execute(params);assert.equal(saved.mealIds.length,1);
  assert.equal(saved.context.memberId,'a');
  assert.ok(saved.context.nutrition.remaining.c<saved.context.nutrition.targets.c);
  assert.equal(f.api.execute({...params,includeContext:false}).context,undefined);
  assert.equal(f.api.execute(params).duplicate,true);
  assert.equal((await f.api.query({view:'meals',memberId:'a'})).meals.length,1);
  assert.equal((await f.api.query({view:'meals',memberId:'b'})).meals.length,0);
  assert.throws(()=>f.api.execute({...params,memberId:'unknown'}),/unknown memberId/);
  assert.throws(()=>f.api.execute({...params,args:{...params.args,items:[{foodId:'f7',weightGrams:-1}]}}),/参数错误/);
 }finally{f.close();}
});
test('health entry and normal checkin are separate operations; read detail only when asked',async()=>{
 const f=fixture();try{
  f.api.execute({memberId:'b',operation:'health_observation',args:{kind:'symptom_note',note:'tired today'}});
  assert.equal((await f.api.query({view:'health_history',memberId:'b'})).observations[0].note,'tired today');
  assert.equal(JSON.stringify(await f.api.query({view:'household'})).includes('tired today'),false);
  assert.throws(()=>f.api.execute({memberId:'b',operation:'advanced',tool:'get_snapshot'}),/unsupported/);
  assert.throws(()=>f.api.execute({memberId:'b',operation:'meal',args:{}}),/参数错误/);
 }finally{f.close();}
});
test('single-person compact query preserves fast personal use without requiring memberId',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'single-compact-'));const engine=createEngine(path.join(dir,'db.db'));
 try{
  const a=createAgentInterface({engine});const c=await a.query({view:'household'});
  assert.equal(c.scope,'single_person');assert.ok(c.targets.kcal>0);
  assert.throws(()=>a.execute({memberId:'b',operation:'checkin',args:{sleepHours:7}}),/requires household mode/);
  const r=a.execute({operation:'meal',args:{mealSlot:'早餐',items:[{foodId:'f7',weightGrams:120}],requestId:'single-meal'}});
  assert.equal(r.mealIds.length,1);assert.ok(r.context.remaining.c>=0);
 }finally{engine.close();rmSync(dir,{force:true,recursive:true});}
});
async function launch(surface){
 const dir=mkdtempSync(path.join(tmpdir(),'compact-mcp-'));const client=new Client({name:'surface-probe',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.js')],env:{...process.env,MCP_TOOL_SURFACE:surface,DB_PATH:path.join(dir,'db.db'),PORT:'0'}});
 await client.connect(transport);
 return {client,dir,async close(){await client.close();rmSync(dir,{recursive:true,force:true});}};
}
test('default real MCP catalog is two tools and substantially smaller than opt-in legacy catalog',async()=>{
 const a=await launch('compact'),b=await launch('full');
 try{
  const c=await a.client.listTools(),old=await b.client.listTools();
  assert.deepEqual(c.tools.map(x=>x.name).sort(),['nutrition_execute','nutrition_query']);
  assert.ok(old.tools.length>=25);
  const slim=JSON.stringify(c.tools).length,legacy=JSON.stringify(old.tools).length;
  assert.ok(slim<legacy*0.30,`catalog did not shrink enough ${slim}/${legacy}`);
  const r=await a.client.callTool({name:'nutrition_query',arguments:{view:'foods',queries:['米饭','鸡胸']}});
  assert.equal(r.isError,undefined);assert.equal(JSON.parse(r.content[0].text).results.length,2);
  const w=await a.client.callTool({name:'nutrition_execute',arguments:{operation:'meal',args:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'real-client-1'}}});
  assert.equal(w.isError,undefined);
  assert.equal((await a.client.listPrompts()).prompts.some(x=>x.name==='estimate_meal_photo'),true);
  const prompt=await a.client.getPrompt({name:'nutrition_agent_workflow'});
  const words=prompt.messages[0].content.text;
  assert.ok(words.includes('nutrition_query')&&words.includes('nutrition_execute'));
  assert.ok(!words.includes('call get_agent_context'));
  console.log('MCP tool catalog sizes:',JSON.stringify({compactTools:c.tools.length,fullTools:old.tools.length,compactChars:slim,fullChars:legacy,ratio:Math.round(100*slim/legacy)+'%'}));
 }finally{await a.close();await b.close();}
});

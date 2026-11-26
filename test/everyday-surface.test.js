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
import {createEverydayInterface,EVERYDAY_READS,EVERYDAY_WRITES} from '../everyday-interface.js';
import {PHOTO_ESTIMATE_EXAMPLE} from '../photo-estimation.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TODAY=new Date('2026-10-18T03:00:00Z');
function makeFixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'nutrition-everyday-'));
 const cfg=path.join(dir,'household.json');
 writeFileSync(cfg,JSON.stringify({timeZone:'Asia/Shanghai',members:[
   {id:'a',name:'A',mode:'performance'},{id:'b',name:'B',mode:'general'}
 ]}));
 const engine=createEngine(path.join(dir,'single.db'),{now:()=>TODAY,timeZone:'Asia/Shanghai'});
 const family=createHousehold({configPath:cfg,dir,engineFactory:createEngine,now:()=>TODAY});
 const compact=createAgentInterface({engine,household:family});
 const api=createEverydayInterface(compact);
 return {dir,engine,family,api,close(){family.close();engine.close();rmSync(dir,{recursive:true,force:true})}};
}
function exec(api,operation,args,memberId='b'){
 return api.execute({memberId,operation,args});
}

test('only 3 read and 5 write intents, no universal backdoor',async()=>{
 assert.deepEqual(EVERYDAY_READS,['summary','meals','foods']);
 assert.deepEqual(EVERYDAY_WRITES,['meal','correct','health','photo_stage','photo_confirm']);
 const f=makeFixture();try{
  await assert.rejects(f.api.query({view:'capabilities'}),/Unsupported everyday read/);
  await assert.rejects(f.api.query({view:'barcode',barcode:'0123456789012'}),/Unsupported everyday read/);
  assert.throws(()=>exec(f.api,'advanced',{tool:'delete_meal_item'}),/Unsupported everyday write/);
  assert.throws(()=>exec(f.api,'plan',{carbLevel:'high'}),/Unsupported everyday write/);
  assert.throws(()=>exec(f.api,'food_add',{name:'New',p:0,c:0,f:0}),/Unsupported everyday write/);
  assert.throws(()=>exec(f.api,'supplement',{supplementId:'whey',taken:true}),/Unsupported everyday write/);
  assert.throws(()=>exec(f.api,'meal',{mealSlot:'午餐',source:'photo',requestId:'no',items:[]}),/images require photo_stage/);
 }finally{f.close()}
});

test('one meal intent supports approximate and strict measured provenance, without dupes',async()=>{
 const f=makeFixture();try{
  const estimated={mealSlot:'午餐',requestId:'text-1',items:[
   {name:'米饭',weightGrams:150,foodId:'f7'},
   {name:'家常炒蛋',weightGrams:120,p:10,c:4,f:12}
  ]};
  const r=exec(f.api,'meal',estimated);
  assert.equal(r.estimated,true);assert.equal(r.mealIds.length,2);
  assert.equal(exec(f.api,'meal',estimated).duplicate,true);
  const strict=exec(f.api,'meal',{
   mealSlot:'晚餐',source:'measured',requestId:'measured-1',
   items:[{foodId:'f7',weightGrams:135}]
  });
  assert.equal(strict.mealIds.length,1);
  const ledger=await f.api.query({view:'meals',memberId:'b'});
  assert.equal(ledger.meals.length,3);
  assert.ok(ledger.meals.some(x=>x.source_kind==='agent_text_estimate'));
  assert.ok(ledger.meals.some(x=>x.source_kind!=='agent_text_estimate'));
  assert.equal((await f.api.query({view:'meals',memberId:'a'})).meals.length,0);
  assert.equal(r.context.memberId,'b');
 }finally{f.close()}
});

test('one correction intent resolves recent name or versioned ID; ambiguous paths fail',async()=>{
 const f=makeFixture();try{
  const r=exec(f.api,'meal',{mealSlot:'早餐',requestId:'correct-base',
   items:[{name:'米饭',weightGrams:150,foodId:'f7'}]});
  const fix=exec(f.api,'correct',{foodName:'米饭',weightGrams:200,requestId:'correct-name'});
  assert.equal(fix.after.weightGrams,200);
  assert.throws(()=>exec(f.api,'correct',{mealId:r.mealIds[0],weightGrams:220,
   requestId:'no-version'}),/expectedRevision/);
  const older=exec(f.api,'correct',{mealId:r.mealIds[0],expectedRevision:1,
   weightGrams:220,requestId:'correct-id'});
  assert.equal(older.after.revision,2);
  const audit=f.family.memberTool('b','get_meal_corrections',{mealId:r.mealIds[0]});
  assert.equal(audit.corrections.length,2);
  assert.throws(()=>exec(f.api,'correct',{weightGrams:100,requestId:'empty'}),/requires mealId/);
 }finally{f.close()}
});

test('health is one user intent while member measurements keep their data semantics',async()=>{
 const f=makeFixture();try{
  const measurement=exec(f.api,'health',{sleepHours:5,rhrBpm:71});
  assert.equal(measurement.context.health.sleepHours,5);
  const obs=exec(f.api,'health',{kind:'blood_pressure',systolic:118,diastolic:77,
    sourceEventId:'bp-1'});
  assert.ok(obs.id);
  const view=await f.api.query({view:'summary',memberId:'b',focus:'health'});
  assert.equal(view.members[0].health.bloodPressure.systolic,118);
  const home=await f.api.query({view:'summary'});
  assert.equal(home.members.length,2);
  assert.equal(home.members[1].health.sleepHours,5);
 }finally{f.close()}
});

test('summary period 7d/30d reuses actual observed-day report, not fabricated zeros',async()=>{
 const f=makeFixture();try{
  exec(f.api,'meal',{mealSlot:'午餐',requestId:'report-meal',
   items:[{name:'米饭',weightGrams:100,foodId:'f7'}]});
  const week=await f.api.query({view:'summary',period:'7d',memberId:'b'});
  const month=await f.api.query({view:'summary',period:'30d',memberId:'b'});
  assert.equal(week.periodDays,7);
  assert.equal(month.periodDays,30);
  assert.equal(week.nutrition.daysWithMeals,1);
  assert.equal(month.nutrition.daysWithMeals,1);
  await assert.rejects(f.api.query({view:'summary',period:'14d',memberId:'b'}),/period/);
  await assert.rejects(f.api.query({view:'foods',memberId:'b',queries:[]}),/1–6/);
  const foods=await f.api.query({view:'foods',memberId:'b',queries:['米饭','鸡胸'],limit:2});
  assert.equal(foods.source,'local');assert.equal(foods.results.length,2);
 }finally{f.close()}
});

test('photos still stage before one explicit confirmation, and images cannot use text path',async()=>{
 const f=makeFixture();try{
  const estimate=structuredClone(PHOTO_ESTIMATE_EXAMPLE);
  const preview=exec(f.api,'photo_stage',{mealSlot:'午餐',estimate,
    matches:[{itemId:'item-1',foodId:'f7'}]});
  assert.equal(preview.reviewRequired,true);
  assert.equal((await f.api.query({view:'meals',memberId:'b'})).meals.length,0);
  assert.throws(()=>exec(f.api,'photo_confirm',{draftId:preview.draftId,
    confirmed:false,requestId:'unapproved',decisions:[]}),/参数错误|confirmed/);
  assert.equal((await f.api.query({view:'meals',memberId:'b'})).meals.length,0);
  const result=exec(f.api,'photo_confirm',{
    draftId:preview.draftId,confirmed:true,
    confirmationEvidence:{channel:'user_message',summary:'User accepted one combined preview'},
    requestId:'approved-photo',
    decisions:[{index:0,include:true,weightGrams:170,portionSource:'visual_estimate'},
               {index:1,include:false}]
  });
  assert.equal(result.mealIds.length,1);
  const ledger=await f.api.query({view:'meals',memberId:'b'});
  assert.equal(ledger.meals[0].source_kind,'agent_photo_confirmed');
 }finally{f.close()}
});

test('stdio DEFAULT exposes same 2 tools but much smaller enum choices and contract',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'everyday-mcp-'));
 const client=new Client({name:'everyday-surface-probe',version:'1'});
 const env={...process.env,DB_PATH:path.join(dir,'data.db'),PORT:'0'};
 delete env.MCP_TOOL_SURFACE;
 const transport=new StdioClientTransport({command:process.execPath,
   args:[path.join(root,'server.js')],env});
 try{
  await client.connect(transport);
  const catalog=await client.listTools();
  assert.deepEqual(catalog.tools.map(x=>x.name).sort(),['nutrition_execute','nutrition_query']);
  const query=catalog.tools.find(x=>x.name==='nutrition_query');
  const write=catalog.tools.find(x=>x.name==='nutrition_execute');
  assert.deepEqual(query.inputSchema.properties.view.enum,EVERYDAY_READS);
  assert.deepEqual(write.inputSchema.properties.operation.enum,EVERYDAY_WRITES);
  assert.ok(!JSON.stringify(write.inputSchema).includes('advanced'));
  const guide=await client.getPrompt({name:'nutrition_agent_workflow'});
  assert.match(guide.messages[0].content.text,/THREE read intents/);
  const result=await client.callTool({name:'nutrition_execute',
    arguments:{operation:'meal',args:{mealSlot:'午餐',requestId:'first-real-write',
      items:[{name:'米饭',weightGrams:140,foodId:'f7'}]}}});
  assert.equal(result.isError,undefined);
  const data=JSON.parse(result.content[0].text);
  assert.equal(data.estimated,true);
  const old=await client.callTool({name:'nutrition_execute',
    arguments:{operation:'advanced',tool:'set_profile',args:{}}});
  assert.equal(old.isError,true);
  console.log('Nutrition everyday MCP enums:',JSON.stringify({
    reads:query.inputSchema.properties.view.enum.length,
    writes:write.inputSchema.properties.operation.enum.length,
    querySchemaChars:JSON.stringify(query.inputSchema).length,
    executeSchemaChars:JSON.stringify(write.inputSchema).length
  }));
 }finally{
  await client.close();
  rmSync(dir,{recursive:true,force:true});
 }
});

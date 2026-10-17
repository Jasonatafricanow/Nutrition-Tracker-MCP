import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createEngine,TOOL_DEFS} from '../engine.js';
import {photoEstimateSchema,PHOTO_ESTIMATE_EXAMPLE,PHOTO_ESTIMATION_PROMPT,PHOTO_ESTIMATE_VERSION} from '../photo-estimation.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(){const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-compiler-'));
 const e=createEngine(path.join(dir,'test.db'),{now:()=>new Date('2026-10-17T08:00:00+08:00'),timeZone:'Asia/Shanghai'});
 return {e,close(){e.close();rmSync(dir,{force:true,recursive:true});}};}
function estimate(){return structuredClone(PHOTO_ESTIMATE_EXAMPLE);}

test('the photo protocol defines a machine-readable downstream artifact rather than a caption',()=>{
 assert.ok(TOOL_DEFS.stage_photo_estimate);
 assert.equal(photoEstimateSchema.parse(estimate()).schemaVersion,PHOTO_ESTIMATE_VERSION);
 for(const term of ['GRAMS','VISIBLE','unknown','min','max','uncertainty','no calories','foodId','not_estimable'])
  assert.ok(PHOTO_ESTIMATION_PROMPT.toLowerCase().includes(term.toLowerCase()),term);
});
test('rejects text captions, unknown keys, fabricated precise visual weight, and impossible ranges',()=>{
 const f=fixture();try{
  assert.throws(()=>f.e.execute('stage_photo_estimate',{mealSlot:'午餐',estimate:'rice, 200g'}),/参数错误/);
  const extra=estimate();extra.items[0].calories=250;
  assert.equal(photoEstimateSchema.safeParse(extra).success,false);
  const exact=estimate();exact.items[0].ediblePortion.minGrams=180;exact.items[0].ediblePortion.maxGrams=180;
  assert.equal(photoEstimateSchema.safeParse(exact).success,false);
  const bad=estimate();bad.items[0].ediblePortion.grams=360;
  assert.equal(photoEstimateSchema.safeParse(bad).success,false);
  const falseScale=estimate();falseScale.items[0].ediblePortion.method='reference_object';
  assert.equal(photoEstimateSchema.safeParse(falseScale).success,false);
 }finally{f.close();}
});
test('uncertain or obscured foods can have null weights; hidden oil stays unresolved',()=>{
 const x=photoEstimateSchema.parse(estimate());
 assert.equal(x.items[1].ediblePortion.grams,null);
 assert.ok(x.hiddenOrUnquantified.some(v=>/oil/i.test(v)));
 const f=fixture();try{
   const draft=f.e.execute('stage_photo_estimate',{date:'2026-10-17',mealSlot:'午餐',estimate:x,matches:[{itemId:'item-1',foodId:'f7'}]});
   assert.equal(draft.compilationStatus,'validated_unconfirmed');
   assert.equal(draft.items[0].estimated.c,50.4); // 180g cooked rice from local database
   assert.equal(draft.items[1].needsFoodMatch,true);
   assert.ok(draft.hiddenOrUnquantified.some(v=>/oil/i.test(v)));
   assert.equal(f.e.execute('get_meal_history',{}).meals.length,0);
   assert.equal(f.e.execute('get_agent_context',{}).pendingPhotoDrafts.length,1);
   const saved=f.e.execute('get_photo_meal_draft',{draftId:draft.draftId});
   assert.deepEqual(saved.compiledEstimate,x);
   assert.throws(()=>f.e.execute('confirm_photo_meal',{draftId:draft.draftId,confirmed:true,confirmationEvidence:{channel:'user_message',summary:'User explicitly confirmed item and estimated portion'},requestId:'once',decisions:[{index:0,include:true,weightGrams:180,portionSource:'visual_estimate'}]}),/每个照片候选/);
   const confirm=f.e.execute('confirm_photo_meal',{draftId:draft.draftId,confirmed:true,confirmationEvidence:{channel:'user_message',summary:'User explicitly confirmed item and estimated portion'},requestId:'once',decisions:[{index:0,include:true,weightGrams:180,portionSource:'visual_estimate'},{index:1,include:false}]});
   assert.equal(confirm.partial,true);
   assert.equal(f.e.execute('get_meal_history',{}).meals.length,1);
 }finally{f.close();}
});
test('no foodId fabricated by the image compilation; invalid food matches fail atomically',()=>{
 const f=fixture();try{
   assert.throws(()=>f.e.execute('stage_photo_estimate',{mealSlot:'午餐',estimate:estimate(),matches:[{itemId:'item-1',foodId:'fabricated-food'}]}),/食材库找不到/);
   assert.throws(()=>f.e.execute('stage_photo_estimate',{mealSlot:'午餐',estimate:estimate(),matches:[{itemId:'item-900',foodId:'f7'}]}),/未识别/);
   assert.equal(f.e.execute('get_agent_context',{}).pendingPhotoDrafts.length,0);
 }finally{f.close();}
});
test('MCP prompt discovery and compile/confirm work through an actual stdio client', async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'nutrition-photo-mcp-'));
 const client=new Client({name:'photo-compiler-test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.js')],env:{...process.env,DB_PATH:path.join(dir,'db.sqlite'),PORT:'0',HOST:'127.0.0.1',NUTRITION_TIME_ZONE:'Asia/Shanghai'}});
 try{
   await client.connect(transport);
   const prompts=await client.listPrompts();
   assert.ok(prompts.prompts.some(x=>x.name==='estimate_meal_photo'));
   const prompt=await client.getPrompt({name:'estimate_meal_photo'});
   assert.ok(prompt.messages[0].content.text.includes(PHOTO_ESTIMATE_VERSION));
   const catalog=await client.listTools();
   for(const name of ['get_photo_estimation_protocol','stage_photo_estimate','get_photo_meal_draft','confirm_photo_meal'])
     assert.ok(catalog.tools.some(x=>x.name===name),name);
   const analysis=await client.callTool({name:'stage_photo_estimate',arguments:{mealSlot:'午餐',estimate:estimate(),matches:[{itemId:'item-1',foodId:'f7'}]}});
   assert.equal(analysis.isError,undefined);
   const draft=JSON.parse(analysis.content[0].text);
   assert.equal(draft.photoStored,false);
   const history=await client.callTool({name:'get_meal_history',arguments:{}});
   assert.equal(JSON.parse(history.content[0].text).meals.length,0);
 }finally{await client.close();rmSync(dir,{force:true,recursive:true});}
});

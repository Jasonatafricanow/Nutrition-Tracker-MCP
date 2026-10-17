import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {createEngine} from '../engine.js';
import {createUSDAClient,extractMacros} from '../usda-foods.js';
import {AGENT_WORKFLOW} from '../agent-workflow.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(){const dir=mkdtempSync(path.join(tmpdir(),'nutrition-correction-'));const filename=path.join(dir,'state.db');const e=createEngine(filename,{now:()=>new Date('2026-10-17T07:00:00+08:00'),timeZone:'Asia/Shanghai'});return {e,filename,close(){e.close();rmSync(dir,{recursive:true,force:true});}};}
function seed(f){const r=f.e.execute('log_meal_items',{date:'2026-10-16',mealSlot:'午餐',requestId:'seed-meal',items:[{foodId:'f7',weightGrams:200}]});return r.mealIds[0];}
function correct(f,id,extra={}){return f.e.execute('update_meal_item',{mealId:id,expectedRevision:0,requestId:'correction-1',weightGrams:100,...extra});}

test('correction scales saved nutrition, keeps stable meal identity and invalidates day completeness',()=>{
 const f=fixture();try{const id=seed(f);f.e.execute('mark_intake_complete',{date:'2026-10-16'});
 const before=f.e.execute('get_meal_history',{date:'2026-10-16'});assert.equal(before.meals[0].revision,0);
 const r=correct(f,id);assert.equal(r.before.weightGrams,200);assert.equal(r.after.weightGrams,100);assert.equal(r.after.revision,1);
 const after=f.e.execute('get_meal_history',{date:'2026-10-16'});assert.equal(after.meals.length,1);assert.equal(after.meals[0].id,id);assert.equal(after.meals[0].c,28);assert.equal(after.intakeComplete,false);
 const audit=f.e.execute('get_meal_corrections',{mealId:id}).corrections;assert.equal(audit.length,1);assert.equal(audit[0].before.weight_g,200);assert.equal(audit[0].after.weight_g,100);
 }finally{f.close();}
});
test('idempotent correction retry does not apply twice or append audit entries',()=>{
 const f=fixture();try{const id=seed(f);const a=correct(f,id);const b=correct(f,id);assert.equal(b.duplicate,true);assert.deepEqual(b.after,a.after);
 assert.equal(f.e.execute('get_meal_corrections',{mealId:id}).corrections.length,1);
 assert.throws(()=>correct(f,id,{weightGrams:120}),/requestId/);
 }finally{f.close();}
});
test('stale revision cannot overwrite a later Agent correction',()=>{
 const f=fixture();try{const id=seed(f);correct(f,id);
 assert.throws(()=>correct(f,id,{requestId:'different-request'}),/版本/);
 assert.equal(f.e.execute('get_meal_corrections',{mealId:id}).corrections.length,1);
 }finally{f.close();}
});
test('bad correction is atomic; corrected request may succeed afterwards',()=>{
 const f=fixture();try{const id=seed(f);
 assert.throws(()=>correct(f,id,{p:200,c:100,f:0,nutritionSource:'food_label'}),/质量/);
 assert.equal(f.e.execute('get_meal_corrections',{mealId:id}).corrections.length,0);
 assert.equal(correct(f,id).after.revision,1);
 }finally{f.close();}
});
test('food ID correction switches identity and recomputes grams from verified local food',()=>{
 const f=fixture();try{const id=seed(f);
 const r=correct(f,id,{foodId:'f1',name:'Chicken corrected',weightGrams:150});
 assert.equal(r.after.p,36);assert.equal(f.e.execute('get_meal_history',{date:'2026-10-16'}).meals[0].name,'Chicken corrected');
 }finally{f.close();}
});
test('legacy SQLite data migrates revision and retains meals on restart',()=>{
 const f=fixture();try{const id=seed(f);f.e.close();const d=new DatabaseSync(f.filename);
 d.exec('UPDATE meal_logs SET revision=0');d.close();const e=createEngine(f.filename,{now:()=>new Date('2026-10-17T07:00:00+08:00'),timeZone:'Asia/Shanghai'});
 assert.equal(e.execute('get_meal_history',{date:'2026-10-16'}).meals[0].revision,0);
 const a=e.execute('update_meal_item',{mealId:id,expectedRevision:0,requestId:'after-restart',weightGrams:120});assert.equal(a.after.revision,1);e.close();
 }finally{rmSync(path.dirname(f.filename),{recursive:true,force:true});}
});
test('photo confirmation requires a described provenance and persists it',()=>{
 const f=fixture();try{const draft=f.e.execute('prepare_photo_meal',{mealSlot:'午餐',items:[{name:'米饭',foodId:'f7',estimatedWeightGrams:100}]});
 const base={draftId:draft.draftId,confirmed:true,requestId:'photo-approved',decisions:[{index:0,include:true,weightGrams:100,portionSource:'visual_estimate'}]};
 assert.throws(()=>f.e.execute('confirm_photo_meal',base),/confirmationEvidence/);
 const confirm=f.e.execute('confirm_photo_meal',{...base,confirmationEvidence:{channel:'user_message',summary:'User approved one portion at 100g',reference:'host-msg-100'}});
 assert.equal(confirm.ok,true);
 const read=f.e.execute('get_photo_meal_draft',{draftId:draft.draftId});assert.equal(read.confirmationEvidence.reference,'host-msg-100');
 }finally{f.close();}
});
test('USDA mapper rejects unsupported food types, incomplete panels and non-gram units',()=>{
 const complete={dataType:'Foundation',foodNutrients:[{nutrient:{id:1003,unitName:'g'},amount:20},{nutrient:{id:1005,unitName:'g'},amount:2},{nutrient:{id:1004,unitName:'g'},amount:5}]};
 assert.deepEqual(extractMacros(complete),{p:20,f:5,c:2});
 assert.equal(extractMacros({...complete,dataType:'Branded'}),null);
 assert.equal(extractMacros({...complete,foodNutrients:complete.foodNutrients.slice(0,2)}),null);
 assert.equal(extractMacros({...complete,foodNutrients:complete.foodNutrients.map(x=>({...x,nutrient:{...x.nutrient,unitName:'kcal'}}))}),null);
});
test('USDA search and detail use real FDC paths, bounded results and normalized units',async()=>{
 const calls=[];const responder=async input=>{const url=new URL(input);calls.push(url);
 const food={fdcId:123,description:'Prepared chicken',dataType:'Foundation',foodNutrients:[{nutrientId:1003,unitName:'G',value:25},{nutrientId:1005,unitName:'G',value:0},{nutrientId:1004,unitName:'G',value:2}]};
 const detail={...food,foodNutrients:[{nutrient:{id:1003,unitName:'G'},amount:25},{nutrient:{id:1005,unitName:'G'},amount:0},{nutrient:{id:1004,unitName:'G'},amount:2}]};
 return {ok:true,json:async()=>url.pathname.endsWith('search')?{foods:[food,{...food,fdcId:2,dataType:'Branded'}]}:detail};};
 const c=createUSDAClient({apiKey:'test-opaque-key',fetchImpl:responder});
 const search=await c.search('chicken',2);assert.equal(search.foods.length,1);assert.equal(search.foods[0].fdcId,123);
 const details=await c.details(123);assert.equal(details.usable,true);assert.deepEqual(details.per100g,{p:25,f:2,c:0});
 assert.equal(calls[0].searchParams.get('api_key'),'test-opaque-key');assert.equal(calls[0].searchParams.get('dataType'),'Foundation,SR Legacy');
 assert.equal(calls[1].pathname,'/fdc/v1/food/123');
});
test('without USDA key, no network call is made and failure is explicit',async()=>{
 let called=0;const c=createUSDAClient({apiKey:'',fetchImpl:async()=>{called++;return {ok:true};}});
 await assert.rejects(c.search('rice'),/FDC_API_KEY/);assert.equal(called,0);
});
test('workflow explicitly routes photo, correction, USDA and confirmation through MCP',()=>{
 for(const token of ['stage_photo_estimate','confirm_photo_meal','update_meal_item','get_meal_history','search_usda_foods','nutrition.photo_estimate.v1'])assert.ok(AGENT_WORKFLOW.includes(token),token);
});
test('real stdio MCP client discovers workflow prompt and optional read-only USDA tools',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'nutrition-agent-e2e-'));const client=new Client({name:'workflow-test',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.js')],env:{...process.env,DB_PATH:path.join(dir,'state.db'),NUTRITION_TIME_ZONE:'Asia/Shanghai',PORT:'0',FDC_API_KEY:''}});
 try{await client.connect(transport);
 const tools=await client.listTools();for(const name of ['update_meal_item','get_meal_corrections','search_usda_foods','get_usda_food_details','get_agent_workflow'])assert.ok(tools.tools.some(t=>t.name===name),name);
 const prompts=await client.listPrompts();assert.ok(prompts.prompts.some(p=>p.name==='nutrition_agent_workflow'));
 const flow=await client.getPrompt({name:'nutrition_agent_workflow'});assert.ok(flow.messages[0].content.text.includes('update_meal_item'));
 const disabled=await client.callTool({name:'search_usda_foods',arguments:{query:'rice'}});assert.equal(disabled.isError,true);
 }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});

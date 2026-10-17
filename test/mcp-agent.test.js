import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('real stdio MCP client lists agent-first tools and roundtrips a meal record',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'nutri-mcp-e2e-'));
 const client=new Client({name:'agent-first-e2e',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.js')],env:{...process.env,MCP_TOOL_SURFACE:"full",DB_PATH:path.join(dir,'test.db'),PORT:'0',HOST:'127.0.0.1',NUTRITION_TIME_ZONE:'Asia/Shanghai'}});
 try {
   await client.connect(transport);
   const catalog=await client.listTools();
   for(const name of ['get_agent_context','search_foods','save_meal_template','log_meal_template','export_nutrition_data'])assert.ok(catalog.tools.some(t=>t.name===name),name);
   const context=await client.callTool({name:'get_agent_context',arguments:{}});
   assert.equal(context.isError,undefined);
   assert.ok(JSON.parse(context.content[0].text).date);
   const write=await client.callTool({name:'log_meal_items',arguments:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'e2e-meal-unique'}});
   assert.equal(write.isError,undefined);
   const writeData=JSON.parse(write.content[0].text);assert.equal(writeData.mealIds.length,1);
   const again=await client.callTool({name:'log_meal_items',arguments:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'e2e-meal-unique'}});
   assert.equal(JSON.parse(again.content[0].text).duplicate,true);
   const hist=await client.callTool({name:'get_meal_history',arguments:{}});
   assert.equal(JSON.parse(hist.content[0].text).meals.length,1);
 } finally {await client.close();rmSync(dir,{recursive:true,force:true});}
});

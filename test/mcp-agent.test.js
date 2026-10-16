import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
test("real stdio MCP handshake, tool listing, logging, replay idempotency and history",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"agent-mcp-e2e-"));
 const client=new Client({name:"agent-e2e",version:"1.0"});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,"server.js")],env:{...process.env,DB_PATH:path.join(dir,"test.db"),PORT:"0",HOST:"127.0.0.1",NUTRITION_TIME_ZONE:"Asia/Shanghai"}});
 try{
   await client.connect(transport);
   const list=await client.listTools();
   for(const name of ["get_agent_context","search_foods","save_meal_template","log_meal_template","export_nutrition_data"])assert.ok(list.tools.some(t=>t.name===name),name);
   const context=await client.callTool({name:"get_agent_context",arguments:{}});
   assert.ok(JSON.parse(context.content[0].text).date);
   const args={mealSlot:"午餐",items:[{foodId:"f7",weightGrams:150}],requestId:"mcp-e2e-unique"};
   const a=await client.callTool({name:"log_meal_items",arguments:args});
   assert.equal(a.isError,undefined);
   const b=await client.callTool({name:"log_meal_items",arguments:args});
   assert.equal(JSON.parse(b.content[0].text).duplicate,true);
   const hist=await client.callTool({name:"get_meal_history",arguments:{}});
   assert.equal(JSON.parse(hist.content[0].text).meals.length,1);
 }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});

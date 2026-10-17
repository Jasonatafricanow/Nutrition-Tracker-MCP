// Nutrition Tracker MCP v5.2 experimental：同一进程里同时提供
//   - stdio MCP 工具（给 Claude Desktop / Claude Code 等 Agent 调用）
//   - HTTP 观察窗 + SSE 实时推送 + 手机健康 Webhook
// 多个进程共用同一个 SQLite 文件时，靠 PRAGMA data_version 轮询感知别的进程的写入。
import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEngine, TOOL_DEFS, ToolError } from "./engine.js";
import { PHOTO_ESTIMATION_PROMPT } from "./photo-estimation.js";
import { AGENT_WORKFLOW, AGENT_WORKFLOW_VERSION } from "./agent-workflow.js";
import { createUSDAClient } from "./usda-foods.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.argv.includes("--demo");
const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, DEMO ? "macro_demo.db" : "macro_engine.db");
// 终端里直接运行时 stdin 是 TTY，不挂 stdio MCP；被 MCP 客户端拉起时 stdin 是管道
const USE_STDIO = !process.stdin.isTTY && !process.argv.includes("--no-stdio");

const log = (...a) => console.error("[Nutrition Tracker MCP]", ...a); // stdout 留给 MCP 协议
const engine = createEngine(DB_PATH, { demo: DEMO });
const usda = createUSDAClient();
const csrfToken = randomBytes(32).toString("hex");
const apiToken = process.env.NUTRITION_API_TOKEN;
const webhookToken = process.env.HEALTH_WEBHOOK_TOKEN;
const matches = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
// Browser clients must first read a same-origin session token; no wildcard CORS.
// Programmatic HTTP clients may use NUTRITION_API_TOKEN. MCP over stdio is separate.
function sameOrigin(req) {
  const origin = req.get("Origin");
  if (!origin) return true; // non-browser clients may omit Origin but still need bearer auth
  try { return new URL(origin).host === req.get("host") && ["http:","https:"].includes(new URL(origin).protocol); }
  catch { return false; }
}
function authorizeDispatch(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ok:false,error:"Cross-origin write denied"});
  const token = req.get("X-Nutrition-CSRF");
  const bearer = req.get("Authorization")?.replace(/^Bearer /i, "");
  if (matches(token, csrfToken) || (apiToken && matches(bearer, apiToken))) return next();
  return res.status(401).json({ok:false,error:"Write authentication required"});
}
function authorizeWebhook(req, res, next) {
  if (!webhookToken) return res.status(503).json({ok:false,error:"Webhook disabled; configure HEALTH_WEBHOOK_TOKEN"});
  const bearer = req.get("Authorization")?.replace(/^Bearer /i, "");
  if (!matches(bearer, webhookToken)) return res.status(401).json({ok:false,error:"Webhook authentication required"});
  next();
}

// ==================== HTTP + SSE ====================
const app = express();
app.disable("x-powered-by");
app.use(express.json({limit:"128kb"}));
app.use((req,res,next) => { res.setHeader("Cache-Control", "no-store"); next(); });

const sseClients = new Set();
function broadcast() {
  if (!sseClients.size) return;
  const data = `data: ${JSON.stringify(engine.buildSnapshot())}\n\n`;
  for (const res of sseClients) res.write(data);
}

function run(tool, args, source) {
  const result = engine.execute(tool, args, source);
  if (tool !== "get_snapshot") broadcast();
  return result;
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "viewport.html")));
app.get("/api/session", (req,res) => {
  if (!sameOrigin(req)) return res.status(403).json({ok:false});
  res.json({csrfToken});
});

app.get("/api/snapshot", (req, res) => res.json(engine.buildSnapshot()));

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write(`data: ${JSON.stringify(engine.buildSnapshot())}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.post("/api/mcp-dispatch", authorizeDispatch, (req, res) => {
  try {
    res.json(run(req.body?.tool, req.body?.args, "VIEWPORT"));
  } catch (e) {
    res.status(e instanceof ToolError ? 400 : 500).json({ ok: false, error: e.message });
  }
});

// 兼容 iOS 快捷指令 / Health Auto Export / Health Connect：字段都可选
app.post("/api/health-webhook", authorizeWebhook, (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  try {
    const result = run("log_morning_checkin", {
      scaleWeightKg: num(b.weightKg ?? b.scaleWeightKg),
      measuredAt: b.measuredAt,
      sourceEventId: b.sourceEventId,
      hrvMetric: b.hrvMetric,
      hrvMs: num(b.hrvMs),
      rhrBpm: num(b.rhrBpm),
      sleepHours: num(b.sleepHours),
      deepSleepPct: num(b.deepSleepPct),
      steps: num(b.steps),
      activeKcal: num(b.activeKcal)
    }, b.source ? `HEALTH_WEBHOOK:${b.source}` : "HEALTH_WEBHOOK");
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(e instanceof ToolError ? 400 : 500).json({ ok: false, error: e.message });
  }
});

const httpServer = app.listen(PORT, HOST, () => log(`观察窗 http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  DB=${path.basename(DB_PATH)}${DEMO ? " (demo)" : ""}`));
httpServer.on("error", (e) => {
  if (e.code === "EADDRINUSE") log(`端口 ${PORT} 已被占用（大概率是另一个 Nutrition Tracker MCP 实例），本进程只提供 MCP 工具`);
  else log("HTTP 启动失败:", e.message);
});

// 别的进程（另一个 MCP 客户端拉起的实例）写库后，这里也推送给观察窗
let lastVersion = engine.dataVersion();
setInterval(() => {
  const v = engine.dataVersion();
  if (v !== lastVersion) { lastVersion = v; broadcast(); }
}, 1000).unref();

// 跨过零点时让观察窗切到新的一天
let lastDate = engine.buildSnapshot().date;
setInterval(() => {
  const d = engine.buildSnapshot().date;
  if (d !== lastDate) { lastDate = d; broadcast(); }
}, 60_000).unref();

// ==================== MCP ====================
if (USE_STDIO) {
  const mcp = new McpServer({ name: "nutrition-tracker-mcp", version: "5.2.0-alpha.3" });

  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    mcp.registerTool(name, { description: def.description, inputSchema: def.shape }, async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(run(name, args, "MCP_AGENT"), null, 1) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    });
  }

  mcp.registerTool('get_agent_workflow', {
    description:'Read the agent-first routing contract for text meals, photos, corrections and safe external food lookup.',
    inputSchema:{}
  },async()=>({content:[{type:'text',text:JSON.stringify({ok:true,version:AGENT_WORKFLOW_VERSION,instructions:AGENT_WORKFLOW})}]}));

  mcp.registerTool('search_usda_foods', {
    description:'Optional read-only USDA FoodData Central search, requires FDC_API_KEY. Results are candidates, NOT local food IDs.',
    inputSchema:{query:z.string().trim().min(1).max(120),limit:z.number().int().min(1).max(20).default(10)}
  },async({query,limit})=>{
    try {return {content:[{type:'text',text:JSON.stringify(await usda.search(query,limit))}]};}
    catch(e){return {isError:true,content:[{type:'text',text:String(e.message)}]};}
  });

  mcp.registerTool('get_usda_food_details', {
    description:'Fetch FDC source details for a selected identifier. Rejects incomplete or unsupported nutrient panels; does not modify the ledger.',
    inputSchema:{fdcId:z.number().int().positive()}
  },async({fdcId})=>{
    try {return {content:[{type:'text',text:JSON.stringify(await usda.details(fdcId))}]};}
    catch(e){return {isError:true,content:[{type:'text',text:String(e.message)}]};}
  });

  mcp.registerPrompt('nutrition_agent_workflow', {
    title:'Agent-first nutrition logging workflow',
    description:'Route text meals, photos, corrections and external food search into validated MCP operations.'
  },async()=>({description:AGENT_WORKFLOW_VERSION,
    messages:[{role:'user',content:{type:'text',text:AGENT_WORKFLOW}}]}));

  // MCP prompt: external vision Agent sees the user's image; this server supplies
  // the compilation protocol and validates the resulting JSON via stage_photo_estimate.
  mcp.registerPrompt('estimate_meal_photo', {
    title:'Compile a meal photo into a nutrition estimate',
    description:'Structured item identification + edible mass ranges with visible evidence, uncertainty, and explicit unknowns (no automatic ledger writes).'
  }, async () => ({description:'Apply this prompt to the image provided by the user; return JSON for stage_photo_estimate.',
    messages:[{role:'user',content:{type:'text',text:PHOTO_ESTIMATION_PROMPT}}]}));

  mcp.registerResource(
    "snapshot",
    "telemetry://snapshot",
    { description: "今日档位、宏量配额与已摄入、生物遥测、7 日预测、补剂、TDEE 校准诊断的全量快照", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(engine.buildSnapshot(), null, 1) }] })
  );

  await mcp.connect(new StdioServerTransport());
  // MCP 客户端退出后不要留下占着端口的孤儿进程
  process.stdin.on("close", () => process.exit(0));
  log("stdio MCP 已连接");
}

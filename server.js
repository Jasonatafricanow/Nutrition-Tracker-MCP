// Nutrition Tracker MCP v5：同一进程里同时提供
//   - stdio MCP 工具（给 Claude Desktop / Claude Code 等 Agent 调用）
//   - HTTP 观察窗 + SSE 实时推送 + 手机健康 Webhook
// 多个进程共用同一个 SQLite 文件时，靠 PRAGMA data_version 轮询感知别的进程的写入。
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEngine, TOOL_DEFS, ToolError } from "./engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.argv.includes("--demo");
const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, DEMO ? "macro_demo.db" : "macro_engine.db");
// 终端里直接运行时 stdin 是 TTY，不挂 stdio MCP；被 MCP 客户端拉起时 stdin 是管道
const USE_STDIO = !process.stdin.isTTY && !process.argv.includes("--no-stdio");

const log = (...a) => console.error("[Nutrition Tracker MCP]", ...a); // stdout 留给 MCP 协议
const engine = createEngine(DB_PATH, { demo: DEMO });

// ==================== HTTP + SSE ====================
const app = express();
app.use(cors());
app.use(express.json());

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

app.post("/api/mcp-dispatch", (req, res) => {
  try {
    res.json(run(req.body?.tool, req.body?.args, "VIEWPORT"));
  } catch (e) {
    res.status(e instanceof ToolError ? 400 : 500).json({ ok: false, error: e.message });
  }
});

// 兼容 iOS 快捷指令 / Health Auto Export / Health Connect：字段都可选
app.post("/api/health-webhook", (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  try {
    const result = run("log_morning_checkin", {
      scaleWeightKg: num(b.weightKg ?? b.scaleWeightKg),
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
  const d = new Date().toLocaleDateString("sv-SE");
  if (d !== lastDate) { lastDate = d; broadcast(); }
}, 60_000).unref();

// ==================== MCP ====================
if (USE_STDIO) {
  const mcp = new McpServer({ name: "nutrition-tracker-mcp", version: "5.0.0" });

  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    mcp.registerTool(name, { description: def.description, inputSchema: def.shape }, async (args) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(run(name, args, "MCP_AGENT"), null, 1) }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: e.message }] };
      }
    });
  }

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
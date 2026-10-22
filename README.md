# Nutrition Tracker MCP

[English](README.md) | [简体中文](README.zh-CN.md)

Record meals and everyday health through an agent, correct them later, and inspect the same SQLite ledger in a local dashboard. Intended for a trusted household NAS.

![Dashboard with built-in demo data](assets/dashboard-preview.jpg)

## Product choices

- Text meals can be saved as attributed estimates. Photos require one combined food/portion confirmation before committing; an external vision agent interprets them.
- Corrections retain revision history. Missing days remain unknown rather than becoming zero intake.
- Two default MCP tools, `nutrition_query` and `nutrition_execute`, share a deterministic engine with the dashboard and device webhook.
- Household members share a trust boundary. Member IDs attribute records; they do not provide confidentiality from other household members.

## Try the demo

Node.js 22.13+ (built-in SQLite):

```bash
npm ci
npm run demo
```

Open `http://127.0.0.1:3456`. Demo mode uses `macro_demo.db`. Stop it and use `npm start` for the separate regular ledger. Run `npm test` for automated checks.

## Connect an agent

```json
{"mcpServers":{"nutrition-tracker-mcp":{"command":"node","args":["/absolute/path/to/Nutrition-Tracker-MCP/server.js"]}}}
```

[Agent runtime](docs/AGENT_RUNTIME.md) · [household configuration (Chinese)](docs/HOUSEHOLD_LIGHTWEIGHT_ZH.md) · [remote deployment (Chinese)](docs/REMOTE_MCP_DEPLOYMENT_ZH.md)

Remote MCP is opt-in and requires authentication, TLS for off-machine access, and Host/Origin allowlists. The dashboard stays private. Legacy tools require `MCP_TOOL_SURFACE=full`.

## Evidence and design records

The image uses demo data. Real NAS/agent deployment, meal turn counts, tool-call savings and photo-estimation error rates still require field evaluation. The estimates and trends support self-observation, not clinical decisions.

[Product strategy (Chinese)](docs/PRODUCT_STRATEGY_AGENT_FIRST_ZH.md) · [household tradeoffs (Chinese)](docs/PROJECT_RECORD_ZH.md) · [historical v5.1/v5.2/alpha notes](docs/history/README-before-portfolio-refresh.md)

## Rights

No project-wide reuse license has been selected. All rights remain with their respective holders; public source visibility does not grant an open-source license. See [NOTICE.md](NOTICE.md).

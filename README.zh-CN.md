# Nutrition Tracker MCP

[English](README.md) | [简体中文](README.zh-CN.md)

通过 Agent 记录饮食与日常健康，之后可以修正，并在本地仪表盘查看同一份 SQLite 账本。适用于互相信任的家庭 NAS。

![使用内置演示数据的仪表盘](assets/dashboard-preview.jpg)

## 产品取舍

- 文字饮食可作为带来源的估计记录。照片由外部视觉 Agent 解释，食物及份量需一次合并确认后才写入。
- 修正保留版本历史，缺失日期仍是未知，不当作零摄入。
- 默认两个 MCP 工具 `nutrition_query` 和 `nutrition_execute`，与仪表盘、设备 webhook 共用确定性引擎。
- 家庭是共同信任边界。成员 ID 用于标记记录归属，不提供家庭成员之间的保密隔离。

## 体验演示

需要 Node.js 22.13+，使用内置 SQLite：

```bash
npm ci
npm run demo
```

打开 `http://127.0.0.1:3456`，演示使用 `macro_demo.db`。停止演示后执行 `npm start` 使用独立的日常账本。执行 `npm test` 运行自动化检查。

## 接入 Agent

```json
{"mcpServers":{"nutrition-tracker-mcp":{"command":"node","args":["/absolute/path/to/Nutrition-Tracker-MCP/server.js"]}}}
```

[Agent 运行说明](docs/AGENT_RUNTIME.md) · [家庭配置](docs/HOUSEHOLD_LIGHTWEIGHT_ZH.md) · [远程部署](docs/REMOTE_MCP_DEPLOYMENT_ZH.md)

远程 MCP 需要主动启用，并配置鉴权、跨机器访问 TLS、Host/Origin 白名单；仪表盘保持私有。旧工具集合仅通过 `MCP_TOOL_SURFACE=full` 启用。

## 证据与设计记录

图片为演示数据。真实 NAS／Agent 部署、每餐交互轮次、工具调用节省和照片估重误差仍需现场评测。估计和趋势用于自我观察，不作为临床判断。

[产品策略](docs/PRODUCT_STRATEGY_AGENT_FIRST_ZH.md) · [家庭权限取舍](docs/PROJECT_RECORD_ZH.md) · [历史 v5.1/v5.2/alpha 说明](docs/history/README-before-portfolio-refresh.md)

## 权利

尚未选择项目整体的复用许可证，权利由各自权利人保留；公开可见不等于授予开源许可。见 [NOTICE.md](NOTICE.md)。

# Nutrition Tracker MCP — 安装、部署与 Agent 连接指南

> 当前说明适用于已经合并 Agent-first、照片编译和远程 MCP 能力的 GitHub **`main` 分支**。本项目是 **Agent-first MCP 工具服务**：聊天中的 Agent 执行识别、查询、确认和工具调用；`engine.js` 负责确定性计算与 SQLite 持久化；Dashboard 只用于监控与回顾。

## 1. 前置条件与下载

- **Node.js >= 22.13**（项目使用内置 `node:sqlite`）、npm、Git。
- 主机必须能运行本地进程；当前 **MCP 传输为 stdio**，不是 HTTP MCP。
- MCP 模块自身不需要 AI API Key；视觉识别由支持图片的外部 Agent/模型完成，该宿主可能需要自己的账号或 API。USDA 查询是可选联网功能。

PowerShell / macOS / Linux 终端：

```bash
git clone https://github.com/Jasonatafricanow/Nutrition-Tracker-MCP.git
cd Nutrition-Tracker-MCP
node --version
npm ci
npm test
```

**注意：** Agent-first 功能已合并到 `main`，无需再切换实验分支。远程 Streamable HTTP MCP 部署见 [远程 MCP / NAS 指南](REMOTE_MCP_DEPLOYMENT_ZH.md)。

## 2. 先在本机检查 Dashboard（可选）

```bash
npm run demo
```

浏览器访问 **http://127.0.0.1:3456**，看到的是单独的样本数据演示库 `macro_demo.db`。完成检查后按 **Ctrl+C** 停止。

真实数据运行：

```bash
npm start
```

浏览器仍访问同一个地址，但这次默认持久化到项目目录下的 **`macro_engine.db`**。用户可通过 `DB_PATH` 改为已有目录内的绝对路径。数据库包含个人饮食和健康记录，注意备份并避免上传到公开仓库。

**对纯 Agent 使用，以上两个运行命令都不是必需的。** MCP 客户端会自己启动 `node server.js`。不要额外再启动一个抢占相同端口的实例。

## 3. 推荐：本地 stdio MCP 连接

把下列示例写入宿主指定的 MCP 配置位置，**将示例路径替换成实际绝对路径**。

### Windows 通用 JSON（Claude Desktop 等 `mcpServers` 宿主）

```json
{
  "mcpServers": {
    "nutrition-tracker-mcp": {
      "command": "node",
      "args": ["C:/projects/Nutrition-Tracker-MCP/server.js"],
      "env": {
        "NUTRITION_TIME_ZONE": "Asia/Shanghai"
      }
    }
  }
}
```

- `command` 必须能在 **Agent 宿主进程环境**中找到 Node.js。若提示 `spawn node ENOENT`，改为 `where node` 得到的 `node.exe` 绝对路径。
- Windows 路径在 JSON 中建议使用正斜杠 `C:/...`，不要写未转义的单个反斜杠。
- `NUTRITION_TIME_ZONE` 应改为自己的固定 IANA 时区，如 `Africa/Maputo`、`Europe/London` 或 `Asia/Shanghai`；创建历史日志后不要随意改变。
- 未设置 `DB_PATH` 时使用源码所在目录的 `macro_engine.db`。多个客户端应有意指向 **同一份数据库**，而不是复制多份造成记录分叉。

### Linux / macOS JSON

```json
{
  "mcpServers": {
    "nutrition-tracker-mcp": {
      "command": "node",
      "args": ["/home/USER/Nutrition-Tracker-MCP/server.js"],
      "env": {
        "NUTRITION_TIME_ZONE": "Africa/Maputo"
      }
    }
  }
}
```

替换 `USER`，确保 `node` 对图形桌面应用可用。如果 Node 是通过用户级版本管理器安装，可能必须填写可执行文件绝对路径。

### Claude Desktop

使用本地 MCP 自定义配置的 Windows 常见位置：

```text
%APPDATA%\Claude\claude_desktop_config.json
```

macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`。

打开设置/开发者相关的本地 MCP 配置入口（不同版本界面可能不同），添加上方 `mcpServers` 配置，然后 **完全退出并重新打开** Claude Desktop。检查 Connectors 或开发者设置中服务器是否已连接。

这份仓库当前 **不是 `.mcpb` 一键安装扩展**，请使用自定义本地 MCP 配置。

### Cursor

用户级配置文件：`~/.cursor/mcp.json`；项目级：项目根目录 `.cursor/mcp.json`。建议使用用户级以便不同对话复用。

```json
{
  "mcpServers": {
    "nutrition-tracker-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/projects/Nutrition-Tracker-MCP/server.js"],
      "env": {
        "NUTRITION_TIME_ZONE": "Asia/Shanghai"
      }
    }
  }
}
```

保存、重启或刷新 Cursor MCP 配置，在 MCP 工具列表确认 `get_agent_context`、`search_foods` 等工具已加载。Cursor CLI 可使用 `agent mcp list` / `agent mcp list-tools nutrition-tracker-mcp` 查看状态。

### Claude Code CLI

在 Windows PowerShell 或其他 shell 中运行（替换路径）：

```bash
claude mcp add --transport stdio --scope user nutrition-tracker-mcp -- node C:/projects/Nutrition-Tracker-MCP/server.js
claude mcp list
```

若需设置时区，可改用：

```bash
claude mcp add --transport stdio --scope user --env NUTRITION_TIME_ZONE=Asia/Shanghai nutrition-tracker-mcp -- node C:/projects/Nutrition-Tracker-MCP/server.js
```

已添加同名项时先检查 `claude mcp get nutrition-tracker-mcp`，避免重复注册。进入 Claude Code 后使用 `/mcp` 检查连接。

### Codex CLI / IDE 扩展

编辑 `~/.codex/config.toml`（Windows 通常是 `%USERPROFILE%\.codex\config.toml`）：

```toml
[mcp_servers.nutrition-tracker-mcp]
command = "node"
args = ["C:/projects/Nutrition-Tracker-MCP/server.js"]
env = { NUTRITION_TIME_ZONE = "Asia/Shanghai" }
```

执行 `codex mcp list` 查看已配置服务器。IDE 扩展和 CLI 通常共享该配置。

### 其他 MCP Agent / 本地 Harness

只要宿主支持本地 **stdio MCP**，一般需要四个参数：

| 参数 | 值 |
| --- | --- |
| Server name | `nutrition-tracker-mcp` |
| Transport | `stdio` |
| Command | Node.js 可执行文件路径或 `node` |
| Arguments | `server.js` 的绝对路径 |

如果宿主只支持云端 HTTP MCP URL，当前版本**不能**直接填 `http://127.0.0.1:3456`；那个端口提供的是 Dashboard、应用 JSON API 与应用 SSE，**不是 MCP HTTP 传输协议**。如要部署到 NAS / 服务器并让另一台机器上的 Agent 远程连接，需要额外开发受认证的 Streamable HTTP MCP 层或专门的安全桥接方案，不应直接公网暴露 Dashboard API。

## 4. 检查 Agent 是否真正可以使用工具

连接后先让 Agent：

> 读取 Nutrition Tracker 的 Agent 工作流和今天的营养上下文。不要修改任何数据，告诉我今天的目标和已记录内容。

Agent 应调用 `get_agent_workflow`（或加载 MCP Prompt `nutrition_agent_workflow`），随后调用 `get_agent_context`。确认工具实际返回数据，才算完成联通。

本模块还暴露 `estimate_meal_photo` MCP Prompt。**Prompt 注册不代表宿主会自动执行**。如果宿主不能自动调用 MCP Prompt，请给宿主规则加入：

> When a user asks to record or correct food, first follow the Nutrition Tracker MCP `nutrition_agent_workflow` prompt (fallback: call `get_agent_workflow`). For photo meals, use `estimate_meal_photo` (fallback: `get_photo_estimation_protocol`), then stage estimates and obtain explicit user confirmation before calling `confirm_photo_meal`. Never invent food weights, raw/cooked states, or nutrition values.

## 5. 日常使用实例

| 用户对 Agent 说 | Agent 预期工具动作 |
| --- | --- |
| “中午吃了熟米饭 150g 和鸡胸肉 200g，记一下。” | `search_foods` → 核实重量口径 → `log_meal_items` → `get_meal_history` |
| “把刚才的午餐存成我的工作餐。” | `save_meal_template` |
| “和上次工作餐一样。” | `list_meal_templates` → 核实实际份量 → `log_meal_template` |
| “刚才米饭我只吃了一半。” | `get_meal_history` → `update_meal_item`（版本检查） → 核对 |
| “这是今天午饭，帮我记。”并附照片 | 视觉 Agent → `estimate_meal_photo` → `search_foods` → `stage_photo_estimate` → 用户确认 → `confirm_photo_meal` |
| “看看今天还剩多少热量。” | `get_agent_context` |
| “把这个月的记录导出来。” | `export_nutrition_data`（单次最长 90 天） |

**照片记录必须分两步。** Agent 给出识别候选、份量区间以及油/酱汁等未知项；用户明确核对后才可以入账。未确定时，Agent 可以保存未确认草稿或询问，不应伪造准确克数。

## 6. 可选：USDA 食材数据库与健康 Webhook

默认食材库可离线使用。需要 USDA FoodData Central 检索时，在 **MCP 宿主进程环境**添加 `FDC_API_KEY`。不要把密钥提交 GitHub，也不要要求 Agent 在对话中重复展示。工具 `search_usda_foods` / `get_usda_food_details` 只读，不会自动把外部候选写入本地食材库。

`HEALTH_WEBHOOK_TOKEN` 仅用于独立的手机健康数据 HTTP Webhook；**本地 stdio MCP 连接本身不需要这个令牌**。不使用手机同步时可以不配置。

## 7. 故障排查

| 症状 | 优先检查 |
| --- | --- |
| Agent 看不到工具 | 是否真的切到实验分支；MCP 配置文件位置与 JSON/TOML 格式；客户端是否重启；`node` 与 `server.js` 绝对路径 |
| `spawn node ENOENT` | 在 Agent 宿主环境中使用 Node.js 可执行文件的绝对路径 |
| 连接后工具能列出却不调用 | 宿主工具权限、MCP Prompt 自动加载机制；明确请求 `get_agent_workflow` |
| 图片无法识别 | Agent 宿主必须支持视觉并能够把用户照片放入模型上下文；MCP 自身不读取图片像素 |
| 食材搜索没有结果 | 先用本地 `search_foods`；USDA 工具需要 `FDC_API_KEY` 和网络访问 |
| 误以为没有保存 | 检查 `get_meal_history`、日期和 `NUTRITION_TIME_ZONE`；照片草稿并不等于已入账 |
| MCP 连接占用端口 | 多客户端可能各启动一个进程；HTTP 端口只供首个实例监听，SQLite 同库同步独立进行 |
| 裸命令启动后没有 MCP 会话 | MCP stdio 需要客户端控制 stdin/stdout；手动 `npm start` 只是启动本地 HTTP 观察窗 |

查看官方宿主配置帮助： [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Cursor MCP](https://prod.cursor.com/docs/mcp) · [Claude Desktop local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) · [Codex MCP](https://developers.openai.com/codex/mcp)。

## 8. 数据和安全提醒

- 数据库默认 `macro_engine.db`，含个人饮食、体重等健康记录；请备份，勿提交公开代码仓库。
- 目前是个人本地使用的实验版，不提供独立多用户账号权限；不要设置 `HOST=0.0.0.0` 暴露到公网。
- `npm run demo` 使用单独演示数据；切勿把演示库当作正式账本。
- 同一条确认记账的 `requestId` 在重试时保持不变，不同餐食使用不同 ID。
- TDEE 校准默认预览、不自动应用；历史体重模型和照片重量估算尚未在真实人体/称重图片上验证。

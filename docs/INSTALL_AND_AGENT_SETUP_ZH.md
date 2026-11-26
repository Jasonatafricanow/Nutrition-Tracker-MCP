# Nutrition Tracker MCP — 安装、部署与 Agent 连接指南

> **当前标准：v5.5 everyday**。默认只暴露两个 MCP 工具
> `nutrition_query`（`summary/meals/foods`）和 `nutrition_execute`
> （`meal/correct/health/photo_stage/photo_confirm`）。
> 具体参数与业务约束只参考 [Agent 调用契约](AGENT_CONTRACT_ZH.md)。
> `MCP_TOOL_SURFACE=compact` 是 v5.4 两工具旧参数的迁移接口，
> `MCP_TOOL_SURFACE=full` 是早期低层工具兼容/专业维护模式。
> 下文配置均默认 `everyday`，无需额外设置环境变量。


## 1. 前置条件与下载

- **Node.js >= 22.13**（项目使用内置 `node:sqlite`）、npm、Git。
- 主机必须能运行本地进程；支持本地 **stdio MCP**，也支持可选的经 Bearer Token 鉴权的 **Streamable HTTP MCP**（默认关闭；见远程部署指南）。
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

保存、重启或刷新 Cursor MCP 配置，在 MCP 工具列表确认 **仅有 `nutrition_query` 和 `nutrition_execute`**。Cursor CLI 可使用 `agent mcp list` 查看状态（具体命令依宿主版本而异）。

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

如果宿主只支持远程 HTTP MCP，可以按 [远程部署说明](REMOTE_MCP_DEPLOYMENT_ZH.md) 配置经 Bearer Token 鉴权的 **Streamable HTTP MCP**（`/mcp`，默认独立端口 3457，默认关闭）。`http://127.0.0.1:3456` 是 Dashboard，不是远程 MCP；不要把 Dashboard API 直接开放公网。

## 4. 验证默认协议已连接

确认 MCP 工具清单恰好出现 `nutrition_query` 与 `nutrition_execute`，不会默认出现 `get_agent_context`、`search_foods` 等底层工具。

让 Agent 读取（不写入）：

> 用 Nutrition Tracker 查询今天的营养与健康记录，不要修改任何数据。

应路由到：

~~~js
nutrition_query({view:"summary",period:"today"})
~~~

家庭模式请带上对应成员 `memberId`；需要全家庭概况时可以不带。支持 MCP Prompt 的宿主可按需加载 `nutrition_agent_workflow`；不支持 Prompt 的宿主直接按 [标准契约](AGENT_CONTRACT_ZH.md) 配置行为规范，**不需要**调用 `get_agent_workflow`（它是历史 full profile 工具）。

## 5. 日常任务示例

| 用户意图 | 当前 everyday 调用 |
| --- | --- |
| “今天还剩多少热量？” | `nutrition_query({view:"summary",period:"today",focus:"food"})` |
| “查询今天的餐食。” | `nutrition_query({view:"meals"})` |
| “午餐米饭和鸡胸肉 150g，记一下。” | 必要时 `view:"foods"` 核验真实食材 ID，然后 `nutrition_execute({operation:"meal",args:{mealSlot:"午餐",source:"text",requestId,...}})` |
| “刚才米饭其实只吃了 100g。” | `nutrition_execute({operation:"correct",args:{foodName:"米饭",weightGrams:100,requestId}})`；不唯一则先查 `meals` |
| “昨晚只睡了六小时。” | `nutrition_execute({operation:"health",args:{sleepHours:6}})` |
| “这是午饭照片，帮我记。” | 视觉 Agent 按 `estimate_meal_photo` 解析，`photo_stage` 暂存并预览，用户一次确认后 `photo_confirm` |
| “看看近 30 天趋势。” | `nutrition_query({view:"summary",period:"30d"})` |

专业模板、USDA、补剂、训练计划、导出等不属于默认日常入口。如果确有专业需求，由部署者**显式**选择 `MCP_TOOL_SURFACE=compact` 或 `full`；不要让日常 Agent 继续猜测旧底层工具名。

照片不可直接走文字入账；`photo_stage` 不写账本，用户确认后才能 `photo_confirm`。

## 6. 可选：USDA 食材数据库与健康 Webhook

默认 everyday 仅查询本地食材库，离线可用。USDA FoodData Central 搜索属于**可选专业模式**：在 MCP 宿主进程配置 `FDC_API_KEY` 并显式启用 `full`，可使用旧只读工具 `search_usda_foods` / `get_usda_food_details`；这些外部候选不会自动变为本地食材 ID。密钥不要提交 GitHub 或放入对话。

`HEALTH_WEBHOOK_TOKEN` 仅用于独立的手机健康数据 HTTP Webhook；**本地 stdio MCP 连接本身不需要这个令牌**。不使用手机同步时可以不配置。

## 7. 故障排查

| 症状 | 优先检查 |
| --- | --- |
| 看不到工具 | MCP 配置文件、客户端重启、`node` 和 `server.js` 绝对路径 |
| 出现 `get_agent_context` 等几十个工具 | 意外启用了 `MCP_TOOL_SURFACE=full`；日常应为 `everyday` |
| 只有两个工具却不支持 `summary` | 正运行 v5.4 `compact` 接口或旧服务进程，先检查环境变量/版本 |
| `spawn node ENOENT` | 使用 Node 可执行文件绝对路径 |
| 工具存在但不被调用 | 宿主 MCP 工具权限，按需加载 Prompt 或提供 [当前契约](AGENT_CONTRACT_ZH.md) |
| 无法识别照片 | 宿主需要具备视觉能力；MCP 不会自行查看图片 |
| 餐食未入账 | 通过 `nutrition_query({view:"meals"})` 查账；照片暂存不等于确认 |
| 远程连接失败 | 独立 `/mcp` 监听、Token、Host/Origin、TLS，见远程部署指南 |

查看官方宿主配置帮助： [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Cursor MCP](https://prod.cursor.com/docs/mcp) · [Claude Desktop local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) · [Codex MCP](https://developers.openai.com/codex/mcp)。

## 8. 数据和安全提醒

- 数据库默认 `macro_engine.db`，含个人饮食、体重等健康记录；请备份，勿提交公开代码仓库。
- 家庭 NAS 采用共享实例的信任边界，不提供成员独立授权；不要将 Dashboard 端口暴露公网，远程 MCP 需使用独立受认证入口。
- `npm run demo` 使用单独演示数据；切勿把演示库当作正式账本。
- 同一条确认记账的 `requestId` 在重试时保持不变，不同餐食使用不同 ID。
- TDEE 校准默认预览、不自动应用；历史体重模型和照片重量估算尚未在真实人体/称重图片上验证。

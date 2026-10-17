# Nutrition Tracker：远程 Streamable HTTP MCP 部署说明

**正式主线：`main`。** 当前主线已经合并远程 MCP、照片编译、饮食账本、USDA 搜索和 Agent 工作流；stdio 依然可用。

## 设计边界

- `http(s)://<host>/mcp` 使用 **Streamable HTTP MCP**，与 Dashboard 的应用 HTTP API 完全隔离，使用独立监听地址和端口。
- **默认关闭**。只有 `MCP_HTTP_ENABLED=1` 并设置至少 32 字节随机 `MCP_HTTP_TOKEN` 才启用。
- 所有 `/mcp` 请求先经过 **Bearer Token**、Host 白名单和 Origin 白名单。默认只允许 Host `localhost`、`127.0.0.1`、`[::1]`。浏览器 Origin 若存在必须明确配置；标准桌面 MCP HTTP 客户端通常不发送 Origin。没有开放跨域 CORS。
- 使用 **stateless** MCP：每次 POST 新建 `McpServer`，不发放 `Mcp-Session-Id`。多个 Agent 客户端共享的是 **同一 SQLite 单用户账本**，不是 MCP 会话。`GET`/`DELETE /mcp` 返回 405。使用 SDK v1 的 Streamable HTTP 协议，不提供 OAuth 授权服务。
- 远程 HTTP 没有主动连接 Agent 的能力；Agent 主动发起 HTTP 请求。拍照识别仍由具备视觉能力的 Agent 完成。
- **生产/跨网络部署必须使用 TLS（HTTPS）**，在前面放 Caddy、Nginx 或 Tailscale HTTPS 反代；不要把明文 HTTP 暴露公网。反代只转发 `/mcp`，不要转发 Dashboard `/api/*`。

## 1. 直接本地冒烟测试

```bash
git clone https://github.com/Jasonatafricanow/Nutrition-Tracker-MCP.git
cd Nutrition-Tracker-MCP
npm ci
npm test
```

生成强随机 Token，例如：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Linux/macOS（替换成刚生成的实际 Token）：

```bash
export MCP_HTTP_ENABLED=1
export MCP_HTTP_TOKEN='<random-64-hex-characters>'
export MCP_HTTP_HOST=127.0.0.1
export MCP_HTTP_PORT=3457
export NUTRITION_TIME_ZONE=Asia/Shanghai
node server.js --no-stdio
```

Windows PowerShell：

```powershell
$env:MCP_HTTP_ENABLED='1'
$env:MCP_HTTP_TOKEN='<random-64-hex-characters>'
$env:MCP_HTTP_HOST='127.0.0.1'
$env:MCP_HTTP_PORT='3457'
$env:NUTRITION_TIME_ZONE='Asia/Shanghai'
node server.js --no-stdio
```

在另一终端检查：

```bash
curl -i http://127.0.0.1:3457/mcp
# 没有 Token -> HTTP 401，这是预期行为
```

正常的 MCP 初始化**不是**浏览器 GET，需用支持 Streamable HTTP 的 MCP Agent 客户端访问 URL `http://127.0.0.1:3457/mcp` 并配置 `Authorization: Bearer <token>`。不要将 `/api/snapshot` 或 Dashboard 端口误当成 MCP URL。

## 2. Docker / NAS

仓库提供 `Dockerfile` 和 `compose.remote.yml`，将数据库保存在 Docker 卷 `nutrition-data`，不把个人记录写入镜像。默认只有 **宿主机 loopback 端口 3457** 能访问 MCP，Dashboard 端口不发布。

```bash
export MCP_HTTP_TOKEN="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
export NUTRITION_TIME_ZONE=Asia/Shanghai
# 若要通过反代域名 mcp.example.com 访问，需同时设置：
export MCP_ALLOWED_HOSTS=mcp.example.com
# 使用浏览器 Web Agent 时还需设置 Origin：
# export MCP_ALLOWED_ORIGINS=https://agent.example.com

docker compose -f compose.remote.yml up -d --build
```

如果在 NAS Web UI 中部署 Compose，将环境变量填写到 NAS 的安全配置中，并持久化数据库卷。不要把 Token 放入 git/公开 Docker Compose。

## 3. HTTPS 反向代理示例（Caddy）

在 **同一宿主机**运行的 Caddy 例子（确保 `MCP_ALLOWED_HOSTS=mcp.example.com`，DNS 和证书已配置）：

```caddyfile
mcp.example.com {
    @mcp path /mcp
    handle @mcp {
        reverse_proxy 127.0.0.1:3457
    }
    respond 404
}
```

这样 Agent 连接 `https://mcp.example.com/mcp`，Token 仍由 MCP 进程校验。不要把未经授权的 HTTP API 端口转发给公网。若 Nginx/Caddy 与应用不在同一网络命名空间，调整 Docker 网络和反代上游地址，而不是把所有端口公开。

在尾网内访问同样可以通过 Tailscale HTTPS Serve 提供加密端点；远端域名必须纳入 `MCP_ALLOWED_HOSTS`。**不提供 OAuth 自动发现**：如果某个 Agent 平台只支持 OAuth 连接器而不能设置 Bearer Header，需要额外兼容适配或访问代理，不可将 Token 拼到 URL 查询参数。

## 4. Agent 客户端连接

通用远程 MCP 配置示例（**宿主必须支持 Streamable HTTP 和静态自定义 Header**）：

```json
{
  "mcpServers": {
    "nutrition-tracker": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_RANDOM_TOKEN"
      }
    }
  }
}
```

实际 JSON 键名随 Agent 宿主而异，不要将上面的配置直接套到只支持 stdio 或 OAuth 的宿主。对于支持自定义 HTTP 标头的 Codex/CLI/其他 Agent，按对应官方 MCP 配置填 URL 与安全保存的 Token。Agent 成功连接后调用 `get_agent_workflow`、`get_agent_context`，再测试 `search_foods` 和照片编译流程。

## 5. 运维与风险

- **单用户可信设备模式**。一把静态 Token 就有整套 MCP 工具读写权限；不是多用户隔离，不可把同一 Token 分发给不可信用户。
- 重启时替换 Token 可以撤销所有旧客户端访问；Token 请放环境变量/密钥管理器，不打印、不要提交仓库。
- 不要使用非 TLS 的公网 URL。网络故障时 Agent 可以重试带原 `requestId` 的写入，避免重复饮食记录。
- `MCP_HTTP_HOST` 指定绑定地址，`MCP_ALLOWED_HOSTS` 是允许的 HTTP Host 值（**不带端口的主机名列表**）；它们不是一回事。
- `/mcp` 与 `http://127.0.0.1:3456` Dashboard 不在同一端口。Dashboard 默认只监听本地，不开放远端。
- 运行时 DB 默认项目目录下的 `macro_engine.db`，Docker 使用 `/data/nutrition.db`。迁移旧数据库时请先备份并设置 `DB_PATH`，不要误启动两个不同的账本。
- 仅声明本地/CI 的 MCP 传输与安全冒烟测试通过，不意味着公开网络生产部署做过独立渗透测试。

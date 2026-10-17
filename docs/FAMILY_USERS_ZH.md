# 家庭多用户远程 MCP：配置与授权

家庭成员各自持有随机令牌，经远程 `/mcp` 接入，拥有**独立 SQLite 数据库**。默认不能互相读取饮食、体重或健康记录。原单用户 Dashboard 和 stdio MCP 不作为家庭成员访问入口。

## 1. 在 NAS 上创建成员

在仓库根目录执行：

```bash
mkdir -p private-data
node scripts/family-users.mjs init "$(pwd)/private-data/family-users.json"
node scripts/family-users.mjs add "$(pwd)/private-data/family-users.json" member_a "成员A" Asia/Shanghai
node scripts/family-users.mjs add "$(pwd)/private-data/family-users.json" member_b "成员B" Asia/Shanghai
```

每次 `add` 会打印一次随机 Bearer Token，把它交给对应成员的 Agent，**不要贴进 GitHub**。注册表仅存令牌 SHA-256 摘要，仍须避免公开；特别留意 NAS 文件所有权和容器运行用户（默认 `node` UID 1000）是否有读写权限。

轮换或停用令牌：

```bash
node scripts/family-users.mjs rotate /absolute/path/family-users.json member_a
node scripts/family-users.mjs disable /absolute/path/family-users.json member_b
```

修改注册表后重启服务。禁用成员不直接删除对应的历史数据库。

## 2. Compose 部署

```bash
docker compose -f compose.family.yml up -d --build
```

在可信 Tailnet 或 HTTPS 反向代理里连接 `/mcp`。设置 `MCP_ALLOWED_HOSTS` 为访问域名（不带协议、端口）。公网部署需要完善网络安全防护；不要直接对外开放 Docker HTTP 端口。

家庭模式**不接受**旧的全局 `MCP_HTTP_TOKEN`；每个客户端必须带自己的：

```
Authorization: Bearer <member-token>
```

旧版单用户 `DB_PATH` 不自动转成家庭库；若需迁移，请备份后主动核对归属，再导入相应 `member-<id>.db`。同一进程的本地 Dashboard 只连接旧单用户数据库，不应当作家庭汇总页。

## 3. Agent 管理权限

`family_directory` 返回家庭成员和当前已授权的摘要范围。成员 B 要让 A 查看自己的有限体重摘要，B 通过**自己的身份**调用：

```json
{"granteeId":"member_a","scope":"overview","enabled":true}
```

对应工具为 `set_family_sharing`。B 可以随时以 `enabled:false` 撤销。A 调用 `get_family_overview({"memberId":"member_b"})` 获取授权范围内的摘要，不能直接读取 B 的完整账本。更详细的健康趋势需要单独的 `health_trends` 授权。

授权来自持有者的访问令牌，但它**不能证明 Agent 获得了当事人的独立同意**。必须由 Agent 在共享前确认用户意愿，尤其注意儿童及被照护人的隐私。不会因为家庭关系自动扩大读取权限。

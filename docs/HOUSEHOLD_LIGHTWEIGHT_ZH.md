# 家庭 NAS 轻量部署及 Agent 使用（v5.5 everyday）

这是一个**可信家庭内部**的 MCP 服务，不是多租户 SaaS。沿用原来的远程 MCP Token 作为 NAS 访问边界；配置中的 `memberId` 只是**记录属于谁**，不是登录账户。无成员密码、独立 Token、逐项共享申请。使用 Agent 进行日常操作，Dashboard 作为可选观察窗口，并支持点开对应成员今日膳食进行份量校准（沿用已有修订审计）。

## 权限粒度为什么主动降级

这里以**家庭 NAS 实例**而非家庭成员账号作为信任边界。远程入口仍需共享 MCP Token、受限网络和加密通道；但 `memberId` 只决定记录归属，不承担鉴权。我们明确了解成员独立令牌及共享审批的安全价值，只是在家庭日常 Agent 协作场景中，它们的管理和交互成本超过了收益。

代价是：获得共享凭证的 Agent 可以查看家庭实例中的参与者记录；NAS 私有部署也不保证外部云 Agent 不会处理 MCP 返回的数据。家庭成员需知悉并接受这种共享方式，不接受时可不加入或独立部署。

完整的决策背景、纠偏历程、已接受的风险及何时重新引入隔离：**[项目记录｜家庭组权限取舍](PROJECT_RECORD_ZH.md)**。

## 部署

1. 拉取当前 `main` 分支的代码。要求 Node.js >=22.13 或 Docker Compose。
2. 创建家庭名单：

   ```bash
   cp household.example.json household.json
   ```

   修改成员 `id`、`name`、`mode`（`general` 普通观察，`performance` 健身营养）与时区。固定 ID，避免既有数据库归属变化。不要把家庭名单提交到代码仓库。
3. 使用已有远程 MCP `.env` 中的 `MCP_HTTP_TOKEN`（至少 32 字节）。确保配置反向代理/Tailscale，只允许家庭网络访问。**不需要成员级凭证。**
4. 运行：

   ```bash
   docker compose -f compose.remote.yml -f compose.household.yml up -d --build
   ```

   容器监听 `/mcp`（默认端口 3457，经已有 HTTPS/Tailscale 访问）；家庭数据库存在 `/data/household/`，保留个人 SQLite 存储计算。可以单独运行 `npm start` 与 `HOUSEHOLD_CONFIG`/`HOUSEHOLD_DATA_DIR` 配置进行本地检查。

5. Agent 连接同一个 URL 和 NAS Bearer Token，默认仅使用 `nutrition_query` 与 `nutrition_execute`，遵守 [Agent 调用契约](AGENT_CONTRACT_ZH.md)。原 v5.4 的两工具操作集合使用 `MCP_TOOL_SURFACE=compact` 迁移兼容，原始底层工具使用 `MCP_TOOL_SURFACE=full`。新安装保持默认 `everyday` 即可。

## 家庭日常调用边界

Dashboard 保留专业营养与日常视图切换，但**界面展示模式不改变 MCP 的工具发现**。
日常 Agent 默认只读三类（`summary/meals/foods`）与写五类
（`meal/correct/health/photo_stage/photo_confirm`）；具体例子、精度、
纠错与照片审批约束统一见 [Agent 调用契约](AGENT_CONTRACT_ZH.md)。

- 文字记餐：`nutrition_execute({operation:"meal",memberId:"adult_a",args:{mealSlot:"午餐",source:"text",items:[...],requestId:"..."}})`。估算有来源标识，不能把图片当文字提交。
- 家庭饮食概况：`nutrition_query({view:"summary",period:"today",focus:"food"})`；专业训练成员的宏量目标不会强加给普通成员。
- 最近健康概况：`nutrition_query({view:"summary",period:"today",focus:"health"})`；不构成诊断，不将缺失读数当零。
- 个人健康记录：`nutrition_execute({operation:"health",memberId:"adult_a",args:{sleepHours:6.5,rhrBpm:60}})`。
- 修改记录：`nutrition_execute({operation:"correct",memberId:"adult_a",args:{foodName:"米饭",weightGrams:100,requestId:"..."}})`；不唯一则询问、绝不猜测。
- 照片：`estimate_meal_photo` Prompt → `photo_stage` 未确认草稿 → 用户整体确认 → `photo_confirm` 正式入账。

餐食模板、条码、USDA、补剂与专业训练计划属于显式启用的扩展/迁移接口，
不在家庭日常 Agent 的默认选项内。切换 `MCP_TOOL_SURFACE` 是**部署者**
决定的服务设置，不是 Agent 每次谈话自行选择的工具。

## 设备批量导入（沿用原有私有 Webhook）

保持原 `POST /api/health-webhook` 的 Bearer Token 验证和单条格式。家庭设备可发送：

```json
{"memberId":"adult_a","events":[
 {"sourceEventId":"watch:2026-10-17:sleep","measuredAt":"2026-10-17T23:00:00+08:00","sleepHours":6.5},
 {"sourceEventId":"watch:2026-10-17:rhr","measuredAt":"2026-10-17T23:00:00+08:00","rhrBpm":63}
]}
```

最多 30 条，同一请求只属于一个家庭成员。每条记录必须包含稳定 `sourceEventId` 和带时区的 `measuredAt`；重复导入不会重复记录。部分失败返回 HTTP 207 及逐项错误，手机自动化需要检查结果并重试失败项。此接口没有自动拉取手环云端数据的能力；手机端仍需要快捷指令/Health Auto Export 等主动发送。

手机健康数据同步与 Agent 工具是不同入口：此 Webhook 的鉴权、幂等及事件归属不因 MCP 默认操作收缩而改变。

## 同步时必须保留事件身份

健康设备批量导入中，`sourceEventId` 不是可复用的日序号，而是一条测量事件的稳定标识。同一事件网络重试保持原 ID 和原内容；设备发现数值有更正时应使用新的事件 ID，不能把相同 ID 配不同数值作为修改方式。服务端对新增事件持久化内容指纹，发现 ID 冲突会拒绝该条写入并在批量响应里返回错误，防止静默丢弃。

从旧版本数据库迁移来的既有事件没有内容指纹：同一 ID、同一测量时间的重试仍按重复处理并返回 `legacyUnverified:true`，无法追溯验证其历史内容；**不会假装已经检查过旧事件的内容**。不清除旧数据库，迁移只添加 nullable 列。

家庭最近睡眠/心率的展示与轻量关怀线索取最近实际有记录的一日，并附日期，避免昨天状态覆盖今天。

## 当前协议与兼容

单一有效规范：[Agent 调用契约](AGENT_CONTRACT_ZH.md)。
`MCP_TOOL_SURFACE=everyday`（默认）暴露 3 查 + 5 写；
`compact` 保留早期 12 查 + 18 写；`full` 为底层工具兼容。
家庭 NAS 数据、成员 ID、审计与设备同步不做自动迁移或清理。

历史 v5.4 的 `quick_meal`、`recent_correction`、`view:"household"`
不应再写入新 Agent 提示词；它们只能在兼容模式中使用。
默认写入成功时返回简短更新状态，不需机械追加一次全量读取。

## 回滚说明与数据

新实现从**旧版家庭 SaaS 式分支之前的 v5.3 基线**重新开发。删除的是多用户 Token/逐项授权主流程，**不是清理 NAS 的用户数据**。旧的 `family-users.json`、`member-*.db`、`family-consents.db` 等不会自动移植或删除。切换前务必备份数据，逐一确认要迁移到哪个 `memberId`。如果已有数据，需要人工核对历史归属，不能默认将所有旧数据合并。

主线个人用户可不配置 `HOUSEHOLD_CONFIG`，继续使用同一套 Nutrition Tracker。Tailscale 的可访问性与 Hermes Python 客户端 Streamable HTTP 传输支持仍需要在实际设备验证。

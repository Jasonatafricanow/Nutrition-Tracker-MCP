# 家庭 NAS 轻量部署及 Agent 使用（v5.4）

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

5. Agent 连接同一个 URL 和 NAS Bearer Token，使用两个默认工具：`nutrition_query` 与 `nutrition_execute`。**已有使用老工具名的 Agent** 可以暂时将 `MCP_TOOL_SURFACE=full` 开启兼容模式；完成 Agent 提示词迁移后改回默认 compact。

## 交互深度

默认保留可见的专业健康／营养能力，Dashboard 可切换「日常视图」，不删除任何记录，随时恢复专业视图。这是浏览器端展示偏好，不会自动修改成员模式、TDEE 或历史记录。

普通文字记餐可使用 `quick_meal` 直接记录估算值；**照片必须先向用户展示识别种类与大致份量并得到一次整体确认**，再以原有 `photo_stage` / `photo_confirm` 写入。不要为照片中每种食物分别追问。

## 追加的低摩擦能力

- `recent_correction`：用户只需说「刚才米饭是 220 克」，Agent 直接按食物名定位最近一次记录并审计修改。同一天同名出现多次时返回歧义，请用户补充餐次；不猜测修改目标。
- `family_recipes`：汇总各成员已保存的餐食模板，用于家庭共餐建议与不同份量，不新建库存和权限管理。
- `barcode`：8–14 位商品条码查询 Open Food Facts，返回带外部来源标记的包装营养值；不是本地已校验食物，不自动入账。
- `report`：7 或 30 天简短饮食/睡眠/心率/活动趋势报告，未记录的日期不能当作零摄入。

## 设备批量导入（沿用原有私有 Webhook）

保持原 `POST /api/health-webhook` 的 Bearer Token 验证和单条格式。家庭设备可发送：

```json
{"memberId":"adult_a","events":[
 {"sourceEventId":"watch:2026-10-17:sleep","measuredAt":"2026-10-17T23:00:00+08:00","sleepHours":6.5},
 {"sourceEventId":"watch:2026-10-17:rhr","measuredAt":"2026-10-17T23:00:00+08:00","rhrBpm":63}
]}
```

最多 30 条，同一请求只属于一个家庭成员。每条记录必须包含稳定 `sourceEventId` 和带时区的 `measuredAt`；重复导入不会重复记录。部分失败返回 HTTP 207 及逐项错误，手机自动化需要检查结果并重试失败项。此接口没有自动拉取手环云端数据的能力；手机端仍需要快捷指令/Health Auto Export 等主动发送。

默认两工具不变；`nutrition_execute.args` 对常用餐食、更正和打卡提供可发现的类型字段，复杂/低频操作继续由原引擎校验。

## 两个工具的日常用法

- 普通用户默认一句话记餐：`nutrition_execute({memberId:'adult_a',operation:'quick_meal',args:{mealSlot:'午餐',source:'text',items:[{name:'米饭',weightGrams:150,foodId:'f7'}],requestId:'unique-meal-event'}})`，注明估算、可改。不必逐项确认估重。照片不能走 `quick_meal` 直写；识别预览后一轮确认，底层复用原有草稿与确认操作。
- 家庭晚餐：`nutrition_query({view:'household',focus:'food'})` 一次读取成员健身营养目标及每日剩余额度，Agent 对同桌菜品建议个性化份量；普通模式成员不会被强加高低碳计划。
- 健康观察：`nutrition_query({view:'household',focus:'health'})` 一次读取最近已记录的睡眠、HRV、静息心率、活动、体重、血压、体温、血糖、少量值得注意的变化。不是临床诊断。不需要全量历史。
- 个人记录：`nutrition_execute({memberId:'adult_a',operation:'checkin',args:{sleepHours:6.5,rhrBpm:60}})`，返回简短最新状态，通常不需再次请求工具。
- 一餐多种食材：`nutrition_query({view:'foods',memberId:'adult_a',queries:['熟米饭','鸡胸肉']})`，一次返回食材 ID；然后 `nutrition_execute({memberId:'adult_a',operation:'meal',args:{mealSlot:'午餐',items:[{foodId:'f7',weightGrams:150}],requestId:'unique-meal-id'}})`。实际添加每个食材前核实其 ID、加工状态和份量。
- 补充健康观察：`nutrition_execute({memberId:'adult_b',operation:'health_observation',args:{kind:'blood_pressure',systolic:120,diastolic:80}})`；历史详情按需 `nutrition_query({view:'health_history',memberId:'adult_b'})`。
- 纠正份量：先 `nutrition_query({view:'meals',memberId:'adult_a'})` 获取 ID 和版本，后 `nutrition_execute({memberId:'adult_a',operation:'correction',args:{mealId:'...',expectedRevision:0,weightGrams:100,requestId:'unique-correction-id'}})`。
- 照片：在需要时读取 `estimate_meal_photo` MCP Prompt；视觉 Agent 生成编译产物，`nutrition_query({view:'foods',...})` 匹配库，`nutrition_execute(operation:'photo_stage',...)` 建立草稿。**用户确认后**才 `photo_confirm` 入账，避免照片直接凭空计算热量。
- 高级功能（补剂、训练计划、TDEE 等）：按需 `nutrition_query({view:'capabilities',domain:'planning'|'extras'|'history'})`，复用底层确定性引擎和对应 `nutrition_execute` 操作；默认不把几十个接口都暴露给 LLM。

## Token 与调用优化的边界

- 默认 MCP 工具只有 **2 个**。仓库自动测试会比较完整/紧凑的实际工具定义 JSON 大小；这只能证明工具目录体积降低，**不能代表真实模型 Token 消耗与工具选择准确率已经验证**。
- 家庭摘要不返回原始历史和症状全文；需要详细数据才单独查询。
- 食物匹配至少需要先核实食物 ID，无法保证任何场景都是单次调用；多项食材可合并成一次查询。
- 常见写入直接在返回结果附上最新紧凑状态，避免写入后马上再读全量状态。
- 原有营养引擎、照片编译、安全校验、幂等性和 TDEE 预览保护不变。

## 回滚说明与数据

新实现从**旧版家庭 SaaS 式分支之前的 v5.3 基线**重新开发。删除的是多用户 Token/逐项授权主流程，**不是清理 NAS 的用户数据**。旧的 `family-users.json`、`member-*.db`、`family-consents.db` 等不会自动移植或删除。切换前务必备份数据，逐一确认要迁移到哪个 `memberId`。如果已有数据，需要人工核对历史归属，不能默认将所有旧数据合并。

主线个人用户可不配置 `HOUSEHOLD_CONFIG`，继续使用同一套 Nutrition Tracker。Tailscale 的可访问性与 Hermes Python 客户端 Streamable HTTP 传输支持仍需要在实际设备验证。

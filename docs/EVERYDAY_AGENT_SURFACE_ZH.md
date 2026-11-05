# Nutrition Tracker — 日常 Agent 功能收缩（v5.5）

## 决策

这次不是「把几十个 MCP 工具包装成两个」：v5.4 已经只有两个默认工具，
但 `nutrition_query` 仍有 12 个 `view`，`nutrition_execute` 仍有 18 个 `operation`。

本轮从真实用户任务出发，缩短**普通生活记录模式**可以调用的业务意图。
保留原始引擎，因为数据库模型、审计、幂等、照片预览/确认和专业视图已经有既有消费者。

| 层级 | v5.4 默认 | v5.5 默认 everyday | 兼容方式 |
| --- | --- | --- | --- |
| MCP 工具个数 | 2 | 2 | `MCP_TOOL_SURFACE=compact` |
| 查询意图 | 12 | **3** | `MCP_TOOL_SURFACE=compact` |
| 写入意图 | 18 | **5** | `MCP_TOOL_SURFACE=compact` |
| 原引擎工具定义 | 28 | 28（未删） | `MCP_TOOL_SURFACE=full` |
| 数据库迁移 | 无 | **不需要** | 引擎/数据原封不动 |

默认使用 `MCP_TOOL_SURFACE=everyday`。迁移中已使用旧 `nutrition_query`/`nutrition_execute` 操作名的 Agent，可临时设置 `MCP_TOOL_SURFACE=compact`，之后更新其 Agent Prompt。
`full` 是原有低层工具，主要留给专业操作与回归，不要普通对话默认开启。

## 三种读取

1. `nutrition_query({view:"summary",period:"today",memberId?})`：今天的个人/家庭营养与健康概况。
   `focus:"food"|"health"|"daily"` 选择关注点，防止信息泛滥。
2. `nutrition_query({view:"summary",period:"7d"|"30d",memberId?})`：保留现有专业报告计算，
   **仅统计有数据的日期**，绝不将缺测当成零。家庭模式指定具体成员。
3. `nutrition_query({view:"meals",memberId?,date?})`：准确定位历史餐食，用于纠错。
4. `nutrition_query({view:"foods",memberId?,queries:["米饭","鸡胸"]})`：
   每次可批量查 1–6 个**本地食材**，不能虚构 `foodId`。

上面虽然有四种示例，但只对应三个 `view`：`summary` / `meals` / `foods`。

`barcode`、`family_recipes`、`templates`、`nutrition_detail`、
`health_history` 及 `capabilities` 均不进入 everyday 查询目录；
在 `compact` 专业兼容模式依然能调用。照片预览在写入的 `photo_stage` 结果中返回，不需要额外读工具。

## 五种写入

1. **`meal`**：统一文本估算和严格称量的用户意图。
   默认 `source:"text"` → 原有 `log_estimated_meal`，如用户明确提供称重与核验食材 ID，
   使用 `source:"measured"` → 原有 `log_meal_items`。原始 provenance、幂等和原子交易不变。
   禁止 `source:"photo"`。
2. **`correct`**：按 `foodName` 修正最近无歧义餐食；或按 `mealId+expectedRevision`
   修改指定历史记录。继续保留版本审计；不唯一时拒绝，不猜。
3. **`health`**：体重、睡眠等人工报数送原 `log_morning_checkin`；
   有 `kind` 的家庭血压/症状等交由已有 `health_observation`。
   设备自动同步仍用原 Webhook，不让 Agent 逐条转发。
4. **`photo_stage`**：视觉 Agent 完成来源标注的食品种类和份量估计，
   仅暂存草稿并返回简短预览，不入账。
5. **`photo_confirm`**：只有用户确认了预览，才能传入当前 `draftId`、
   `confirmationEvidence`、`requestId` 和全部决策原子入账。

以下不再占用普通 Agent 的操作枚举：
`template_save` / `template_log` / `supplement` / `plan` / `profile` /
`intake_complete` / `food_add` / `acknowledge` / `photo_discard` / `advanced`，
以及单独的 `meal`/`quick_meal`、`correction`/`recent_correction` 分歧。

这不是删除数据功能：Dashboard、旧模式和底层原引擎保持可用。
未来只有真实使用指标和明确产品需求支持时才删除引擎实现，避免破坏资料与升级链。

## 验收的边界与下一步

现有单元/协议测试验证默认枚举、禁止高级透传、家庭成员归属、估算
来源、严格食材 ID、幂等、版本修订、7/30 日有效观测统计、照片确认。
**不能**从测试结果推出真实 LLM 的选择成功率、调用 Token 或用户完成率。

应继续用同一批真人表述和同一模型做两组 Agent trace A/B：

- v5.4 `compact`（12 查询 / 18 写入）
- v5.5 `everyday`（3 查询 / 5 写入）

记录每任务用户轮次、工具总调用、参数错误、最终入账/修订正确率、
对照片预览的越权率、数据审计结果，以及每个任务的完整 Token 开销。

**产品边界：**普通家庭/个人长期低摩擦生活观察。专业训练、补剂、
外部食材入库、TDEE 校准是主动选用的专业功能，而不是默认 Agent 每次必须掌握的行为。

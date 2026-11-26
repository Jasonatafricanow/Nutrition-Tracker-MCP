# Nutrition Tracker · Agent 调用契约（v5.5）

本文件是**当前默认** Agent 操作规范；安装文档、家庭部署和远程部署均以此为准。仓库中旧版工具示例仅供迁移参考。普通用户**无需**学习专业训练、补剂、食材库管理、TDEE 校准、原始工具调用名。

## 权责与工具发现

- 宿主 LLM：理解用户饮食、识别食物照片、估算且标注不确定性、必要时追问、请求用户对照片预览作一次确认。
- Nutrition：确定性校验、SQLite 账本、食材 ID 查验、版本修订、幂等、来源记录、报告计算、照片草稿确认。
- 默认只发现两个工具：`nutrition_query` 和 `nutrition_execute`。不要寻找 `get_agent_context` / `log_meal_items` / `get_agent_workflow` 等历史工具。
- 日常会话中仅允许下述 **3 个 view + 5 个 operation**。可按需读取 MCP Prompt `nutrition_agent_workflow`；照片任务可额外读取 `estimate_meal_photo` Prompt。

## 查询：nutrition_query

| view | 什么时候用 | 关键字段 |
| --- | --- | --- |
| `summary` | 今日情况，7/30 天历史摘要 | `period:"today"|"7d"|"30d"`、`focus:"daily"|"food"|"health"`（仅当天）、`memberId?` |
| `meals` | 查某日餐食及 mealId/修订版本 | `memberId?`、`date?` |
| `foods` | 验证本地食材 ID，允许一次查最多六种 | `memberId?`、`queries:["熟米饭","鸡肉"]` |

示例（指定家庭成员时须有已知 `memberId`）：

~~~js
nutrition_query({view:"summary",memberId:"adult_a",period:"today",focus:"food"})
nutrition_query({view:"summary",memberId:"adult_a",period:"7d"})
nutrition_query({view:"meals",memberId:"adult_a",date:"2026-11-05"})
nutrition_query({view:"foods",memberId:"adult_a",queries:["熟米饭","鸡胸肉"]})
~~~

`summary` 的周期报告只统计有实际记录的日期，缺失不等于零。单人模式不要传 `memberId`；家庭模式中 7/30 天个人报告要传明确成员。`foods` 查询得到的是本地食材 ID；不得发明 ID，不得把 USDA / Open Food Facts 参考候选当成已核验的本地食材。

## 写入：nutrition_execute

| operation | 对应用户意图 | args 原则 |
| --- | --- | --- |
| `meal` | 记一餐 | 文字默认 `source:"text"`；用户明确称重且食材已核验才用 `source:"measured"` |
| `correct` | 修正此前的一餐 | 最近唯一匹配：`foodName/weightGrams/requestId`；指定旧记录：`mealId/expectedRevision/weightGrams/requestId` |
| `health` | 报体重、睡眠、心率等测量 | 按实际 `scaleWeightKg`、`sleepHours`、`rhrBpm` 等来源字段；家庭专项观测需要 `kind` |
| `photo_stage` | 照片识别后暂存草稿 | `mealSlot`、`estimate`、按真实查询所得 `matches?`；**不入账** |
| `photo_confirm` | 用户一次整体批准照片候选后入账 | `draftId`、`confirmed:true`、`confirmationEvidence`、`requestId`、`decisions` |

文字估算：

~~~js
nutrition_execute({
  operation:"meal",memberId:"adult_a",
  args:{mealSlot:"午餐",source:"text",requestId:"stable-unique-event-id",
    items:[{name:"熟米饭",foodId:"f7",weightGrams:150}]}
})
~~~

例子里的 `f7` 只是本地测试食材库中的示例；正式调用必须由 `foods` 查询验证，不能假设其在真实数据库中存在。对无法匹配的食物可以使用**明确标注的估算 P/C/F**，不可伪造测量数据。

精确称量（需要本地验证的 foodId）：

~~~js
nutrition_execute({
  operation:"meal",memberId:"adult_a",
  args:{mealSlot:"晚餐",source:"measured",requestId:"stable-measured-event-id",
    items:[{foodId:"verified-food-id",weightGrams:160}]}
})
~~~

最近纠错：

~~~js
nutrition_execute({
  operation:"correct",memberId:"adult_a",
  args:{foodName:"熟米饭",weightGrams:220,requestId:"stable-correction-id"}
})
~~~

无法唯一定位时必须拒绝并让 Agent 澄清，不能写入另一餐。精确历史纠错使用 `meals` 返回的 `mealId` 与 `expectedRevision`，保留修订审计。

健康手工记录：

~~~js
nutrition_execute({operation:"health",memberId:"adult_a",args:{sleepHours:6.5,rhrBpm:62}})
~~~

设备自动上传**仍由**私有鉴权 `POST /api/health-webhook` 完成，不经过 Agent 重复执行。

### 照片必须有一次整体确认

1. 视觉宿主读取用户图片，并按 `estimate_meal_photo` Prompt 生成结构化识别结果；必要时查 `foods`。
2. `nutrition_execute({operation:"photo_stage",args:{mealSlot,estimate,matches?}})` 返回未入账草稿及简短食物、份量预览。
3. Agent 向用户展示简短预览并取得一次明确同意或更正。
4. 仅在同意之后，传 `photo_confirm` 所需 `draftId`、完整 `decisions`、真实 `confirmationEvidence` 和防重 `requestId`，由现有引擎原子入账。

不得把图片走 `meal` 的文字估算捷径，也不得先入账再向用户索要确认。底层更细的 `decisions` 结构详见 [照片编译协议](PHOTO_ESTIMATION_PROTOCOL.md)，无需让用户逐项填写 JSON。

## 专业模式、兼容与权限边界

| MCP_TOOL_SURFACE | 何时启用 |
| --- | --- |
| `everyday`（默认） | 日常聊天，三查五写 |
| `compact` | 原 v5.4 调用兼容、主动请求的专业操作（旧 12+18 分支） |
| `full` | 历史低层工具兼容、专业运维及维护 |

`compact` 和 `full` **不是**每次遇到难题就让 Agent 自动切换的工具调用：这是部署配置；改动后需要重启 MCP 进程，且会改变使用同一服务实例的客户端可见能力。专业模式的维护者自行决定启用，不向普通 Agent 默认暴露。

对于原先习惯 `quick_meal`、`recent_correction`、`view:"household"` 的 Agent：迁移到本规范，不应在新提示词中同时混放两套名称。

安全边界：家庭 `memberId` 仅用于数据归属，**不是成员级权限认证**；可信共享 NAS Token 持有者能够访问家庭信息。数据库/HTTP Token 不应放入普通对话或公开配置文件。

## 永久保留的工程约束

记录必须有来源，合理估算不得冒充精确测量；修正旧记录而非新增重复餐食；网络重试复用同一 `requestId`；缺失数据不补零；照片不经确认不入账；不存在的食材 ID 不得通过；一次普通餐食不得触发自动校准 TDEE、修改训练计划或宣布全天记录完毕。

产品能力收缩不等于删除旧账本、旧审计记录、专业计算模块或已有 Dashboard/设备同步入口。

## 稳定性验收

保持 MCP 工具目录、参数枚举、两个兼容 profile、错误拒绝路径、修订与幂等的**契约/回归测试**。这里不需要为架构收缩单独进行模型 Token A/B 评测。测试证明程序行为符合约束，不证明模型对食物的识别一定准确。

# 家庭健康观察：Agent-first 使用手册

这是家庭多用户基础之上的第二阶段。**一般健康观察**为默认模式，不将碳循环等针对训练者的模型自动应用于家人。每个用户有自己的远程 MCP Bearer Token 和独立账本。

## Agent 工具

- `set_wellness_mode({mode:"general"})`：一般观察；`performance` 必须主动选择。
- `log_health_observation`：记录血压（收缩压/舒张压，mmHg）、体温（°C）、血糖（mg/dL）或症状备忘，保留测量时间、来源事件 ID 和可选背景。
- `get_my_health_history({days:30})`：仅本人查看详细历史，包括私人备注。
- `get_family_health_report({memberId:"member_b",days:30})`：仅本人或得到 **health_trends** 单独授权的家人能够读取汇总趋势。
- `set_family_sharing({granteeId:"member_a",scope:"health_trends",enabled:true})`：所有者主动授权；`enabled:false` 随时撤销。该授权与 `overview` 不通用。

此外，`family_wellness_workflow` MCP Prompt 提醒 Agent 使用合适的工具、区分观察和推断、尊重未记录/缺失信息。

## 交互示例

> 今天早上量了血压 122/78，帮我记一下。

Agent 确认日期及单位，调用 `log_health_observation({kind:"blood_pressure",systolic:122,diastolic:78,observedAt:"...",sourceEventId:"..."})`，并说明已记录。这不是诊断，不以单次值判定疾病。

> 看看家人 B 最近睡眠和体重有没有变化。

Agent 先验证 `health_trends` 授权，再调用 `get_family_health_report`。报告只能包含各指标样本数、均值、时间段变化和缺失情况。**私人症状文本不通过家人趋势报告分享。**

## 数据与解读边界

- 原始饮食、体重、睡眠等信息来自用户或设备的 **观察**，不是诊断。
- 只有两个比较时段各至少有三条有效观测时才输出差值；样本不足时使用 `comparisonAvailable:false`。
- 不计算统一健康分数，不提供疾病风险概率、自动医疗预警、药物处方或个性化临床判断。
- 无记录不等于健康状态正常。测量方法、设备、时间和主观记录都影响趋势。
- 若对健康状况担忧或出现急症表现，应寻求合适的医疗专业协助。
- 居家健康资料涉及私人隐私；跨成员授权应由数据所有者明确同意，尤其不能只凭家庭关系默认读取儿童或其他受照护人的信息。

## 存储与备份

家庭原本的营养账本在 `/data/members/member-<id>.db`，新增健康记录在 `/data/members/member-health-<id>.db`，授权在 `family-consents.db`。备份应覆盖全部文件、SQLite WAL/SHM 文件和私有成员注册表，不能只备份旧版 `DB_PATH`。

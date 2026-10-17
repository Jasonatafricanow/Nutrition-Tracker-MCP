// Nutrition Tracker MCP 状态引擎：SQLite 账本 + 碳水循环 + 生物遥测 + 动态 TDEE 校准。
// 不依赖 HTTP / MCP，server.js 负责把这里的工具暴露出去。
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { photoEstimateSchema, PHOTO_ESTIMATE_VERSION, PHOTO_ESTIMATION_PROMPT, PHOTO_ESTIMATE_EXAMPLE } from "./photo-estimation.js";

// ==================== 1. 生理常量 ====================
export const CARB_PRESETS = {
  high: {
    label: "高碳日 (HIGH CARB)",
    isTrainingDay: true,
    carbWeight: 1.4, fatWeight: 0.7,
    tdeeFactor: 1.06,
    glycogenDeltaG: 120,
    defaultFocus: "下肢臀腿 / 背部高容量复合日",
    advice: "高碳日仅是营养分配计划。结合训练负荷安排摄入；围训练期进食时机因人而异，不作固定比例或补剂处方。"
  },
  medium: {
    label: "中碳日 (MED CARB)",
    isTrainingDay: true,
    carbWeight: 1.0, fatWeight: 1.0,
    tdeeFactor: 1.00,
    glycogenDeltaG: 0,
    defaultFocus: "胸肩推类 / 手臂肌肥大",
    advice: "中碳日：结合实际训练需求分配蛋白质、脂肪及碳水，注意饮食多样化。"
  },
  low: {
    label: "低碳日 (LOW CARB)",
    isTrainingDay: false,
    carbWeight: 0.5, fatWeight: 1.3,
    tdeeFactor: 0.94,
    glycogenDeltaG: -110,
    defaultFocus: "主动恢复 / 筋膜放松 / Zone 2",
    advice: "低碳日仅是计划安排，不代表改善胰岛素敏感性的医学干预。恢复日仍需确保总能量和个人碳水需求。"
  }
};

export const MEAL_SLOTS = ["早餐", "午餐", "晚餐", "练前餐", "练后餐", "加餐"];
const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const GLYCOGEN_BASE_G = 360;          // 标准肌糖原池
const GLYCOGEN_MIN_G = 200, GLYCOGEN_MAX_G = 550;
const WATER_PER_GLYCOGEN = 4.0;       // 1g 糖原 + 3g 结合水
const KCAL_PER_KG = 7700;
const EWMA_ALPHA = 0.25;
const CAL_DAMPING = 0.35, CAL_MAX_STEP = 120, CAL_BOUND = 0.18;

const DEFAULT_SCHEDULE = [
  ["medium", "胸+三头肌肥大"],
  ["low", "休息 / 核心拉伸"],
  ["high", "下肢深蹲复合日"],
  ["low", "Zone 2 有氧恢复"],
  ["high", "背部硬拉+二头"],
  ["medium", "肩部+薄弱肌群"],
  ["low", "完全休息日"]
];

const DEFAULT_SUPPLEMENTS = [
  ["creatine", "一水肌酸 (Creatine)", "5g", "练后 / 固定时间", 1],
  ["caffeine", "无水咖啡因 / 氮泵", "自定义", "按个人耐受记录", 0],
  ["whey", "分离乳清蛋白粉", "30g", "练后即刻", 1],
  ["electrolytes", "复合电解质饮", "1000mg", "训练中饮用", 0],
  ["omega3", "高纯度鱼油 (Omega-3)", "2000mg", "随晚餐服用", 1],
  ["d3_mag", "维生素 D3 + 甘氨酸镁", "自定义", "依个人需求或医嘱", 1]
];

// 每 100g 可食部营养
const DEFAULT_FOODS = [
  ["f1", "鸡胸肉 (生重)", 24.0, 0.0, 2.0],
  ["f2", "瘦牛排 / 牛腱子 (生重)", 21.0, 0.0, 5.0],
  ["f3", "三文鱼 (生重)", 20.0, 0.0, 13.0],
  ["f4", "全鸡蛋 (1颗约50g)", 13.0, 1.1, 11.0],
  ["f5", "分离乳清蛋白粉", 82.0, 4.0, 2.0],
  ["f6", "生燕麦片", 13.0, 67.0, 6.5],
  ["f7", "熟白米饭", 2.6, 28.0, 0.3],
  ["f8", "红薯 / 紫薯 (蒸熟)", 1.6, 20.0, 0.2],
  ["f9", "意大利面 (干重)", 13.0, 74.0, 1.5],
  ["f10", "牛油果", 2.0, 8.5, 15.0],
  ["f11", "特级初榨橄榄油", 0.0, 0.0, 100.0],
  ["f12", "原味巴旦木 / 坚果", 21.0, 22.0, 50.0],
  ["f13", "西兰花 (水煮)", 2.8, 7.0, 0.4],
  ["f14", "全脂纯牛奶", 3.2, 4.8, 3.6]
];

// ==================== 2. 纯函数 ====================
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const kcalOf = (p, c, f) => Math.round(p * 4 + c * 4 + f * 9);

export function mifflinBmr({ gender, age, height_cm, weightKg }) {
  const base = 10 * weightKg + 6.25 * height_cm - 5 * age;
  return Math.round(gender === "female" ? base - 161 : base + 5);
}

// 目标 + 配比 + 碳水循环三层融合：
//   周均摄入 K = 校准 TDEE + 目标缺口/盈余；配比把 K 拆成基准克数 P0/C0/F0；
//   蛋白质每天恒定，碳水/脂肪按档位权重在一周内重新分配，并按周模板归一化，
//   保证一周平均下来碳水 = C0、脂肪 = F0。
export const MIN_INTAKE_KCAL = 1000;
export function macroPlan({ adaptiveTdee, goalKcal, ratioP, ratioC, ratioF }, weekPlans) {
  const baseKcal = Math.max(MIN_INTAKE_KCAL, adaptiveTdee + goalKcal);
  const base = {
    kcal: baseKcal,
    p: (baseKcal * ratioP) / 100 / 4,
    c: (baseKcal * ratioC) / 100 / 4,
    f: (baseKcal * ratioF) / 100 / 9
  };
  const avgW = (key) => weekPlans.reduce((s, lv) => s + CARB_PRESETS[lv][key], 0) / weekPlans.length;
  const cAvg = avgW("carbWeight"), fAvg = avgW("fatWeight");
  const forLevel = (level) => {
    const ps = CARB_PRESETS[level];
    const p = Math.round(base.p);
    const c = Math.round((base.c * ps.carbWeight) / cAvg);
    const f = Math.round((base.f * ps.fatWeight) / fAvg);
    return { p, c, f, kcal: kcalOf(p, c, f) };
  };
  return {
    base: { kcal: base.kcal, p: Math.round(base.p), c: Math.round(base.c), f: Math.round(base.f) },
    forLevel
  };
}

export function waterShiftKg(glycogenG) {
  return ((glycogenG - GLYCOGEN_BASE_G) * WATER_PER_GLYCOGEN) / 1000;
}

export function readinessScore({ hrv, rhr, sleep, hrvBaseline, rhrBaseline }) {
  const hrvScore = clamp((hrv / hrvBaseline) * 80, 0, 100);
  const rhrDelta = rhr - rhrBaseline;
  const rhrScore = clamp(100 - rhrDelta * 8, 0, 100);
  const sleepScore = clamp((sleep / 8.0) * 100, 0, 100);
  const score = Math.round(0.45 * hrvScore + 0.30 * rhrScore + 0.25 * sleepScore);
  const status = score < 55 || rhrDelta >= 7 ? "RECOVERY_FLAG" : score < 75 ? "CAUTION" : "OPTIMAL";
  return { score, status, rhrDelta };
}

// 用本地时区算日期，避免 toISOString() 在 UTC+8 早上 8 点前落到前一天
export function localDateStr(d = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  // Explicit user time zone; independent of the Node process TZ and host locale.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(d);
  const part = (t) => parts.find((x) => x.type === t).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function offsetDateStr(base, offsetDays) {
  const d = new Date(base + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function dayDiff(a, b) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
export function weekdayIndex(dateStr) {
  return (new Date(dateStr + "T12:00:00Z").getUTCDay() + 6) % 7;
}
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const d = new Date(value + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}, "无效日历日期");

// ==================== 3. 工具参数定义 (MCP 与 HTTP 共用) ====================
const carbLevel = z.enum(["high", "medium", "low"]);
const mealItem = z.object({
  name: z.string().optional().describe("食物名称；用 foodId 时可省略"),
  foodId: z.string().optional().describe("食材库 ID，给出后按每 100g 营养 × 克重自动计算 p/c/f"),
  weightGrams: z.number().positive().describe("摄入克重 (g)"),
  p: z.number().min(0).optional().describe("蛋白质总克数；未给 foodId 时必填"),
  c: z.number().min(0).optional().describe("碳水总克数；未给 foodId 时必填"),
  f: z.number().min(0).optional().describe("脂肪总克数；未给 foodId 时必填")
});

const photoCandidateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  foodId: z.string().max(128).optional().describe("MUST come from search_foods, never from photo vision guess"),
  estimatedWeightGrams: z.number().positive().max(5000).optional(),
  weightRangeGrams: z.tuple([z.number().positive(),z.number().positive()]).optional(),
  confidence: z.enum(["low","medium","high"]).default("low"),
  note: z.string().max(500).default(""),
  state: z.enum(["raw","cooked","packaged","mixed","unknown"]).optional(),
  evidence: z.array(z.string()).max(8).optional(),
  portionMethod: z.enum(["reference_object","container_geometry","visual_only","user_provided","not_estimable"]).optional()
});
const confirmationEvidenceSchema = z.object({
  channel: z.enum(["user_message", "host_approval"]),
  summary: z.string().trim().min(4).max(300),
  reference: z.string().trim().min(1).max(200).optional()
}).strict();
const editMealSchema = {
  mealId: z.string().min(1),
  expectedRevision: z.number().int().min(0),
  requestId: z.string().trim().min(1).max(128),
  weightGrams: z.number().positive().max(5000),
  foodId: z.string().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  portionSource: z.enum(["measured", "user_estimate", "visual_estimate"]).optional(),
  nutritionSource: z.enum(["food_label","trusted_database","user_supplied"]).optional(),
  p: z.number().min(0).optional(),c: z.number().min(0).optional(),f: z.number().min(0).optional()
};
const photoDecisionSchema = z.object({
  index: z.number().int().min(0),
  include: z.boolean(),
  name: z.string().trim().min(1).max(120).optional(),
  foodId: z.string().optional().describe("Use a food ID obtained from search_foods"),
  weightGrams: z.number().positive().max(5000).optional(),
  portionSource: z.enum(["measured","user_estimate","visual_estimate"]).optional(),
  nutritionSource: z.enum(["food_label","trusted_database","user_supplied"]).optional(),
  p: z.number().min(0).optional(), c: z.number().min(0).optional(), f: z.number().min(0).optional()
});

export const TOOL_DEFS = {
  get_photo_estimation_protocol: {
    description: "获取针对食物照片的视觉估算协议与严格的结构化输出示例。把协议与用户图片一同交给具备视觉能力的 Agent；不要凭空生成营养值。",
    shape: {}
  },
  stage_photo_estimate: {
    description: "把外部视觉 Agent 的 nutrition.photo_estimate.v1 编译结果校验并存成未确认草稿。只收严格 JSON、可见证据、食物种类与重量范围；不写入饮食账本、不存储照片。",
    shape: {
      date: calendarDate.optional(), mealSlot: z.enum(MEAL_SLOTS),
      estimate: photoEstimateSchema,
      matches: z.array(z.object({ itemId:z.string(), foodId:z.string() })).max(20).default([])
        .describe("可选：通过 search_foods 独立核验的 itemId→foodId 映射，不能靠视觉凭空生成")
    }
  },
  prepare_photo_meal: {
    description: "兼容 Agent 手动整理的食物候选（推荐改用 stage_photo_estimate 的编译协议）。只暂存草稿，绝不直接记账。",
    shape: { date:calendarDate.optional(),mealSlot:z.enum(MEAL_SLOTS),items:z.array(photoCandidateSchema).min(1).max(20) }
  },
  get_photo_meal_draft: {description:"读取待确认的照片餐食草稿、可用的食材匹配与不确定性", shape:{draftId:z.string().min(1)}},
  confirm_photo_meal: {
    description: "用户审核每个照片候选的食物、份量及营养数据来源后原子入账。必须 confirmed=true，所有候选均给决策；requestId 防重复。",
    shape:{draftId:z.string().min(1),confirmed:z.literal(true),confirmationEvidence:confirmationEvidenceSchema,requestId:z.string().min(1).max(128),decisions:z.array(photoDecisionSchema).min(1).max(20)}
  },
  discard_photo_meal: {description:"取消尚未提交的照片餐食草稿",shape:{draftId:z.string().min(1)}},
  get_agent_context: {
    description: "Agent 优先使用的紧凑上下文：今天营养剩余、完成状态、最近餐食、已存模板与数据风险提示。Dashboard不是操作前提。",
    shape: {}
  },
  get_snapshot: {
    description: "读取当前全量状态：今日档位与宏量配额/已摄入、生物遥测、7 日预测、补剂、校准诊断。做决策前先调它。",
    shape: {}
  },
  set_profile: {
    description: "设置基础生理参数（按 Mifflin-St Jeor × 活动系数重算公式 TDEE，保留已累计的校准偏移），以及热量目标与周均 P/C/F 供能比。碳水循环在周均配比之上按档位重新分配碳水和脂肪。",
    shape: {
      gender: z.enum(["male", "female"]).optional(),
      age: z.number().int().min(10).max(100).optional(),
      heightCm: z.number().min(100).max(250).optional(),
      weightKg: z.number().min(30).max(250).optional().describe("仅在尚无晨起秤重时作为计算体重"),
      activityFactor: z.number().min(1.1).max(2.0).optional().describe("1.2 久坐 / 1.375 轻度 / 1.55 中度 / 1.725 高强度"),
      hrvBaseline: z.number().positive().optional().describe("HRV 基线 (ms)"),
      rhrBaseline: z.number().positive().optional().describe("静息心率基线 (bpm)"),
      goalKcal: z.number().int().min(-1000).max(1000).optional().describe("周均每日热量缺口/盈余：-500 减脂 / -300 温和减脂 / 0 维持 / +300 干净增肌 / +500 强力增肌"),
      ratioP: z.number().int().min(10).max(70).optional().describe("周均蛋白质供能比 %"),
      ratioC: z.number().int().min(5).max(75).optional().describe("周均碳水供能比 %"),
      ratioF: z.number().int().min(10).max(70).optional().describe("周均脂肪供能比 %；三项之和必须为 100")
    }
  },
  log_morning_checkin: {
    description: "记录实测体重与可选健康指标，按明确时区归档，EWMA 仅平滑实测体重；恢复评分为未验证的观察指标，不会自动修改训练或饮食计划。",
    shape: {
      scaleWeightKg: z.number().min(30).max(250).optional().describe("晨起空腹体重秤读数 (kg)"),
      measuredAt: z.string().datetime({ offset: true }).optional().describe("原始测量时间，含 UTC 时区偏移；历史同步按个人时区归档"),
      sourceEventId: z.string().max(200).optional().describe("数据源记录唯一 ID，相同 source+ID 重复发送不重复写入"),
      hrvMetric: z.enum(["SDNN", "RMSSD"]).optional().describe("HRV 度量类型；Apple Health 常见为 SDNN"),
      hrvMs: z.number().positive().optional().describe("HRV 读数 (ms)；必须明确 SDNN 或 RMSSD，不混为一谈"),
      rhrBpm: z.number().positive().optional().describe("晨起静息心率 (bpm)"),
      sleepHours: z.number().min(0).max(24).optional().describe("昨夜睡眠时长 (h)"),
      deepSleepPct: z.number().min(0).max(100).optional().describe("深睡比例 (%)"),
      steps: z.number().int().min(0).optional().describe("今日步数"),
      activeKcal: z.number().min(0).optional().describe("今日活动消耗 (kcal)")
    }
  },
  calibrate_metabolic_tdee: {
    description: "按实际日历日期的完整饮食账本与原始体重趋势预览 TDEE。默认为预览，不写入；apply=true 且数据满足要求时才应用，禁止重复使用同一证据。",
    shape: {
      windowDays: z.number().int().min(7).max(56).default(14).describe("实际日历日数；建议 14–28 天"),
      apply: z.boolean().default(false).describe("显式允许写入经过完整数据检查的估计修正"),
      force: z.boolean().default(false).describe("兼容旧客户端；无法绕过相同证据的幂等保护")
    }
  },
  mark_intake_complete: {
    description: "用户确认指定日期整天饮食已记完整；校准只使用确认过的日记。补录或删除食物会自动取消完成标记。",
    shape: { date: calendarDate.optional(), complete: z.boolean().default(true) }
  },
  set_day_context: {
    description: "手动切换今天的碳水档位 (high/medium/low)、训练/休息日、训练部位与当日建议，自动重算宏量配额与补剂静默",
    shape: {
      carbLevel,
      isTrainingDay: z.boolean().optional(),
      workoutFocus: z.string().optional(),
      agentAdvice: z.string().optional().describe("Agent 生成的当日训练与围训练期饮食建议")
    }
  },
  update_weekly_schedule: {
    description: "修改周模板（周一至周日）的碳水档位与训练内容。给 schedule(7 项) 整体替换，或给 dayIndex+plan 改单天。改到今天所在星期时同步改今日档位。",
    shape: {
      dayIndex: z.number().int().min(0).max(6).optional().describe("0=周一 ... 6=周日"),
      plan: carbLevel.optional(),
      focus: z.string().optional(),
      schedule: z.array(z.object({ plan: carbLevel, focus: z.string() })).length(7).optional()
    }
  },
  log_estimated_meal: {
    description: "普通用户一句话/照片明确要求记餐时，允许估算直接入账。保存来源、估算份量及审计记录；勿把估算称为实测。严格照片审核仍可选用。",
    shape: {
      mealSlot: z.enum(MEAL_SLOTS),
      date: calendarDate.optional(),
      source: z.enum(["text","photo"]),
      requestId: z.string().trim().min(1).max(128).describe("这次记录的稳定 ID；网络重试使用同一个"),
      items: z.array(z.object({
        name: z.string().trim().min(1).max(120),
        weightGrams: z.number().positive().max(5000),
        foodId: z.string().optional().describe("仅使用食材库实际查得的 ID"),
        p: z.number().min(0).optional(),c: z.number().min(0).optional(),f: z.number().min(0).optional()
      })).min(1).max(30)
    }
  },
  log_meal_items: {
    description: "Agent 记录今天或历史某天一餐。优先 search_foods 获取 foodId；用户需确认份量。requestId 可防止网络重试重复记账。不会自动标记全天摄入完整。",
    shape: {
      mealSlot: z.enum(MEAL_SLOTS),
      date: calendarDate.optional().describe("业务日期 YYYY-MM-DD，不填为今天，不能在未来"),
      requestId: z.string().min(1).max(128).optional().describe("每次 Agent 记账操作的稳定唯一 ID；重试保持不变"),
      items: z.array(mealItem).min(1).max(50)
    }
  },
  search_foods: {
    description: "Agent 用关键词搜索本地食材库，返回每100g营养与 foodId。无须读取含大量健康信息的全量快照。",
    shape: { query: z.string().max(100).default(""), limit: z.number().int().min(1).max(50).default(15) }
  },
  get_meal_history: {
    description: "查询指定日期的餐食明细与当日摄入汇总，供 Agent 回顾、复用、纠错；默认今天。",
    shape: { date: calendarDate.optional() }
  },
  save_meal_template: {
    description: "把某个已记录日期的一个餐次保存成可复用模板，复制当时营养数值快照，后续食材库修改不改变模板。",
    shape: {
      name: z.string().trim().min(1).max(80),
      mealSlot: z.enum(MEAL_SLOTS),
      date: calendarDate.optional().describe("从哪一天的这餐保存，默认今天")
    }
  },
  list_meal_templates: {
    description: "按名称查找 Agent 可直接复用的餐食模板及配方，返回模板 ID、各食材重量和营养快照。",
    shape: { query: z.string().max(100).default(""), limit: z.number().int().min(1).max(30).default(20) }
  },
  log_meal_template: {
    description: "Agent 复用已保存餐食模板并写入账本，可指定日期/餐次和份量倍数。需先得到用户对食材及份量的确认。支持 requestId 幂等重试。",
    shape: {
      templateId: z.string().min(1),
      mealSlot: z.enum(MEAL_SLOTS).optional(),
      date: calendarDate.optional(),
      multiplier: z.number().min(0.1).max(5).default(1),
      requestId: z.string().min(1).max(128).optional()
    }
  },
  export_nutrition_data: {
    description: "导出指定日期范围的本地饮食/测量账本和餐食明细(JSON)，用于 Agent 分析或用户备份；只读，最长90天，敏感数据不应发送给未授权的第三方。",
    shape: { fromDate: calendarDate, toDate: calendarDate }
  },
  update_meal_item: {
    description: "Agent 根据餐食 ID 与预期版本原子修改已记账项目；保留修改前后审计，防止并发覆盖和重试重复修改。原份量比例缩放不重新查询食材成分。",
    shape: editMealSchema
  },
  get_meal_corrections: {
    description: "只读查询指定餐食的历史修改记录（旧值、新值、时间及来源），供 Agent 审计和回顾。",
    shape: {mealId:z.string().min(1)}
  },
  delete_meal_item: {
    description: "删除一条膳食记录",
    shape: { mealId: z.string() }
  },
  add_food_to_library: {
    description: "向食材库新增食物（按每 100g 营养成分）",
    shape: {
      name: z.string().min(1),
      p: z.number().min(0).describe("蛋白质 g/100g"),
      c: z.number().min(0).describe("碳水 g/100g"),
      f: z.number().min(0).max(100).describe("脂肪 g/100g")
    }
  },
  update_supplement_stack: {
    description: "打卡今日补剂，或修改今日剂量说明",
    shape: {
      supplementId: z.string().describe("creatine / caffeine / whey / electrolytes / omega3 / d3_mag 等"),
      taken: z.boolean(),
      customDose: z.string().optional().describe("如 '400mg (腿日加量)'")
    }
  }
};

export class ToolError extends Error {}

// ==================== 4. 引擎 ====================
export function createEngine(dbPath, { demo = false, now = () => new Date(), timeZone = process.env.NUTRITION_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  // Fail fast on an invalid IANA time zone.
  new Intl.DateTimeFormat("en-US", { timeZone });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      gender TEXT NOT NULL,
      age INTEGER NOT NULL,
      height_cm REAL NOT NULL,
      activity_factor REAL NOT NULL,
      weight_kg REAL NOT NULL,
      ewma_weight_kg REAL,
      formula_tdee INTEGER NOT NULL,
      adaptive_tdee INTEGER NOT NULL,
      hrv_baseline REAL NOT NULL,
      rhr_baseline REAL NOT NULL,
      goal_kcal INTEGER NOT NULL DEFAULT 0,
      ratio_p INTEGER NOT NULL DEFAULT 30,
      ratio_c INTEGER NOT NULL DEFAULT 40,
      ratio_f INTEGER NOT NULL DEFAULT 30,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weekly_schedule (
      day_index INTEGER PRIMARY KEY CHECK (day_index BETWEEN 0 AND 6),
      plan TEXT NOT NULL,
      focus TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_ledger (
      date TEXT PRIMARY KEY,
      carb_level TEXT NOT NULL,
      is_training_day INTEGER NOT NULL,
      workout_focus TEXT NOT NULL,
      agent_advice TEXT,
      intake_kcal INTEGER NOT NULL DEFAULT 0,
      intake_complete INTEGER NOT NULL DEFAULT 0,
      p_g REAL NOT NULL DEFAULT 0,
      c_g REAL NOT NULL DEFAULT 0,
      f_g REAL NOT NULL DEFAULT 0,
      target_tdee INTEGER NOT NULL,
      est_glycogen_g REAL NOT NULL,
      scale_weight_kg REAL,
      dewatered_weight_kg REAL,
      ewma_weight_kg REAL,
      hrv_ms REAL,
      hrv_metric TEXT,
      weight_measured_at TEXT,
      rhr_bpm REAL,
      sleep_hours REAL,
      deep_sleep_pct REAL,
      steps INTEGER,
      active_kcal REAL,
      readiness_score INTEGER,
      cns_status TEXT
    );
    CREATE TABLE IF NOT EXISTS foods (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      p REAL NOT NULL, c REAL NOT NULL, f REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_logs (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      name TEXT NOT NULL,
      weight_g REAL NOT NULL,
      p REAL NOT NULL, c REAL NOT NULL, f REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_corrections (
      id TEXT PRIMARY KEY, meal_id TEXT NOT NULL, request_id TEXT NOT NULL,
      changed_at TEXT NOT NULL, actor TEXT NOT NULL,
      before_json TEXT NOT NULL, after_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meal_correction_id ON meal_corrections(meal_id,changed_at);
    CREATE INDEX IF NOT EXISTS idx_meal_date ON meal_logs(date);
    CREATE TABLE IF NOT EXISTS photo_meal_drafts (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','logged','discarded')),
      candidates_json TEXT NOT NULL, compiled_estimate_json TEXT,
      created_at TEXT NOT NULL, confirmed_at TEXT,
      commit_request_id TEXT, committed_result_json TEXT
    );
    CREATE TABLE IF NOT EXISTS meal_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, source_date TEXT NOT NULL,
      source_slot TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_template_items (
      template_id TEXT NOT NULL REFERENCES meal_templates(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, name TEXT NOT NULL, weight_g REAL NOT NULL,
      p REAL NOT NULL, c REAL NOT NULL, f REAL NOT NULL,
      PRIMARY KEY(template_id,position)
    );
    CREATE TABLE IF NOT EXISTS agent_request_receipts (
      tool_name TEXT NOT NULL, request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(tool_name,request_id)
    );
    CREATE TABLE IF NOT EXISTS supplements (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dose TEXT NOT NULL,
      timing TEXT NOT NULL,
      active_on_rest INTEGER NOT NULL,
      sort INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS supplement_log (
      date TEXT NOT NULL,
      supplement_id TEXT NOT NULL REFERENCES supplements(id),
      taken INTEGER NOT NULL,
      custom_dose TEXT,
      PRIMARY KEY (date, supplement_id)
    );
    CREATE TABLE IF NOT EXISTS tdee_calibrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calibrated_at TEXT NOT NULL,
      calibrated_date TEXT NOT NULL,
      window_days INTEGER NOT NULL,
      expected_delta_kg REAL NOT NULL,
      actual_ewma_delta_kg REAL NOT NULL,
      raw_drift_kcal INTEGER NOT NULL,
      applied_delta_kcal INTEGER NOT NULL,
      old_tdee INTEGER NOT NULL,
      new_tdee INTEGER NOT NULL,
      diagnostic_note TEXT NOT NULL,
      evidence_hash TEXT,
      last_observation_date TEXT
    );
    CREATE TABLE IF NOT EXISTS health_ingest_events (
      source TEXT NOT NULL, source_event_id TEXT NOT NULL,
      measured_at TEXT, received_at TEXT NOT NULL, ledger_date TEXT NOT NULL,
      PRIMARY KEY (source, source_event_id)
    );
    CREATE TABLE IF NOT EXISTS mcp_event_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      summary TEXT NOT NULL
    );
  `);

  const q = (sql) => db.prepare(sql);

  // 旧库补列（v5.0 的库没有目标/配比字段）
  const profileCols = new Set(q("PRAGMA table_info(user_profile)").all().map((c) => c.name));
  for (const [col, def] of [["goal_kcal", 0], ["ratio_p", 30], ["ratio_c", 40], ["ratio_f", 30]]) {
    if (!profileCols.has(col)) db.exec(`ALTER TABLE user_profile ADD COLUMN ${col} INTEGER NOT NULL DEFAULT ${def}`);
  }

  for (const [table, columns] of Object.entries({
    daily_ledger: [["intake_complete", "INTEGER NOT NULL DEFAULT 0"], ["hrv_metric", "TEXT"], ["weight_measured_at", "TEXT"]],
    meal_logs: [["source_kind", "TEXT"], ["source_ref", "TEXT"], ["portion_source", "TEXT"], ["revision", "INTEGER NOT NULL DEFAULT 0"]],
    photo_meal_drafts: [["confirmation_evidence_json", "TEXT"]],
    tdee_calibrations: [["evidence_hash", "TEXT"], ["last_observation_date", "TEXT"]]
  })) {
    const have = new Set(q(`PRAGMA table_info(${table})`).all().map((x) => x.name));
    for (const [column, definition] of columns) {
      if (!have.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const today = () => localDateStr(now(), timeZone);
  const nowIso = () => now().toISOString();

  // ---------- 初始化默认数据 ----------
  function seedDefaults() {
    if (q("SELECT COUNT(*) AS n FROM user_profile").get().n > 0) return;
    tx(() => {
      const prof = { gender: "male", age: 30, height_cm: 175, weightKg: 75, activity: 1.55 };
      const formula = Math.round(mifflinBmr(prof) * prof.activity);
      q(`INSERT INTO user_profile (id, gender, age, height_cm, activity_factor, weight_kg, ewma_weight_kg,
           formula_tdee, adaptive_tdee, hrv_baseline, rhr_baseline, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, NULL, ?, ?, 68, 54, ?)`)
        .run(prof.gender, prof.age, prof.height_cm, prof.activity, prof.weightKg, formula, formula, nowIso());
      const insS = q("INSERT INTO weekly_schedule (day_index, plan, focus) VALUES (?, ?, ?)");
      DEFAULT_SCHEDULE.forEach(([plan, focus], i) => insS.run(i, plan, focus));
      const insSup = q("INSERT INTO supplements (id, name, dose, timing, active_on_rest, sort) VALUES (?, ?, ?, ?, ?, ?)");
      DEFAULT_SUPPLEMENTS.forEach((s, i) => insSup.run(...s, i));
      const insF = q("INSERT INTO foods (id, name, p, c, f, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      DEFAULT_FOODS.forEach((f) => insF.run(...f, nowIso()));
      journal("SYSTEM_INIT", "init", {}, "数据库初始化：默认档案、周排期、补剂栈与食材库已写入");
    });
  }

  // 演示数据：过去 6 天账本 + 今天的晨起打卡，呈现轻微代谢适应
  function seedDemo() {
    if (q("SELECT COUNT(*) AS n FROM daily_ledger").get().n > 0) return;
    const t = today();
    const p = getProfile();
    const rows = [
      [-6, "medium", "胸肩推类", 2150, 360, 75.00, 75.00, 75.00, 70, 53, 7.6],
      [-5, "low", "主动恢复", 1750, 250, 74.45, 74.89, 74.99, 66, 54, 7.2],
      [-4, "high", "下肢深蹲", 2680, 370, 74.98, 74.94, 74.98, 72, 52, 8.1],
      [-3, "low", "Zone 2有氧", 1720, 260, 74.48, 74.88, 74.96, 64, 55, 7.0],
      [-2, "high", "背部硬拉", 2650, 380, 74.96, 74.88, 74.94, 69, 53, 7.8],
      [-1, "low", "核心拉伸", 1700, 270, 74.46, 74.82, 74.92, 67, 54, 7.5]
    ];
    tx(() => {
      const ins = q(`INSERT INTO daily_ledger (date, carb_level, is_training_day, workout_focus, intake_kcal,
          p_g, c_g, f_g, target_tdee, est_glycogen_g, scale_weight_kg, dewatered_weight_kg, ewma_weight_kg,
          hrv_ms, rhr_bpm, sleep_hours, readiness_score, cns_status)
        VALUES (?, ?, ?, ?, ?, 160, ?, 55, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [off, plan, focus, intake, gly, scale, dew, ewma, hrv, rhr, sleep] of rows) {
        const r = readinessScore({ hrv, rhr, sleep, hrvBaseline: p.hrv_baseline, rhrBaseline: p.rhr_baseline });
        ins.run(offsetDateStr(t, off), plan, plan === "low" ? 0 : 1, focus, intake,
          plan === "high" ? 300 : plan === "medium" ? 195 : 75,
          Math.round(p.adaptive_tdee * CARB_PRESETS[plan].tdeeFactor), gly, scale, dew, ewma,
          hrv, rhr, sleep, r.score, r.status);
      }
      q("UPDATE daily_ledger SET intake_complete = 1 WHERE date < ? AND intake_kcal > 0").run(t);
      q("UPDATE user_profile SET ewma_weight_kg = 74.92, weight_kg = 74.46 WHERE id = 1").run();
    });
    ensureToday();
    execute("log_morning_checkin", { scaleWeightKg: 74.92, hrvMs: 72, hrvMetric: "RMSSD", rhrBpm: 53, sleepHours: 7.8, deepSleepPct: 22 }, "DEMO_SEED");
    execute("log_meal_items", { mealSlot: "早餐", items: [{ foodId: "f4", weightGrams: 100 }, { foodId: "f6", weightGrams: 60 }] }, "DEMO_SEED");
  }

  // ---------- 读取 ----------
  const getProfile = () => q("SELECT * FROM user_profile WHERE id = 1").get();
  const getSchedule = () => q("SELECT * FROM weekly_schedule ORDER BY day_index").all();
  const getRow = (date) => q("SELECT * FROM daily_ledger WHERE date = ?").get(date);
  const getPrevRow = (date) => q("SELECT * FROM daily_ledger WHERE date < ? ORDER BY date DESC LIMIT 1").get(date);
  const bodyWeight = (p) => p.ewma_weight_kg ?? p.weight_kg;
  const currentPlan = () => {
    const p = getProfile();
    return macroPlan(
      { adaptiveTdee: p.adaptive_tdee, goalKcal: p.goal_kcal, ratioP: p.ratio_p, ratioC: p.ratio_c, ratioF: p.ratio_f },
      getSchedule().map((s) => s.plan)
    );
  };

  function glycogenAfter(date, level) {
    const prev = getPrevRow(date);
    return clamp((prev ? prev.est_glycogen_g : GLYCOGEN_BASE_G) + CARB_PRESETS[level].glycogenDeltaG, GLYCOGEN_MIN_G, GLYCOGEN_MAX_G);
  }

  // 每天第一次被访问时按周模板生成当天账本行
  function ensureToday() {
    const t = today();
    if (getRow(t)) return t;
    const s = getSchedule()[weekdayIndex(t)];
    const preset = CARB_PRESETS[s.plan];
    q(`INSERT OR IGNORE INTO daily_ledger (date, carb_level, is_training_day, workout_focus, agent_advice, target_tdee, est_glycogen_g)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(t, s.plan, preset.isTrainingDay ? 1 : 0, s.focus, preset.advice,
        Math.round(getProfile().adaptive_tdee * preset.tdeeFactor), glycogenAfter(t, s.plan));
    return t;
  }

  function applyDayLevel(date, level, { isTrainingDay, focus, advice } = {}) {
    const preset = CARB_PRESETS[level];
    q(`UPDATE daily_ledger SET carb_level = ?, is_training_day = ?, workout_focus = ?, agent_advice = ?,
         target_tdee = ?, est_glycogen_g = ? WHERE date = ?`)
      .run(level, (isTrainingDay ?? preset.isTrainingDay) ? 1 : 0, focus || preset.defaultFocus,
        advice || preset.advice, Math.round(getProfile().adaptive_tdee * preset.tdeeFactor),
        glycogenAfter(date, level), date);
  }

  function recomputeWeightTrend() {
    let smoothed = null;
    let latest = null;
    const rows = q("SELECT date, scale_weight_kg FROM daily_ledger WHERE scale_weight_kg IS NOT NULL AND date <= ? ORDER BY date").all(today());
    for (const r of rows) {
      smoothed = smoothed == null ? r.scale_weight_kg : EWMA_ALPHA*r.scale_weight_kg + (1-EWMA_ALPHA)*smoothed;
      q("UPDATE daily_ledger SET dewatered_weight_kg = ?, ewma_weight_kg = ? WHERE date = ?")
        .run(r.scale_weight_kg, round2(smoothed), r.date);
      latest = r;
    }
    if (latest) q("UPDATE user_profile SET weight_kg = ?, ewma_weight_kg = ?, updated_at = ? WHERE id = 1")
      .run(latest.scale_weight_kg, round2(smoothed), nowIso());
  }

  function ensureLedger(date) {
    if (date > today()) throw new ToolError("不能写入未来业务日期");
    if (getRow(date)) return;
    const s = getSchedule()[weekdayIndex(date)];
    const preset = CARB_PRESETS[s.plan];
    q(`INSERT OR IGNORE INTO daily_ledger (date, carb_level, is_training_day, workout_focus, agent_advice, target_tdee, est_glycogen_g)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(date, s.plan, preset.isTrainingDay ? 1 : 0, s.focus, preset.advice,
        Math.round(getProfile().adaptive_tdee * preset.tdeeFactor), GLYCOGEN_BASE_G);
  }

  function recalcIntake(date) {
    const s = q("SELECT COALESCE(SUM(p),0) AS p, COALESCE(SUM(c),0) AS c, COALESCE(SUM(f),0) AS f FROM meal_logs WHERE date = ?").get(date);
    q("UPDATE daily_ledger SET intake_kcal = ?, p_g = ?, c_g = ?, f_g = ?, intake_complete = 0 WHERE date = ?")
      .run(kcalOf(s.p, s.c, s.f), round1(s.p), round1(s.c), round1(s.f), date);
  }

  // Agent writes can be retried by MCP hosts. Receipts and meal rows are committed
  // atomically so transport retries cannot silently double daily calorie intake.
  function commitMeal({toolName, requestId, payload, date, slot, rows}) {
    if (date > today()) throw new ToolError("不能记录未来日期的膳食");
    const payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    return tx(() => {
      if (requestId) {
        const receipt = q("SELECT * FROM agent_request_receipts WHERE tool_name = ? AND request_id = ?").get(toolName,requestId);
        if (receipt) {
          if (receipt.payload_hash !== payloadHash) throw new ToolError("requestId 已用于不同请求；请生成新的 requestId");
          return { ...JSON.parse(receipt.result_json), duplicate: true };
        }
      }
      ensureLedger(date);
      const ins = q("INSERT INTO meal_logs (id, date, slot, name, weight_g, p, c, f, created_at, source_kind, portion_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const ids = [];
      for (const r of rows) {
        if (r.p + r.c + r.f > r.w * 1.001) throw new ToolError("营养素总质量不能超过食物份量");
        const id = "m_" + randomUUID();
        ins.run(id,date,slot,r.name,r.w,r.p,r.c,r.f,nowIso(),r.sourceKind??null,r.portionSource??null);
        ids.push(id);
      }
      recalcIntake(date); // History edits must also invalidate intake_complete.
      const ledger = getRow(date);
      const result = {ok:true, date, mealSlot:slot, mealIds:ids, items:rows, todayIntakeKcal:ledger.intake_kcal, dayIntakeKcal:ledger.intake_kcal, intakeComplete:false};
      if (requestId) q("INSERT INTO agent_request_receipts (tool_name,request_id,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)")
        .run(toolName,requestId,payloadHash,JSON.stringify(result),nowIso());
      return result;
    });
  }

  function photoDraftView(raw) {
    const candidates=JSON.parse(raw.candidates_json);
    const estimate=raw.compiled_estimate_json?JSON.parse(raw.compiled_estimate_json):null;
    const items=candidates.map((item,index)=>{
      const food=item.foodId?q("SELECT id,name,p,c,f FROM foods WHERE id=?").get(item.foodId):null;
      const grams=item.estimatedWeightGrams;
      return {index,...item,needsFoodMatch:!food,foodMatch:food??null,
        estimated:food && grams!=null?{
          p:round1(food.p*grams/100),c:round1(food.c*grams/100),f:round1(food.f*grams/100),
          kcal:kcalOf(food.p*grams/100,food.c*grams/100,food.f*grams/100)
        }:{} };
    });
    return {ok:true,draftId:raw.id,date:raw.date,mealSlot:raw.slot,status:raw.status,
      confirmationEvidence:raw.confirmation_evidence_json?JSON.parse(raw.confirmation_evidence_json):null,
      compiledEstimate:estimate,items,questions:estimate?.questions??[],
      hiddenOrUnquantified:estimate?.hiddenOrUnquantified??[],
      photoStored:false,isLogged:raw.status==='logged'};
  }
  function createPhotoDraft(date,mealSlot,items,compiledEstimate=null) {
    if (date>today()) throw new ToolError("不能记录未来日期的照片草稿");
    if (!items.length) throw new ToolError("照片草稿不能没有候选食物");
    for (const item of items) {
      if (item.foodId && !q("SELECT id FROM foods WHERE id=?").get(item.foodId)) throw new ToolError(`食材库找不到 ${item.foodId}`);
      if (item.weightRangeGrams && !(item.weightRangeGrams[0]<=item.estimatedWeightGrams && item.estimatedWeightGrams<=item.weightRangeGrams[1]))
        throw new ToolError("估重必须落在上下限内");
    }
    const id='photo_'+randomUUID();
    q("INSERT INTO photo_meal_drafts(id,date,slot,status,candidates_json,compiled_estimate_json,created_at) VALUES (?,?,?,'open',?,?,?)")
      .run(id,date,mealSlot,JSON.stringify(items),compiledEstimate?JSON.stringify(compiledEstimate):null,nowIso());
    return photoDraftView(q("SELECT * FROM photo_meal_drafts WHERE id=?").get(id));
  }

  function journal(source, toolName, payload, summary) {
    q("INSERT INTO mcp_event_journal (created_at, source, tool_name, payload_json, summary) VALUES (?, ?, ?, ?, ?)")
      .run(nowIso(), source, toolName, JSON.stringify(payload), summary);
  }

  // ---------- 观察与 TDEE 校准 ----------
  // Calendar based, never count a weigh-in as a calendar day. 7,700 kcal/kg is
  // an approximate sensitivity model, NOT proof of metabolic adaptation.
  function computeCalibration(windowDays = 14) {
    const profile = getProfile();
    const lastWeight = q("SELECT * FROM daily_ledger WHERE scale_weight_kg IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 1").get(today());
    if (!lastWeight) return { ok: false, reason: "没有实测体重记录" };
    const lowerBound = offsetDateStr(lastWeight.date, -windowDays);
    const weights = q(`SELECT * FROM daily_ledger WHERE date >= ? AND date <= ?
      AND scale_weight_kg IS NOT NULL ORDER BY date`).all(lowerBound, lastWeight.date);
    if (weights.length < 3) return { ok: false, reason: `窗口内仅 ${weights.length} 次称重，至少需要 3 次` };
    const first = weights[0], last = weights[weights.length - 1];
    const nDays = dayDiff(first.date, last.date);
    if (nDays < 7) return { ok: false, reason: `实际跨度 ${nDays} 天，至少需要 7 天数据以减少短期噪声` };
    const ledger = q("SELECT * FROM daily_ledger WHERE date >= ? AND date < ? ORDER BY date").all(first.date, last.date);
    const byDate = new Map(ledger.map((r) => [r.date, r]));
    const data = [];
    for (let k = 0; k < nDays; k++) {
      const date = offsetDateStr(first.date, k);
      const row = byDate.get(date);
      data.push({ date, row, complete: !!row?.intake_complete && Number.isFinite(row.intake_kcal) });
    }
    const unlogged = data.filter((x) => !x.complete).length;
    const coverage = (nDays - unlogged) / nDays;
    if (coverage < 0.9) return {
      ok: false, reason: `窗口内 ${unlogged}/${nDays} 天未确认完整饮食记录，当前覆盖率 ${(coverage*100).toFixed(0)}%；至少需 90%`,
      windowDays: nDays, unloggedDays: unlogged, coverage
    };
    // Never treat missing records as zero-intake or scale partial balances up silently.
    if (unlogged > 0) return { ok: false, reason: `尚有 ${unlogged} 天未确认的摄入数据，继续补录后再计算`, windowDays: nDays, unloggedDays: unlogged, coverage };
    const balance = data.reduce((sum, x) => sum + x.row.intake_kcal - x.row.target_tdee, 0);
    const expectedDeltaKg = round2(balance / KCAL_PER_KG);
    // Linear weight trend uses all independent scale observations, including irregular dates.
    // Do not anchor the change estimate to one noisy first/last weight or presumed glycogen pool.
    const coords = weights.map((w) => ({ x: dayDiff(first.date, w.date), y: Number(w.scale_weight_kg) }));
    const mx = coords.reduce((sum, v) => sum + v.x, 0) / coords.length;
    const my = coords.reduce((sum, v) => sum + v.y, 0) / coords.length;
    const denom = coords.reduce((sum, v) => sum + (v.x - mx) ** 2, 0);
    const slope = coords.reduce((sum, v) => sum + (v.x - mx) * (v.y - my), 0) / denom;
    const actualEwmaDeltaKg = round2(slope * nDays); // legacy API name; now a regression trend delta
    const rss = coords.reduce((sum, v) => sum + (v.y - (my + slope * (v.x-mx)))**2, 0);
    const slopeSe = coords.length > 2 ? Math.sqrt(rss / (coords.length - 2) / denom) : Infinity;
    const weightNoiseThresholdKg = Math.max(0.20, 1.96 * slopeSe * nDays);
    const actualScaleDeltaKg = round2(last.scale_weight_kg - first.scale_weight_kg);
    const discrepancy = actualEwmaDeltaKg - expectedDeltaKg;
    const rawDriftKcal = Math.round(-(discrepancy * KCAL_PER_KG) / nDays);
    const minSafe = Math.round(profile.formula_tdee * (1 - CAL_BOUND));
    const maxSafe = Math.round(profile.formula_tdee * (1 + CAL_BOUND));
    // Small shifts may be measurement noise; no automatic 'metabolic damage' diagnosis.
    const step = Math.abs(discrepancy) > weightNoiseThresholdKg
      ? clamp(Math.round(rawDriftKcal * CAL_DAMPING), -CAL_MAX_STEP, CAL_MAX_STEP) : 0;
    const newTdee = clamp(profile.adaptive_tdee + step, minSafe, maxSafe);
    const appliedDeltaKcal = newTdee - profile.adaptive_tdee;
    const evidence = data.map((x) => [x.date, x.row.intake_kcal, x.row.target_tdee]);
    const evidenceHash = createHash("sha256").update(JSON.stringify({ first:first.date, last:last.date,
      weights:weights.map((r) => [r.date,r.scale_weight_kg]), evidence })).digest("hex");
    const prior = q("SELECT id FROM tdee_calibrations WHERE evidence_hash = ? AND applied_delta_kcal != 0 LIMIT 1").get(evidenceHash);
    const previous = q("SELECT last_observation_date FROM tdee_calibrations WHERE applied_delta_kcal != 0 ORDER BY id DESC LIMIT 1").get();
    const reusedEvidence = !!prior;
    const noNewObservation = previous?.last_observation_date && last.date <= previous.last_observation_date;
    const diagnosticNote = `估计值（非代谢诊断）：${nDays} 日摄入覆盖 100%，能量收支对应 ${expectedDeltaKg} kg，实测体重回归趋势变化 ${actualEwmaDeltaKg} kg；差异 ${round2(discrepancy)} kg。可能来自体液、摄入误差、活动或模型简化。`;
    return {
      ok: true, windowDays: nDays, weightSamples: weights.length, unloggedDays: 0, coverage: 1,
      expectedDeltaKg, actualEwmaDeltaKg, actualTrendDeltaKg:actualEwmaDeltaKg, actualScaleDeltaKg, rawDriftKcal,
      weightNoiseThresholdKg:round2(weightNoiseThresholdKg),
      appliedDeltaKcal: (reusedEvidence || noNewObservation) ? 0 : appliedDeltaKcal,
      oldTdee: profile.adaptive_tdee,
      newTdee: (reusedEvidence || noNewObservation) ? profile.adaptive_tdee : newTdee,
      reusedEvidence: !!(reusedEvidence || noNewObservation), evidenceHash,
      lastObservationDate:last.date, safeRange: [minSafe, maxSafe], diagnosticNote
    };
  }

  // ---------- 工具实现 ----------
  const tools = {
    get_photo_estimation_protocol() {
      return {result:{ok:true,schemaVersion:PHOTO_ESTIMATE_VERSION,prompt:PHOTO_ESTIMATION_PROMPT,example:PHOTO_ESTIMATE_EXAMPLE,
        instructions:"Provide user image in the agent context. Call stage_photo_estimate with exact schema, then search_foods/confirm. No photo or nutrition numbers from the image are stored."},summary:null};
    },
    stage_photo_estimate(a) {
      // zod validates the complete evidence-carrying compiled artifact before any mutation.
      const seen=new Set(), matched=new Map();
      for(const match of a.matches){
        if(seen.has(match.itemId))throw new ToolError("重复 itemId 食材映射");
        seen.add(match.itemId); matched.set(match.itemId,match.foodId);
      }
      for(const id of matched.keys())if(!a.estimate.items.some(i=>i.id===id))throw new ToolError(`未识别的 itemId: ${id}`);
      const candidates=a.estimate.items.map(item=>({
        name:item.predictedName,foodId:matched.get(item.id),
        estimatedWeightGrams:item.ediblePortion.grams??undefined,
        weightRangeGrams:item.ediblePortion.minGrams==null?undefined:[item.ediblePortion.minGrams,item.ediblePortion.maxGrams],
        confidence:item.identificationConfidence,
        note:item.ediblePortion.evidence,
        state:item.foodState,evidence:item.visibleEvidence,portionMethod:item.ediblePortion.method,
        candidateId:item.id
      }));
      const draft=createPhotoDraft(a.date??today(),a.mealSlot,candidates,a.estimate);
      return {result:{...draft,compilationStatus:'validated_unconfirmed',
        reviewRequired:true},summary:`Agent 照片分析已编译成草稿 ${draft.draftId}，等待用户核对`};
    },
    prepare_photo_meal(a) {
      const draft=createPhotoDraft(a.date??today(),a.mealSlot,a.items);
      return {result:{...draft,compilationStatus:'legacy_candidate_unconfirmed',reviewRequired:true},summary:null};
    },
    get_photo_meal_draft(a) {
      const draft=q("SELECT * FROM photo_meal_drafts WHERE id=?").get(a.draftId);
      if(!draft)throw new ToolError("找不到照片草稿");
      return {result:photoDraftView(draft),summary:null};
    },
    confirm_photo_meal(a) {
      const draft=q("SELECT * FROM photo_meal_drafts WHERE id=?").get(a.draftId);
      if(!draft)throw new ToolError("找不到照片草稿");
      const payloadHash=createHash('sha256').update(JSON.stringify(a)).digest('hex');
      if(draft.status==='discarded')throw new ToolError("照片草稿已取消");
      if(draft.status==='logged'){
        if(draft.commit_request_id===a.requestId){
          const receipt=q("SELECT * FROM agent_request_receipts WHERE tool_name=? AND request_id=?")
            .get('confirm_photo_meal',a.requestId);
          if(receipt?.payload_hash!==payloadHash)throw new ToolError("requestId 已用于不同内容");
          return {result:{...JSON.parse(draft.committed_result_json),duplicate:true},summary:null};
        }
        throw new ToolError("草稿已经提交，不能再次入账");
      }
      const candidates=JSON.parse(draft.candidates_json);
      if(a.decisions.length!==candidates.length)throw new ToolError("必须逐一审查每个照片候选");
      const seen=new Set();
      for(const d of a.decisions){
        if(d.index>=candidates.length||seen.has(d.index))throw new ToolError("重复或无效的 index 决策");
        seen.add(d.index);
      }
      const excluded=[];
      const rows=[];
      for(const d of a.decisions.slice().sort((x,y)=>x.index-y.index)){
        const candidate=candidates[d.index];
        if(!d.include){excluded.push(candidate.name);continue;}
        if(d.weightGrams==null||!d.portionSource)throw new ToolError("必须核对每项的确认份量及份量来源");
        const foodId=d.foodId??candidate.foodId;
        let macros;
        if(foodId){
          const food=q("SELECT * FROM foods WHERE id=?").get(foodId);
          if(!food)throw new ToolError(`不存在食物库 ID: ${foodId}`);
          const scale=d.weightGrams/100;
          macros={p:round1(food.p*scale),c:round1(food.c*scale),f:round1(food.f*scale)};
        }else{
          if(!d.nutritionSource||d.p==null||d.c==null||d.f==null)
            throw new ToolError("没有匹配食材库时，必须提供可核实的 nutritionSource 及 p/c/f；不能从照片想象营养值");
          macros={p:d.p,c:d.c,f:d.f};
        }
        rows.push({name:d.name??candidate.name,w:d.weightGrams,...macros,portionSource:d.portionSource});
      }
      if(!rows.length)throw new ToolError("不能提交空餐食");
      for(const r of rows)if(r.p+r.c+r.f>r.w*1.001)throw new ToolError("营养素总质量不能大于份量");
      // draft status, provenance, meals, receipt are committed as one SQLite transaction.
      const result=tx(()=>{
        const receipt=q("SELECT * FROM agent_request_receipts WHERE tool_name=? AND request_id=?")
          .get('confirm_photo_meal',a.requestId);
        if(receipt)throw new ToolError("requestId 已用于其他照片草稿");
        ensureLedger(draft.date);
        const ids=[];
        const insert=q(`INSERT INTO meal_logs(id,date,slot,name,weight_g,p,c,f,created_at,source_kind,source_ref,portion_source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        for(const r of rows){
          const id='m_'+randomUUID(); ids.push(id);
          insert.run(id,draft.date,draft.slot,r.name,r.w,r.p,r.c,r.f,nowIso(),'agent_photo_confirmed',draft.id,r.portionSource);
        }
        recalcIntake(draft.date);
        const result={ok:true,date:draft.date,mealSlot:draft.slot,draftId:draft.id,mealIds:ids,items:rows,
          excludedItems:excluded,partial:excluded.length>0||!!JSON.parse(draft.compiled_estimate_json??'null')?.hiddenOrUnquantified?.length,
          intakeComplete:false,photoStored:false};
        q("INSERT INTO agent_request_receipts(tool_name,request_id,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)")
          .run('confirm_photo_meal',a.requestId,payloadHash,JSON.stringify(result),nowIso());
        q("UPDATE photo_meal_drafts SET status='logged',confirmed_at=?,commit_request_id=?,committed_result_json=?,confirmation_evidence_json=? WHERE id=?")
          .run(nowIso(),a.requestId,JSON.stringify(result),JSON.stringify(a.confirmationEvidence),draft.id);
        return result;
      });
      return {result,summary:`用户确认照片餐食 ${draft.id}，记录 ${rows.length} 个候选，${excluded.length} 个排除`};
    },
    discard_photo_meal(a) {
      const d=q("SELECT * FROM photo_meal_drafts WHERE id=?").get(a.draftId);
      if(!d)throw new ToolError("找不到照片草稿");
      if(d.status==='logged')throw new ToolError("已入账的餐食不能通过取消草稿删除");
      q("UPDATE photo_meal_drafts SET status='discarded' WHERE id=?").run(a.draftId);
      return {result:{ok:true,draftId:a.draftId,status:'discarded'},summary:null};
    },
    get_agent_context() {
      const s=buildSnapshot();
      const templates=q("SELECT id,name,source_slot FROM meal_templates ORDER BY created_at DESC,id LIMIT 10").all();
      return {result:{
        ok:true,date:s.date,timeZone:s.timeZone,
        carbLevel:s.today.carb_level,workoutFocus:s.today.workout_focus,
        target:{...s.targets},
        consumed:{kcal:s.today.intake_kcal,p:s.today.p_g,c:s.today.c_g,f:s.today.f_g},
        remaining:{kcal:s.targets.kcal-s.today.intake_kcal,p:round1(s.targets.p-s.today.p_g),c:round1(s.targets.c-s.today.c_g),f:round1(s.targets.f-s.today.f_g)},
        intakeComplete:!!s.today.intake_complete,
        recentMeals:s.meals.slice(-12).map(m=>({id:m.id,revision:m.revision,slot:m.slot,name:m.name,weight_g:m.weight_g,p:m.p,c:m.c,f:m.f})),
        templates, pendingPhotoDrafts:q("SELECT id,date,slot,status FROM photo_meal_drafts WHERE status='open' ORDER BY created_at DESC LIMIT 5").all(), nutritionWarnings:s.nutritionWarnings,
        agentGuidance:"确认食物、份量及日期后记账；不要将未知摄入记为零；修改餐食将取消全天已完整标记。"
      },summary:null};
    },
    get_snapshot() {
      return { result: buildSnapshot(), summary: null };
    },

    set_profile(a) {
      const p = getProfile();
      // 有了晨起秤重后体重以 EWMA 为准，手填体重只在冷启动时生效
      const weightKg = p.ewma_weight_kg == null && a.weightKg != null ? a.weightKg : p.weight_kg;
      const next = {
        gender: a.gender ?? p.gender,
        age: a.age ?? p.age,
        height_cm: a.heightCm ?? p.height_cm,
        activity: a.activityFactor ?? p.activity_factor,
        weightKg: p.ewma_weight_kg ?? weightKg
      };
      const formula = Math.round(mifflinBmr(next) * next.activity);
      const offset = p.adaptive_tdee - p.formula_tdee; // 保留历次校准累计的偏移
      const goal = a.goalKcal ?? p.goal_kcal;
      const ratio = { p: a.ratioP ?? p.ratio_p, c: a.ratioC ?? p.ratio_c, f: a.ratioF ?? p.ratio_f };
      if (ratio.p + ratio.c + ratio.f !== 100) {
        throw new ToolError(`P/C/F 供能比之和必须为 100，当前 ${ratio.p}+${ratio.c}+${ratio.f}=${ratio.p + ratio.c + ratio.f}`);
      }
      tx(() => {
        q(`UPDATE user_profile SET gender = ?, age = ?, height_cm = ?, activity_factor = ?, weight_kg = ?,
             formula_tdee = ?, adaptive_tdee = ?, hrv_baseline = ?, rhr_baseline = ?,
             goal_kcal = ?, ratio_p = ?, ratio_c = ?, ratio_f = ?, updated_at = ? WHERE id = 1`)
          .run(next.gender, next.age, next.height_cm, next.activity, weightKg, formula, formula + offset,
            a.hrvBaseline ?? p.hrv_baseline, a.rhrBaseline ?? p.rhr_baseline,
            goal, ratio.p, ratio.c, ratio.f, nowIso());
        const row = getRow(today());
        q("UPDATE daily_ledger SET target_tdee = ? WHERE date = ?")
          .run(Math.round((formula + offset) * CARB_PRESETS[row.carb_level].tdeeFactor), row.date);
      });
      const plan = currentPlan();
      return {
        result: { ok: true, formulaTdee: formula, adaptiveTdee: formula + offset, weeklyBase: plan.base },
        summary: `档案更新：公式 TDEE ${p.formula_tdee} → ${formula}，校准 TDEE ${formula + offset}；目标 ${goal >= 0 ? "+" : ""}${goal} → 周均 ${plan.base.kcal} kcal (P${ratio.p}/C${ratio.c}/F${ratio.f})`
      };
    },

    log_morning_checkin(a, source = "MCP_AGENT") {
      if (a.hrvMs != null && !a.hrvMetric) throw new ToolError("提供 hrvMs 时必须声明 hrvMetric: SDNN 或 RMSSD");
      if (a.measuredAt && Date.parse(a.measuredAt) > now().getTime() + 5*60_000) throw new ToolError("测量时间不能位于未来");
      const t = a.measuredAt ? localDateStr(new Date(a.measuredAt), timeZone) : today();
      const parts = [];
      const out = { ledgerDate: t };
      const key = a.sourceEventId ? source + ":" + a.sourceEventId : null;
      tx(() => {
        if (key) {
          const r = q("INSERT OR IGNORE INTO health_ingest_events (source, source_event_id, measured_at, received_at, ledger_date) VALUES (?, ?, ?, ?, ?)")
            .run(source, a.sourceEventId, a.measuredAt ?? null, nowIso(), t);
          if (!r.changes) { out.duplicate = true; return; }
        }
        ensureLedger(t);
        if (a.scaleWeightKg != null) {
          q("UPDATE daily_ledger SET scale_weight_kg = ?, weight_measured_at = ? WHERE date = ?")
            .run(a.scaleWeightKg, a.measuredAt ?? nowIso(), t);
          recomputeWeightTrend();
          const r = getRow(t);
          Object.assign(out, { scaleWeightKg: a.scaleWeightKg, dewateredWeightKg: a.scaleWeightKg,
            waterShiftKg: 0, ewmaWeightKg: r.ewma_weight_kg });
          parts.push(`实测体重 ${a.scaleWeightKg}kg；原始体重 EWMA ${r.ewma_weight_kg}kg（未进行假设糖原扣水）`);
        }
        const set = (col, v) => { if (v != null) q(`UPDATE daily_ledger SET ${col} = ? WHERE date = ?`).run(v, t); };
        set("hrv_ms", a.hrvMs);set("hrv_metric",a.hrvMetric);
        set("rhr_bpm", a.rhrBpm);set("sleep_hours", a.sleepHours);
        set("deep_sleep_pct", a.deepSleepPct);set("steps", a.steps);set("active_kcal", a.activeKcal);
        if (a.hrvMs != null || a.rhrBpm != null || a.sleepHours != null) {
          const r=getRow(t), p=getProfile();
          if (r.hrv_ms != null && r.rhr_bpm != null && r.sleep_hours != null && r.hrv_metric === "RMSSD") {
            // This is an unvalidated flag, NOT evidence to rewrite nutrition or prescribe supplements.
            const x=readinessScore({ hrv:r.hrv_ms,rhr:r.rhr_bpm,sleep:r.sleep_hours,hrvBaseline:p.hrv_baseline,rhrBaseline:p.rhr_baseline });
            q("UPDATE daily_ledger SET readiness_score = ?, cns_status = ? WHERE date = ?").run(x.score,x.status,t);
            out.readinessScore=x.score;out.cnsStatus=x.status;
            parts.push(`恢复参考指数 ${x.score}/100 (${x.status})；需人工评估，未自动变更饮食或训练`);
          } else if (r.hrv_ms != null && r.hrv_metric === "SDNN") {
            q("UPDATE daily_ledger SET readiness_score = NULL, cns_status = NULL WHERE date = ?").run(t);
            parts.push("SDNN 与当前 RMSSD 基线不可直接比较，恢复指数未计算");
          }
        }
      });
      if (out.duplicate) return { result:{ok:true,duplicate:true,ledgerDate:t},summary:null };
      out.carbLevel=getRow(t).carb_level;
      return { result:out,summary:parts.join("；") || "健康数据已记录" };
    },

    calibrate_metabolic_tdee(a) {
      const cal = computeCalibration(a.windowDays ?? 14);
      if (!cal.ok) return { result: cal, summary: `TDEE 暂不调整：${cal.reason}` };
      if (!a.apply) return { result: { ...cal, previewOnly: true }, summary: null };
      if (cal.reusedEvidence) return { result: { ...cal, appliedDeltaKcal:0, reason:"没有新增独立的称重证据；禁止重复校准" }, summary: null };
      tx(() => {
        if (cal.appliedDeltaKcal !== 0) {
          q("UPDATE user_profile SET adaptive_tdee = ?, updated_at = ? WHERE id = 1").run(cal.newTdee, nowIso());
          const row = getRow(today());
          q("UPDATE daily_ledger SET target_tdee = ? WHERE date = ?")
            .run(Math.round(cal.newTdee * CARB_PRESETS[row.carb_level].tdeeFactor), today());
        }
        q(`INSERT INTO tdee_calibrations (calibrated_at, calibrated_date, window_days, expected_delta_kg, actual_ewma_delta_kg,
             raw_drift_kcal, applied_delta_kcal, old_tdee, new_tdee, diagnostic_note, evidence_hash, last_observation_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nowIso(), today(),cal.windowDays,
          cal.expectedDeltaKg,cal.actualEwmaDeltaKg,cal.rawDriftKcal,cal.appliedDeltaKcal,cal.oldTdee,
          cal.newTdee,cal.diagnosticNote,cal.evidenceHash,cal.lastObservationDate);
      });
      return { result:cal, summary:`TDEE 人工确认估计更新：${cal.oldTdee} → ${cal.newTdee} kcal` };
    },

    mark_intake_complete(a) {
      const date = a.date ?? today();
      if (date > today()) throw new ToolError("未来日期不能标记完整");
      ensureLedger(date);
      q("UPDATE daily_ledger SET intake_complete = ? WHERE date = ?").run(a.complete?1:0,date);
      return { result:{ok:true,date,complete:a.complete},summary:`${date} 日饮食记录标记为${a.complete?"完整":"未完成"}` };
    },

    set_day_context(a) {
      const t = today();
      applyDayLevel(t, a.carbLevel, { isTrainingDay: a.isTrainingDay, focus: a.workoutFocus, advice: a.agentAdvice });
      const row = getRow(t);
      return {
        result: { ok: true, carbLevel: row.carb_level, isTrainingDay: !!row.is_training_day, targetTdee: row.target_tdee },
        summary: `今日切换为 ${CARB_PRESETS[a.carbLevel].label} · ${row.workout_focus}，目标消耗 ${row.target_tdee} kcal`
      };
    },

    update_weekly_schedule(a) {
      const upd = q("UPDATE weekly_schedule SET plan = ?, focus = COALESCE(?, focus) WHERE day_index = ?");
      const touched = [];
      tx(() => {
        if (a.schedule) {
          a.schedule.forEach((d, i) => { upd.run(d.plan, d.focus, i); touched.push(i); });
        } else if (a.dayIndex != null && a.plan) {
          upd.run(a.plan, a.focus ?? null, a.dayIndex);
          touched.push(a.dayIndex);
        } else {
          throw new ToolError("需要 schedule(7 项)，或 dayIndex + plan");
        }
        const t = today();
        const ti = weekdayIndex(t);
        if (touched.includes(ti)) {
          const s = getSchedule()[ti];
          applyDayLevel(t, s.plan, { focus: s.focus });
        }
      });
      const desc = a.schedule ? "整周排期已替换" : `${DAY_NAMES[a.dayIndex]} 改为 ${a.plan.toUpperCase()}`;
      return { result: { ok: true, schedule: getSchedule() }, summary: `周排期更新：${desc}` };
    },

    log_estimated_meal(a) {
      // Low-friction path: user's request to LOG authorizes an explicitly estimated entry.
      // No extra confirmation turn. Provenance remains visible and corrections are audited.
      const date=a.date??today();
      const rows=a.items.map(it=>{
        let macros;
        if(it.foodId){
          const food=q("SELECT id,name,p,c,f FROM foods WHERE id=?").get(it.foodId);
          if(!food)throw new ToolError("没有匹配的食材库 ID");
          if(it.p!=null||it.c!=null||it.f!=null)throw new ToolError("匹配食材库时不要混入独立估算营养值");
          const factor=it.weightGrams/100;
          macros={p:round1(food.p*factor),c:round1(food.c*factor),f:round1(food.f*factor)};
        }else{
          if([it.p,it.c,it.f].some(x=>x==null))throw new ToolError("无 foodId 时需要完整的估算 p/c/f");
          macros={p:it.p,c:it.c,f:it.f};
        }
        return {name:it.name,w:it.weightGrams,...macros,
          sourceKind:a.source==='photo'?'agent_photo_estimate':'agent_text_estimate',
          portionSource:a.source==='photo'?'visual_estimate':'user_estimate'};
      });
      const result=commitMeal({toolName:"log_estimated_meal",requestId:a.requestId,payload:a,date,slot:a.mealSlot,rows});
      return {result:{...result,estimated:true,provenance:a.source,editable:true},
        summary:result.duplicate?null:`估算记账 ${date}【${a.mealSlot}】共 ${rows.length} 项，可纠错`};
    },

    log_meal_items(a) {
      const date=a.date??today();
      const rows=a.items.map((it)=>{
        if (it.foodId) {
          const food=q("SELECT * FROM foods WHERE id = ?").get(it.foodId);
          if (!food) throw new ToolError(`食材库里没有 ${it.foodId}`);
          const k=it.weightGrams/100;
          return {name:it.name||food.name,w:it.weightGrams,p:round1(food.p*k),c:round1(food.c*k),f:round1(food.f*k)};
        }
        if (!it.name || it.p==null || it.c==null || it.f==null) throw new ToolError("没有 foodId 的条目必须给 name、p、c、f");
        return {name:it.name,w:it.weightGrams,p:it.p,c:it.c,f:it.f};
      });
      const result=commitMeal({toolName:"log_meal_items",requestId:a.requestId,payload:a,date,slot:a.mealSlot,rows});
      return {result,summary:result.duplicate?null:`记录 ${date}【${a.mealSlot}】${rows.map(r=>`${r.name}(${r.w}g)`).join(" + ")}`};
    },

    search_foods(a) {
      const escaped=a.query.trim().replace(/[\\%_]/g,ch=>"\\"+ch);
      const rows=q("SELECT id,name,p,c,f FROM foods WHERE name LIKE ? ESCAPE '\\' ORDER BY CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, name LIMIT ?")
        .all(`%${escaped}%`,`${escaped}%`,a.limit);
      return {result:{ok:true,query:a.query,foods:rows},summary:null};
    },

    get_meal_history(a) {
      const date=a.date??today();
      if (date>today()) throw new ToolError("不能查询未来业务日期");
      const ledger=getRow(date)??null;
      const rows=q("SELECT id,slot,name,weight_g,p,c,f,created_at,source_kind,source_ref,portion_source,revision FROM meal_logs WHERE date=? ORDER BY created_at,id").all(date);
      return {result:{ok:true,date,intakeComplete:!!ledger?.intake_complete,intakeKcal:ledger?.intake_kcal??0,proteinG:ledger?.p_g??0,carbG:ledger?.c_g??0,fatG:ledger?.f_g??0,meals:rows},summary:null};
    },

    save_meal_template(a) {
      const date=a.date??today();
      if (date>today()) throw new ToolError("不能从未来日期保存模板");
      const meals=q("SELECT name,weight_g,p,c,f FROM meal_logs WHERE date=? AND slot=? ORDER BY created_at,id").all(date,a.mealSlot);
      if (!meals.length) throw new ToolError("该日期/餐次没有食物记录，无法保存模板");
      const id="tmpl_"+randomUUID();
      tx(()=>{
        q("INSERT INTO meal_templates(id,name,source_date,source_slot,created_at) VALUES (?,?,?,?,?)").run(id,a.name,date,a.mealSlot,nowIso());
        const ins=q("INSERT INTO meal_template_items(template_id,position,name,weight_g,p,c,f) VALUES (?,?,?,?,?,?,?)");
        meals.forEach((r,i)=>ins.run(id,i,r.name,r.weight_g,r.p,r.c,r.f));
      });
      return {result:{ok:true,templateId:id,name:a.name,sourceDate:date,mealSlot:a.mealSlot,items:meals},summary:`模板「${a.name}」保存于 ${date} ${a.mealSlot}`};
    },

    list_meal_templates(a) {
      const escaped=a.query.trim().replace(/[\\%_]/g,ch=>"\\"+ch);
      const list=q("SELECT * FROM meal_templates WHERE name LIKE ? ESCAPE '\\' ORDER BY created_at DESC,id LIMIT ?").all(`%${escaped}%`,a.limit);
      const sel=q("SELECT name,weight_g,p,c,f FROM meal_template_items WHERE template_id=? ORDER BY position");
      return {result:{ok:true,templates:list.map(t=>({...t,items:sel.all(t.id)}))},summary:null};
    },

    log_meal_template(a) {
      const template=q("SELECT * FROM meal_templates WHERE id=?").get(a.templateId);
      if (!template) throw new ToolError("不存在该餐食模板");
      const rows=q("SELECT * FROM meal_template_items WHERE template_id=? ORDER BY position").all(template.id);
      if (!rows.length) throw new ToolError("餐食模板为空");
      const resolved=rows.map(r=>({name:r.name,w:round1(r.weight_g*a.multiplier),p:round1(r.p*a.multiplier),c:round1(r.c*a.multiplier),f:round1(r.f*a.multiplier)}));
      const date=a.date??today(),slot=a.mealSlot??template.source_slot;
      const result=commitMeal({toolName:"log_meal_template",requestId:a.requestId,payload:a,date,slot,rows:resolved});
      return {result:{...result,templateId:template.id,templateName:template.name},summary:result.duplicate?null:`复用餐食「${template.name}」到 ${date} ${slot}`};
    },

    export_nutrition_data(a) {
      if(a.fromDate>a.toDate)throw new ToolError("fromDate 不能晚于 toDate");
      if(a.toDate>today())throw new ToolError("不能导出未来日期");
      const days=Math.round((new Date(a.toDate+"T12:00:00Z")-new Date(a.fromDate+"T12:00:00Z"))/86400000)+1;
      if(days>90)throw new ToolError("一次最多导出90天，请拆分日期区间");
      const ledger=q("SELECT * FROM daily_ledger WHERE date BETWEEN ? AND ? ORDER BY date").all(a.fromDate,a.toDate);
      const meals=q("SELECT * FROM meal_logs WHERE date BETWEEN ? AND ? ORDER BY date,slot,created_at,id").all(a.fromDate,a.toDate);
      return {result:{ok:true,formatVersion:1,fromDate:a.fromDate,toDate:a.toDate,timeZone,ledger,meals,exportedAt:nowIso()},summary:null};
    },

    update_meal_item(a, source) {
      const payloadHash=createHash("sha256").update(JSON.stringify(a)).digest("hex");
      const result=tx(()=>{
        const receipt=q("SELECT * FROM agent_request_receipts WHERE tool_name=? AND request_id=?")
          .get("update_meal_item",a.requestId);
        if(receipt){
          if(receipt.payload_hash!==payloadHash)throw new ToolError("requestId 已用于不同的修改内容");
          return {...JSON.parse(receipt.result_json),duplicate:true};
        }
        const before=q("SELECT * FROM meal_logs WHERE id=?").get(a.mealId);
        if(!before)throw new ToolError("未找到需要修改的餐食");
        if(before.revision!==a.expectedRevision)throw new ToolError("餐食版本已变化；请重新读取历史后再修改");
        const nutrients=[a.p,a.c,a.f];
        const hasAny=nutrients.some(x=>x!==undefined),hasAll=nutrients.every(x=>x!==undefined);
        if(hasAny && !hasAll)throw new ToolError("必须同时提供 p、c、f");
        if(a.foodId && hasAny)throw new ToolError("foodId 与显式营养值不能同时指定");
        let name=a.name??before.name, p,c,f;
        if(a.foodId){
          const food=q("SELECT * FROM foods WHERE id=?").get(a.foodId);
          if(!food)throw new ToolError("食材库没有指定食物");
          name=a.name??food.name;
          const ratio=a.weightGrams/100;
          p=round1(food.p*ratio);c=round1(food.c*ratio);f=round1(food.f*ratio);
        }else if(hasAll){
          if(!a.nutritionSource)throw new ToolError("直接输入营养值需要营养来源");
          p=a.p;c=a.c;f=a.f;
        }else{
          if(a.nutritionSource)throw new ToolError("没有新营养值时不能指定新的营养来源");
          // Recalculate from stored snapshot, not mutable food catalog.
          const factor=a.weightGrams/before.weight_g;
          p=round1(before.p*factor);c=round1(before.c*factor);f=round1(before.f*factor);
        }
        if(p+c+f>a.weightGrams*1.001)throw new ToolError("营养素总质量不能超过食物份量");
        const nowValue=nowIso();
        const change=q(`UPDATE meal_logs SET name=?,weight_g=?,p=?,c=?,f=?,
          portion_source=COALESCE(?,portion_source),revision=revision+1 WHERE id=? AND revision=?`)
          .run(name,a.weightGrams,p,c,f,a.portionSource??null,a.mealId,a.expectedRevision);
        if(change.changes!==1)throw new ToolError("餐食版本冲突");
        const after=q("SELECT * FROM meal_logs WHERE id=?").get(a.mealId);
        q("INSERT INTO meal_corrections(id,meal_id,request_id,changed_at,actor,before_json,after_json) VALUES (?,?,?,?,?,?,?)")
          .run("edit_"+randomUUID(),a.mealId,a.requestId,nowValue,source??"MCP_AGENT",JSON.stringify(before),JSON.stringify(after));
        recalcIntake(before.date);
        const result={ok:true,mealId:a.mealId,date:before.date,before:{revision:before.revision,weightGrams:before.weight_g,p:before.p,c:before.c,f:before.f},
          after:{revision:after.revision,weightGrams:after.weight_g,p:after.p,c:after.c,f:after.f},
          dayIntakeKcal:getRow(before.date).intake_kcal,intakeComplete:false};
        q("INSERT INTO agent_request_receipts(tool_name,request_id,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)")
          .run("update_meal_item",a.requestId,payloadHash,JSON.stringify(result),nowValue);
        return result;
      });
      return {result,summary:result.duplicate?null:`修正餐食 ${a.mealId}：${result.before.weightGrams}g → ${result.after.weightGrams}g`};
    },

    get_meal_corrections(a) {
      const entries=q("SELECT id,meal_id,request_id,changed_at,actor,before_json,after_json FROM meal_corrections WHERE meal_id=? ORDER BY changed_at,id").all(a.mealId);
      return {result:{ok:true,mealId:a.mealId,corrections:entries.map(e=>({id:e.id,changedAt:e.changed_at,actor:e.actor,before:JSON.parse(e.before_json),after:JSON.parse(e.after_json)}))},summary:null};
    },

    delete_meal_item(a) {
      const m = q("SELECT * FROM meal_logs WHERE id = ?").get(a.mealId);
      if (!m) throw new ToolError(`没有膳食记录 ${a.mealId}`);
      tx(() => {
        q("DELETE FROM meal_logs WHERE id = ?").run(a.mealId);
        recalcIntake(m.date);
      });
      return { result: { ok: true }, summary: `删除膳食：${m.name}(${m.weight_g}g)` };
    },

    add_food_to_library(a) {
      if (a.p + a.c + a.f > 100.01) throw new ToolError("每 100g 食物的蛋白质、碳水和脂肪合计不能大于 100g");
      const id = "custom_" + randomUUID();
      q("INSERT INTO foods (id, name, p, c, f, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, a.name, a.p, a.c, a.f, nowIso());
      return { result: { ok: true, foodId: id }, summary: `食材库新增：${a.name} (每100g P${a.p} C${a.c} F${a.f})` };
    },

    update_supplement_stack(a) {
      const s = q("SELECT * FROM supplements WHERE id = ?").get(a.supplementId);
      if (!s) throw new ToolError(`未知补剂 ${a.supplementId}`);
      q(`INSERT INTO supplement_log (date, supplement_id, taken, custom_dose) VALUES (?, ?, ?, ?)
         ON CONFLICT(date, supplement_id) DO UPDATE SET taken = excluded.taken,
           custom_dose = COALESCE(excluded.custom_dose, supplement_log.custom_dose)`)
        .run(today(), a.supplementId, a.taken ? 1 : 0, a.customDose ?? null);
      return { result: { ok: true }, summary: `补剂 ${s.name} → ${a.taken ? "已服用" : "待服用"}${a.customDose ? ` (${a.customDose})` : ""}` };
    }
  };

  // ---------- 快照 ----------
  function buildSnapshot() {
    const t = ensureToday();
    const profile = getProfile();
    const row = getRow(t);
    const bw = bodyWeight(profile);
    const schedule = getSchedule();
    const ti = weekdayIndex(t);
    const effectiveWeek = schedule.map((s, i) => i === ti ? row.carb_level : s.plan);
    const macro = macroPlan({ adaptiveTdee:profile.adaptive_tdee, goalKcal:profile.goal_kcal,
      ratioP:profile.ratio_p,ratioC:profile.ratio_c,ratioF:profile.ratio_f }, effectiveWeek);
    const targets = macro.forLevel(row.carb_level);

    // 滚动 7 天预测：今天用账本档位，之后按周模板
    const prev = getPrevRow(t);
    let gly = prev ? prev.est_glycogen_g : GLYCOGEN_BASE_G;
    let tissue = 0;
    const forecast = [];
    for (let k = 0; k < 7; k++) {
      const di = (ti + k) % 7;
      const plan = k === 0 ? row.carb_level : schedule[di].plan;
      const ps = CARB_PRESETS[plan];
      const { p: pG, c: cG, f: fG, kcal: intakeKcal } = macro.forLevel(plan);
      const tdee = Math.round(profile.adaptive_tdee * ps.tdeeFactor);
      tissue += (intakeKcal - tdee) / KCAL_PER_KG;
      gly = clamp(gly + ps.glycogenDeltaG, GLYCOGEN_MIN_G, GLYCOGEN_MAX_G);
      forecast.push({
        offset: k, date: offsetDateStr(t, k), day: DAY_NAMES[di], dayIndex: di, plan,
        focus: k === 0 ? row.workout_focus : schedule[di].focus,
        intakeKcal, tdee, pG, cG, fG, glycogenG: gly,
        predictedTissueKg: round2(bw + tissue),
        predictedScaleKg: round2(bw + tissue + waterShiftKg(gly))
      });
    }

    const supplements = q(`SELECT s.*, COALESCE(l.taken, 0) AS taken, l.custom_dose FROM supplements s
      LEFT JOIN supplement_log l ON l.supplement_id = s.id AND l.date = ? ORDER BY s.sort`).all(t)
      .map((s) => ({
        id: s.id, name: s.name, timing: s.timing,
        dose: s.custom_dose || s.dose, taken: !!s.taken,
        muted: !row.is_training_day && !s.active_on_rest
      }));

    const journals = q("SELECT * FROM mcp_event_journal ORDER BY id DESC LIMIT 12").all();

    return {
      demo, date: t, todayIndex: ti, timeZone,
      nutritionWarnings: (() => {
        const proteinPerKg = targets.p / Math.max(1,bw);
        return proteinPerKg < 1.2 ? [`蛋白质计划约 ${proteinPerKg.toFixed(2)}g/kg；对训练者可能偏低，请根据个人需要核对目标`] : [];
      })(),
      profile: { ...profile, bmr: mifflinBmr({ ...profile, weightKg: bw }), body_weight_kg: bw },
      today: { ...row, label: CARB_PRESETS[row.carb_level].label },
      targets,
      weeklyBase: macro.base,
      effectiveWeekTargets: effectiveWeek.map((lv, i) => ({ dayIndex:i, plan:lv, ...macro.forLevel(lv) })),
      history: q("SELECT * FROM (SELECT * FROM daily_ledger ORDER BY date DESC LIMIT 14) ORDER BY date ASC").all(),
      calibrationPreview: computeCalibration(7),
      calibrationHistory: q("SELECT * FROM tdee_calibrations ORDER BY id DESC LIMIT 5").all(),
      schedule: schedule.map((s) => ({ ...s, day: DAY_NAMES[s.day_index] })),
      forecast,
      supplements,
      meals: q("SELECT * FROM meal_logs WHERE date = ? ORDER BY created_at").all(t),
      foods: q("SELECT * FROM foods ORDER BY created_at DESC, id").all(),
      journals,
      lastEvent: journals[0] || null,
      mealSlots: MEAL_SLOTS
    };
  }

  // ---------- 统一派发 ----------
  function execute(toolName, rawArgs = {}, source = "MCP_AGENT") {
    const def = TOOL_DEFS[toolName];
    if (!def) throw new ToolError(`未知工具: ${toolName}`);
    const parsed = z.object(def.shape).safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new ToolError("参数错误: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
    }
    ensureToday();
    const { result, summary } = tools[toolName](parsed.data, source);
    if (summary) journal(source, toolName, parsed.data, summary);
    return result;
  }

  seedDefaults();
  if (demo) seedDemo(); // 必须在 ensureToday 之前，否则账本非空会跳过种子
  ensureToday();

  return {
    execute,
    buildSnapshot,
    dataVersion: () => q("PRAGMA data_version").get().data_version,
    close: () => db.close()
  };
}

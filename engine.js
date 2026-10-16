// Nutrition Tracker MCP 状态引擎：SQLite 账本 + 碳水循环 + 生物遥测 + 动态 TDEE 校准。
// 不依赖 HTTP / MCP，server.js 负责把这里的工具暴露出去。
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

// ==================== 1. 生理常量 ====================
export const CARB_PRESETS = {
  high: {
    label: "高碳日 (HIGH CARB)",
    isTrainingDay: true,
    carbWeight: 1.4, fatWeight: 0.7,
    tdeeFactor: 1.06,
    glycogenDeltaG: 120,
    defaultFocus: "下肢臀腿 / 背部高容量复合日",
    advice: "糖原超量恢复窗口：练前 90min 补充 35% 碳水，练后即刻补充 45% 高GI快碳+分离乳清；全天严格控脂。"
  },
  medium: {
    label: "中碳日 (MED CARB)",
    isTrainingDay: true,
    carbWeight: 1.0, fatWeight: 1.0,
    tdeeFactor: 1.00,
    glycogenDeltaG: 0,
    defaultFocus: "胸肩推类 / 手臂肌肥大",
    advice: "稳态代谢窗口：70% 碳水集中于围训练期，早晚餐适量加入全蛋、牛油果或深海鱼维持激素合成。"
  },
  low: {
    label: "低碳日 (LOW CARB)",
    isTrainingDay: false,
    carbWeight: 0.5, fatWeight: 1.3,
    tdeeFactor: 0.94,
    glycogenDeltaG: -110,
    defaultFocus: "主动恢复 / 筋膜放松 / Zone 2",
    advice: "胰岛素敏感度重塑窗口：碳水下调、脂肪补位，蛋白质保持不变保护瘦体重，自动静默练前氮泵与咖啡因。"
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
  ["caffeine", "无水咖啡因 / 氮泵", "220mg", "练前 30 分钟", 0],
  ["whey", "分离乳清蛋白粉", "30g", "练后即刻", 1],
  ["electrolytes", "复合电解质饮", "1000mg", "训练中饮用", 0],
  ["omega3", "高纯度鱼油 (Omega-3)", "2000mg", "随晚餐服用", 1],
  ["d3_mag", "维生素 D3 + 甘氨酸镁", "4000IU+300mg", "睡前 45 分钟", 1]
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
  const status = score < 55 || rhrDelta >= 7 ? "OVERRIDE_REST" : score < 75 ? "CAUTION" : "OPTIMAL";
  return { score, status, rhrDelta };
}

// 用本地时区算日期，避免 toISOString() 在 UTC+8 早上 8 点前落到前一天
export function localDateStr(d = new Date()) {
  return d.toLocaleDateString("sv-SE");
}
function offsetDateStr(base, offsetDays) {
  const d = new Date(base + "T12:00:00");
  d.setDate(d.getDate() + offsetDays);
  return localDateStr(d);
}
export function weekdayIndex(dateStr) {
  return (new Date(dateStr + "T12:00:00").getDay() + 6) % 7; // 0=周一
}

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

export const TOOL_DEFS = {
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
    description: "录入晨起空腹秤重与手机健康遥测(HRV/静息心率/睡眠等)。秤重会剥离糖原结合水、更新 EWMA 净重；HRV/RHR/睡眠会重算 CNS 准备度，红区自动熔断为低碳恢复日。字段都可选，只更新给出的部分。",
    shape: {
      scaleWeightKg: z.number().min(30).max(250).optional().describe("晨起空腹体重秤读数 (kg)"),
      hrvMs: z.number().positive().optional().describe("心率变异性 RMSSD (ms)"),
      rhrBpm: z.number().positive().optional().describe("晨起静息心率 (bpm)"),
      sleepHours: z.number().min(0).max(24).optional().describe("昨夜睡眠时长 (h)"),
      deepSleepPct: z.number().min(0).max(100).optional().describe("深睡比例 (%)"),
      steps: z.number().int().min(0).optional().describe("今日步数"),
      activeKcal: z.number().min(0).optional().describe("今日活动消耗 (kcal)")
    }
  },
  calibrate_metabolic_tdee: {
    description: "按账本里『热量收支推算的净重变化』与『实际去水 EWMA 净重变化』的偏差，阻尼修正基准 TDEE。同一天只执行一次，除非 force=true。",
    shape: {
      windowDays: z.number().int().min(3).max(28).default(7).describe("回溯窗口（有秤重的天数）"),
      force: z.boolean().default(false).describe("今天已校准过仍强制再执行")
    }
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
  log_meal_items: {
    description: "记录今日一餐的食物。每项给 foodId(查食材库) 或直接给 name+p/c/f 克数。",
    shape: {
      mealSlot: z.enum(MEAL_SLOTS),
      items: z.array(mealItem).min(1)
    }
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
      f: z.number().min(0).describe("脂肪 g/100g")
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
export function createEngine(dbPath, { demo = false, now = () => new Date() } = {}) {
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
      p_g REAL NOT NULL DEFAULT 0,
      c_g REAL NOT NULL DEFAULT 0,
      f_g REAL NOT NULL DEFAULT 0,
      target_tdee INTEGER NOT NULL,
      est_glycogen_g REAL NOT NULL,
      scale_weight_kg REAL,
      dewatered_weight_kg REAL,
      ewma_weight_kg REAL,
      hrv_ms REAL,
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
    CREATE INDEX IF NOT EXISTS idx_meal_date ON meal_logs(date);
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
      diagnostic_note TEXT NOT NULL
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

  const tx = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); db.exec("COMMIT"); return r; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  };
  const today = () => localDateStr(now());
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
      q("UPDATE user_profile SET ewma_weight_kg = 74.92, weight_kg = 74.46 WHERE id = 1").run();
    });
    ensureToday();
    execute("log_morning_checkin", { scaleWeightKg: 74.92, hrvMs: 72, rhrBpm: 53, sleepHours: 7.8, deepSleepPct: 22 }, "DEMO_SEED");
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

  function recalcIntake(date) {
    const s = q("SELECT COALESCE(SUM(p),0) AS p, COALESCE(SUM(c),0) AS c, COALESCE(SUM(f),0) AS f FROM meal_logs WHERE date = ?").get(date);
    q("UPDATE daily_ledger SET intake_kcal = ?, p_g = ?, c_g = ?, f_g = ? WHERE date = ?")
      .run(kcalOf(s.p, s.c, s.f), round1(s.p), round1(s.c), round1(s.f), date);
  }

  function journal(source, toolName, payload, summary) {
    q("INSERT INTO mcp_event_journal (created_at, source, tool_name, payload_json, summary) VALUES (?, ?, ?, ?, ?)")
      .run(nowIso(), source, toolName, JSON.stringify(payload), summary);
  }

  // ---------- 动态 TDEE 校准 ----------
  function computeCalibration(windowDays = 7) {
    const profile = getProfile();
    const rows = q("SELECT * FROM daily_ledger WHERE scale_weight_kg IS NOT NULL ORDER BY date DESC LIMIT ?")
      .all(windowDays).reverse();
    if (rows.length < 3) {
      return { ok: false, reason: `有效空腹体重样本 ${rows.length} 天，不足 3 天，暂不校准` };
    }
    const first = rows[0], last = rows[rows.length - 1];
    const nDays = rows.length - 1;

    // 最后一天的摄入尚未结束，不计入；没记饮食的天不能当作 0 摄入
    let balance = 0, unlogged = 0;
    for (const r of rows.slice(0, -1)) {
      if (r.intake_kcal > 0) balance += r.intake_kcal - r.target_tdee;
      else unlogged++;
    }
    if (unlogged > nDays / 2) {
      return { ok: false, reason: `窗口内 ${unlogged}/${nDays} 天没有饮食记录，热量收支不可信，暂不校准` };
    }
    const expectedDeltaKg = round2(balance / KCAL_PER_KG);
    const actualEwmaDeltaKg = round2(last.ewma_weight_kg - first.ewma_weight_kg);
    const actualScaleDeltaKg = round2(last.scale_weight_kg - first.scale_weight_kg);
    const discrepancy = actualEwmaDeltaKg - expectedDeltaKg;
    const loggedDays = nDays - unlogged;
    const rawDriftKcal = Math.round(-(discrepancy * KCAL_PER_KG) / loggedDays);

    const step = clamp(Math.round(rawDriftKcal * CAL_DAMPING), -CAL_MAX_STEP, CAL_MAX_STEP);
    const minSafe = Math.round(profile.formula_tdee * (1 - CAL_BOUND));
    const maxSafe = Math.round(profile.formula_tdee * (1 + CAL_BOUND));
    const newTdee = clamp(profile.adaptive_tdee + step, minSafe, maxSafe);
    const appliedDeltaKcal = newTdee - profile.adaptive_tdee;

    const gapNote = unlogged ? `（${unlogged} 天无饮食记录已排除）` : "";
    const diagnosticNote = discrepancy > 0.08
      ? `检测到代谢适应下调：过去 ${nDays} 天按热量收支应变化 ${expectedDeltaKg}kg，实际去水 EWMA 净重变化 ${actualEwmaDeltaKg}kg（空腹秤重变化 ${actualScaleDeltaKg}kg）${gapNote}。真实消耗比账面低约 ${Math.abs(rawDriftKcal)}kcal/d，阻尼后建议基准 TDEE ${appliedDeltaKcal}kcal。`
      : discrepancy < -0.08
      ? `检测到高代谢通量：实际去水净重下降快于预期 ${Math.abs(round2(discrepancy))}kg${gapNote}，真实消耗比账面高约 ${Math.abs(rawDriftKcal)}kcal/d，阻尼后建议基准 TDEE +${appliedDeltaKcal}kcal。`
      : `代谢模型吻合：预测净重与实际去水 EWMA 偏差 ${discrepancy.toFixed(2)}kg${gapNote}，维持当前 TDEE。`;

    return {
      ok: true, windowDays: nDays, unloggedDays: unlogged,
      expectedDeltaKg, actualEwmaDeltaKg, actualScaleDeltaKg, rawDriftKcal,
      appliedDeltaKcal: Math.abs(discrepancy) > 0.08 ? appliedDeltaKcal : 0,
      oldTdee: profile.adaptive_tdee,
      newTdee: Math.abs(discrepancy) > 0.08 ? newTdee : profile.adaptive_tdee,
      safeRange: [minSafe, maxSafe],
      diagnosticNote
    };
  }

  // ---------- 工具实现 ----------
  const tools = {
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

    log_morning_checkin(a) {
      const t = today();
      const p = getProfile();
      const row = getRow(t);
      const prev = getPrevRow(t);
      const out = {};
      const parts = [];

      tx(() => {
        if (a.scaleWeightKg != null) {
          // 用昨天吃完后的糖原池估算今早的结合水
          const shift = waterShiftKg(prev ? prev.est_glycogen_g : GLYCOGEN_BASE_G);
          const dewatered = round2(a.scaleWeightKg - shift);
          const prevEwmaRow = q("SELECT ewma_weight_kg FROM daily_ledger WHERE date < ? AND ewma_weight_kg IS NOT NULL ORDER BY date DESC LIMIT 1").get(t);
          const prevEwma = prevEwmaRow?.ewma_weight_kg ?? p.ewma_weight_kg;
          const ewma = prevEwma == null ? dewatered : round2(EWMA_ALPHA * dewatered + (1 - EWMA_ALPHA) * prevEwma);
          q("UPDATE daily_ledger SET scale_weight_kg = ?, dewatered_weight_kg = ?, ewma_weight_kg = ? WHERE date = ?")
            .run(a.scaleWeightKg, dewatered, ewma, t);
          q("UPDATE user_profile SET weight_kg = ?, ewma_weight_kg = ?, updated_at = ? WHERE id = 1")
            .run(a.scaleWeightKg, ewma, nowIso());
          Object.assign(out, { scaleWeightKg: a.scaleWeightKg, waterShiftKg: round2(shift), dewateredWeightKg: dewatered, ewmaWeightKg: ewma });
          parts.push(`秤重 ${a.scaleWeightKg}kg → 剥离糖原水 ${shift >= 0 ? "+" : ""}${round2(shift)}kg → 去水净重 ${dewatered}kg (EWMA ${ewma}kg)`);
        }

        const set = (col, v) => { if (v != null) q(`UPDATE daily_ledger SET ${col} = ? WHERE date = ?`).run(v, t); };
        set("hrv_ms", a.hrvMs); set("rhr_bpm", a.rhrBpm); set("sleep_hours", a.sleepHours);
        set("deep_sleep_pct", a.deepSleepPct); set("steps", a.steps); set("active_kcal", a.activeKcal);
        if (a.steps != null || a.activeKcal != null) parts.push(`步数 ${a.steps ?? "-"} / 活动 ${a.activeKcal ?? "-"}kcal`);

        // 只有恢复类指标变化时才重评 CNS，避免下午同步步数时把手动设定的档位又熔断掉
        if (a.hrvMs != null || a.rhrBpm != null || a.sleepHours != null) {
          const cur = getRow(t);
          if (cur.hrv_ms != null && cur.rhr_bpm != null && cur.sleep_hours != null) {
            const r = readinessScore({ hrv: cur.hrv_ms, rhr: cur.rhr_bpm, sleep: cur.sleep_hours, hrvBaseline: p.hrv_baseline, rhrBaseline: p.rhr_baseline });
            q("UPDATE daily_ledger SET readiness_score = ?, cns_status = ? WHERE date = ?").run(r.score, r.status, t);
            out.readinessScore = r.score;
            out.cnsStatus = r.status;
            if (r.status === "OVERRIDE_REST") {
              applyDayLevel(t, "low", {
                isTrainingDay: false,
                focus: "⚠️ CNS 疲劳熔断 · 强制低碳恢复日",
                advice: `【生理遥测熔断】晨起 HRV ${cur.hrv_ms}ms / RHR ${cur.rhr_bpm}bpm / 睡眠 ${cur.sleep_hours}h，准备度仅 ${r.score}/100。今日已强制降级为低碳恢复日，练前氮泵与咖啡因自动静默；补充甘氨酸镁与鱼油，保证 8h 睡眠。`
              });
              parts.push(`准备度 ${r.score} → CNS 熔断，强制低碳恢复日`);
            } else if (r.status === "CAUTION") {
              q("UPDATE daily_ledger SET agent_advice = ? WHERE date = ?")
                .run(`【轻度疲劳】晨起准备度 ${r.score}/100。保留${CARB_PRESETS[row.carb_level].label}配额，主项训练容量建议下调 15%，避免力竭组 (RPE ≤ 8.5)。`, t);
              parts.push(`准备度 ${r.score} (CAUTION)`);
            } else {
              parts.push(`准备度 ${r.score} (OPTIMAL)`);
            }
          } else {
            parts.push("恢复指标不全 (需 HRV+RHR+睡眠)，暂不评估准备度");
          }
        }
      });
      out.carbLevel = getRow(t).carb_level;
      return { result: out, summary: parts.length ? parts.join("；") : "晨起打卡：无有效字段" };
    },

    calibrate_metabolic_tdee(a) {
      const t = today();
      const done = q("SELECT COUNT(*) AS n FROM tdee_calibrations WHERE calibrated_date = ? AND applied_delta_kcal != 0").get(t).n;
      if (done && !a.force) {
        throw new ToolError("今天已经校准过一次（同一窗口重复执行会叠加修正）。确需再执行请传 force=true。");
      }
      const cal = computeCalibration(a.windowDays ?? 7);
      if (!cal.ok) return { result: cal, summary: `TDEE 校准跳过：${cal.reason}` };
      tx(() => {
        if (cal.appliedDeltaKcal !== 0) {
          q("UPDATE user_profile SET adaptive_tdee = ?, updated_at = ? WHERE id = 1").run(cal.newTdee, nowIso());
          const row = getRow(t);
          q("UPDATE daily_ledger SET target_tdee = ? WHERE date = ?")
            .run(Math.round(cal.newTdee * CARB_PRESETS[row.carb_level].tdeeFactor), t);
        }
        q(`INSERT INTO tdee_calibrations (calibrated_at, calibrated_date, window_days, expected_delta_kg, actual_ewma_delta_kg,
             raw_drift_kcal, applied_delta_kcal, old_tdee, new_tdee, diagnostic_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(nowIso(), t, cal.windowDays, cal.expectedDeltaKg, cal.actualEwmaDeltaKg, cal.rawDriftKcal,
            cal.appliedDeltaKcal, cal.oldTdee, cal.newTdee, cal.diagnosticNote);
      });
      const d = cal.appliedDeltaKcal;
      return { result: cal, summary: `TDEE 校准：${cal.oldTdee} → ${cal.newTdee} kcal (${d >= 0 ? "+" : ""}${d})` };
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

    log_meal_items(a) {
      const t = today();
      const resolved = a.items.map((it) => {
        if (it.foodId) {
          const food = q("SELECT * FROM foods WHERE id = ?").get(it.foodId);
          if (!food) throw new ToolError(`食材库里没有 ${it.foodId}`);
          const k = it.weightGrams / 100;
          return { name: it.name || food.name, w: it.weightGrams, p: round1(food.p * k), c: round1(food.c * k), f: round1(food.f * k) };
        }
        if (!it.name || it.p == null || it.c == null || it.f == null) {
          throw new ToolError("没有 foodId 的条目必须给 name、p、c、f");
        }
        return { name: it.name, w: it.weightGrams, p: it.p, c: it.c, f: it.f };
      });
      const ids = [];
      tx(() => {
        const ins = q("INSERT INTO meal_logs (id, date, slot, name, weight_g, p, c, f, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const r of resolved) {
          const id = "m_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
          ins.run(id, t, a.mealSlot, r.name, r.w, r.p, r.c, r.f, nowIso());
          ids.push(id);
        }
        recalcIntake(t);
      });
      const row = getRow(t);
      return {
        result: { ok: true, mealIds: ids, items: resolved, todayIntakeKcal: row.intake_kcal },
        summary: `记录【${a.mealSlot}】${resolved.map((r) => `${r.name}(${r.w}g)`).join(" + ")}`
      };
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
      const id = "custom_" + Date.now().toString(36);
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
    const macro = currentPlan();
    const targets = macro.forLevel(row.carb_level);

    const schedule = getSchedule();
    const ti = weekdayIndex(t);

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
      demo, date: t, todayIndex: ti,
      profile: { ...profile, bmr: mifflinBmr({ ...profile, weightKg: bw }), body_weight_kg: bw },
      today: { ...row, label: CARB_PRESETS[row.carb_level].label },
      targets,
      weeklyBase: macro.base,
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
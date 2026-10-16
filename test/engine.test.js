import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, macroPlan, mifflinBmr, readinessScore, waterShiftKg } from "../engine.js";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nutrition-tracker-mcp-"));
  return path.join(dir, "t.db");
}

// 可控时钟：从 2026-10-12 (周一) 上海时间早上 7 点开始
function clock(start = "2026-10-12T07:00:00+08:00") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), nextDay: () => { t += 86400000; } };
}

test("Mifflin / 糖原水 / 准备度 纯函数", () => {
  assert.equal(mifflinBmr({ gender: "male", age: 30, height_cm: 175, weightKg: 75 }), 1699);
  assert.equal(mifflinBmr({ gender: "female", age: 30, height_cm: 175, weightKg: 75 }), 1533);
  assert.equal(waterShiftKg(470), 0.44);
  assert.equal(readinessScore({ hrv: 41, rhr: 63, sleep: 5.1, hrvBaseline: 68, rhrBaseline: 54 }).status, "OVERRIDE_REST");
  assert.equal(readinessScore({ hrv: 72, rhr: 53, sleep: 7.8, hrvBaseline: 68, rhrBaseline: 54 }).status, "OPTIMAL");
});

test("今天按周模板生成；本地日期不受 UTC 影响", () => {
  const c = clock("2026-10-14T06:30:00+08:00"); // UTC 仍是 10-13
  const e = createEngine(tmpDb(), { now: c.now });
  const s = e.buildSnapshot();
  assert.equal(s.date, "2026-10-14");
  assert.equal(s.todayIndex, 2); // 周三
  assert.equal(s.today.carb_level, "high");
  assert.equal(s.forecast.length, 7);
});

test("膳食：食材库换算、删除后汇总回落", () => {
  const e = createEngine(tmpDb(), { now: clock().now });
  const r = e.execute("log_meal_items", { mealSlot: "午餐", items: [{ foodId: "f1", weightGrams: 200 }, { name: "米饭", weightGrams: 300, p: 7.8, c: 84, f: 0.9 }] });
  assert.deepEqual(r.items[0], { name: "鸡胸肉 (生重)", w: 200, p: 48, c: 0, f: 4 });
  let s = e.buildSnapshot();
  assert.equal(s.today.intake_kcal, Math.round((48 + 7.8) * 4 + 84 * 4 + 4.9 * 9));
  e.execute("delete_meal_item", { mealId: r.mealIds[0] });
  s = e.buildSnapshot();
  assert.equal(s.meals.length, 1);
  assert.equal(s.today.p_g, 7.8);
  assert.throws(() => e.execute("log_meal_items", { mealSlot: "午餐", items: [{ name: "x", weightGrams: 10 }] }), /必须给/);
  assert.throws(() => e.execute("log_meal_items", { mealSlot: "夜宵", items: [] }), /参数错误/);
});

test("CNS 熔断强制低碳；只同步步数不会再触发重评", () => {
  const e = createEngine(tmpDb(), { now: clock("2026-10-14T07:00:00+08:00").now });
  const r = e.execute("log_morning_checkin", { hrvMs: 41, rhrBpm: 63, sleepHours: 5.1 });
  assert.equal(r.cnsStatus, "OVERRIDE_REST");
  assert.equal(r.carbLevel, "low");
  let s = e.buildSnapshot();
  assert.ok(s.supplements.find((x) => x.id === "caffeine").muted);
  e.execute("set_day_context", { carbLevel: "medium" });
  e.execute("log_morning_checkin", { steps: 8000 });
  s = e.buildSnapshot();
  assert.equal(s.today.carb_level, "medium");
  assert.equal(s.today.steps, 8000);
});

test("秤重剥离糖原水 + EWMA 跨天连续；校准一天一次", () => {
  const c = clock();
  const e = createEngine(tmpDb(), { now: c.now });
  const weights = [75.0, 74.6, 74.9, 74.5, 74.8, 74.4, 74.7, 74.5];
  for (const w of weights) {
    e.execute("log_morning_checkin", { scaleWeightKg: w });
    e.execute("log_meal_items", { mealSlot: "午餐", items: [{ name: "整天", weightGrams: 1, p: 150, c: 200, f: 60 }] });
    c.nextDay();
  }
  const s = e.buildSnapshot();
  const hist = s.history.filter((r) => r.ewma_weight_kg != null);
  assert.equal(hist.length, weights.length);
  // EWMA 应比原始秤重平滑
  const range = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(range(hist.map((r) => r.ewma_weight_kg)) < range(weights));

  // 今天还没秤重，窗口仍取到有秤重的天
  e.execute("log_morning_checkin", { scaleWeightKg: 74.4 });
  const cal = e.execute("calibrate_metabolic_tdee", { windowDays: 7 });
  assert.equal(cal.ok, true);
  assert.ok(Math.abs(cal.appliedDeltaKcal) <= 120);
  if (cal.appliedDeltaKcal !== 0) {
    assert.throws(() => e.execute("calibrate_metabolic_tdee", {}), /force=true/);
    e.execute("calibrate_metabolic_tdee", { force: true });
  }
});

test("set_profile 保留校准偏移；周模板改到今天会同步今日档位", () => {
  const e = createEngine(tmpDb(), { now: clock("2026-10-14T07:00:00+08:00").now });
  let p = e.buildSnapshot().profile;
  assert.equal(p.formula_tdee, Math.round(1699 * 1.55));
  e.execute("set_profile", { activityFactor: 1.375, age: 35 });
  p = e.buildSnapshot().profile;
  assert.equal(p.formula_tdee, Math.round(mifflinBmr({ gender: "male", age: 35, height_cm: 175, weightKg: 75 }) * 1.375));
  assert.equal(p.adaptive_tdee, p.formula_tdee);

  e.execute("update_weekly_schedule", { dayIndex: 2, plan: "low", focus: "改成休息" });
  const s = e.buildSnapshot();
  assert.equal(s.today.carb_level, "low");
  assert.equal(s.today.workout_focus, "改成休息");
});

test("目标 + 配比 + 碳水循环融合：周均等于基准，蛋白质恒定", () => {
  const week = ["medium", "low", "high", "low", "high", "medium", "low"];
  const m = macroPlan({ adaptiveTdee: 2600, goalKcal: -500, ratioP: 30, ratioC: 40, ratioF: 30 }, week);
  assert.equal(m.base.kcal, 2100);
  const days = week.map((lv) => m.forLevel(lv));
  const avg = (k) => days.reduce((s, d) => s + d[k], 0) / 7;
  assert.ok(Math.abs(avg("c") - m.base.c) < 1);
  assert.ok(Math.abs(avg("f") - m.base.f) < 1);
  assert.ok(Math.abs(avg("kcal") - m.base.kcal) < 15); // 只差取整
  assert.ok(new Set(days.map((d) => d.p)).size === 1);
  assert.ok(m.forLevel("high").c > m.forLevel("medium").c && m.forLevel("medium").c > m.forLevel("low").c);
  assert.ok(m.forLevel("high").f < m.forLevel("low").f);
  // 整周同一档位 → 每天都等于基准
  const flat = macroPlan({ adaptiveTdee: 2600, goalKcal: 0, ratioP: 30, ratioC: 40, ratioF: 30 }, Array(7).fill("high"));
  assert.equal(flat.forLevel("high").c, flat.base.c);
});

test("set_profile 设置目标/配比，和不为 100 拒绝", () => {
  const e = createEngine(tmpDb(), { now: clock("2026-10-14T07:00:00+08:00").now });
  assert.throws(() => e.execute("set_profile", { ratioP: 40 }), /之和必须为 100/);
  e.execute("set_profile", { goalKcal: -500, ratioP: 40, ratioC: 30, ratioF: 30 });
  const s = e.buildSnapshot();
  assert.equal(s.weeklyBase.kcal, s.profile.adaptive_tdee - 500);
  assert.equal(s.targets.p, Math.round((s.weeklyBase.kcal * 0.4) / 4));
  assert.equal(s.forecast[0].intakeKcal, s.targets.kcal);
});

test("补剂打卡按天隔离", () => {
  const c = clock();
  const e = createEngine(tmpDb(), { now: c.now });
  e.execute("update_supplement_stack", { supplementId: "creatine", taken: true, customDose: "10g" });
  let x = e.buildSnapshot().supplements.find((s) => s.id === "creatine");
  assert.equal(x.taken, true);
  assert.equal(x.dose, "10g");
  c.nextDay();
  x = e.buildSnapshot().supplements.find((s) => s.id === "creatine");
  assert.equal(x.taken, false);
  assert.equal(x.dose, "5g");
});

test("demo 种子可加载并给出校准预览", () => {
  const e = createEngine(tmpDb(), { demo: true });
  const s = e.buildSnapshot();
  assert.ok(s.history.length >= 7);
  assert.equal(s.meals.length, 2);
  assert.equal(s.calibrationPreview.ok, true);
});
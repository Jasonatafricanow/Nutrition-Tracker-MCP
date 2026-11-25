/**
 * Household food inventory: decision support for the Agent, NOT a precise
 * warehouse system. Quantities are open-ended user/source text ("600g",
 * "约4根", "一小把"); a comparable same-unit amount can be deducted approximately.
 *
 * Boundaries (see docs/AGENT_CONTRACT_ZH.md):
 * - The Agent understands receipts/language/menus; this module only stores state.
 * - A suggested or agreed menu NEVER deducts stock. Only explicit user-reported
 *   purchase/consume/discard/correction writes here.
 * - User statements override Agent inference. Shelf-life output is an estimate
 *   for prioritization, never a food-safety verdict.
 * - Nutrition intake stays in the existing engine ledger; this module never
 *   writes meal logs.
 *
 * Storage mirrors household.js: one small shared SQLite file, idempotent
 * request receipts, CREATE TABLE IF NOT EXISTS (no migration of existing data).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const INVENTORY_OPERATIONS = Object.freeze(['purchase', 'consume', 'discard', 'adjust', 'update_condition']);
export const INVENTORY_VIEWS = Object.freeze(['current', 'item', 'expiring', 'availability']);
export const STORAGE_MODES = Object.freeze(['fridge', 'freezer', 'room', 'unknown']);
const STORAGE_LABELS = { fridge: '冷藏', freezer: '冷冻', room: '常温', unknown: '储存方式未知' };
const SOURCES = Object.freeze(['receipt', 'user_text', 'agent_inference']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FOOD_SYNONYMS = new Map([
  ['青瓜', '黄瓜'], ['西红柿', '番茄'], ['马铃薯', '土豆']
]);

function foodKey(name) {
  const key = name.trim().toLowerCase();
  return FOOD_SYNONYMS.get(key) ?? key;
}

const dayInZone = (d, zone) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const part = x => parts.find(p => p.type === x).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const shiftDay = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
const CHINESE_DIGITS = '零一二三四五六七八九';
const COMMON_MULTI_CHARACTER_UNITS = new Set(['公斤', '千克', '毫克', '公克', '毫升', '公升', '盎司', '汤匙', '茶匙']);

function parseComparableQuantity(description) {
  const match = description?.match(/^(?:实际是\s*)?(?:约\s*(?:剩\s*)?|剩\s*)?(\d{1,9}(?:\.\d{1,3})?|半|[一二两三四五六七八九十]{1,3})\s*([\p{L}]+)$/u);
  if (!match) return null;
  const [, number, unit] = match;
  // Open text stays valid even when its number or unit is too ambiguous to infer.
  const recognizableUnit = /^(?:[a-zA-Z]+|\p{Script=Han})$/u.test(unit) || COMMON_MULTI_CHARACTER_UNITS.has(unit);
  if (!recognizableUnit || (unit.length === 1 && '半多余来左右不到以上约一二两三四五六七八九十百千万零'.includes(unit))) return null;
  let value = Number(number);
  if (number === '半') value = 0.5;
  else if (number === '两') value = 2;
  else if (CHINESE_DIGITS.includes(number) && number.length === 1) value = CHINESE_DIGITS.indexOf(number);
  else if (/^[二三四五六七八九]?十[一二三四五六七八九]?$/.test(number)) {
    const [tens, ones] = number.split('十');
    value = (tens ? CHINESE_DIGITS.indexOf(tens) : 1) * 10 + (ones ? CHINESE_DIGITS.indexOf(ones) : 0);
  }
  return Number.isFinite(value) ? { amount: Math.round(value * 1000), unit } : null;
}

function approximateRemainder(descriptions, usedQuantity) {
  const used = parseComparableQuantity(usedQuantity);
  if (!used || used.amount <= 0) return null;
  const candidates = new Set(descriptions.map(parseComparableQuantity)
    .filter(quantity => quantity?.unit === used.unit).map(quantity => quantity.amount));
  if (candidates.size !== 1) return null;
  const remaining = candidates.values().next().value - used.amount;
  if (remaining <= 0) return null;
  return `约${remaining === 500 && /^\p{Script=Han}$/u.test(used.unit) ? '半' : remaining / 1000}${used.unit}`;
}

/**
 * Common-food shelf-life REFERENCE rules (rough planning estimates only).
 * days: typical usable days per storage mode from purchase; null = not applicable.
 * openedFactor/cutFactor shorten the estimate after opening/cutting.
 * Not a safety standard; packaged label dates always take precedence.
 */
export const SHELF_LIFE_RULES = Object.freeze([
  { name: '黄瓜', aliases: ['青瓜'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 7, freezer: null, room: 3 }, openedFactor: 1, cutFactor: 0.3 },
  { name: '番茄', aliases: ['西红柿'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 7, freezer: null, room: 4 }, openedFactor: 1, cutFactor: 0.3 },
  { name: '菠菜', aliases: [], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 3, freezer: 30, room: 1 }, openedFactor: 0.5, cutFactor: 0.5 },
  { name: '生菜', aliases: ['油麦菜'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 5, freezer: null, room: 1 }, openedFactor: 0.5, cutFactor: 0.4 },
  { name: '青菜', aliases: ['小油菜', '上海青', '油菜'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 4, freezer: null, room: 1 }, openedFactor: 0.5, cutFactor: 0.5 },
  { name: '白菜', aliases: ['大白菜'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 14, freezer: null, room: 5 }, openedFactor: 0.5, cutFactor: 0.3 },
  { name: '西兰花', aliases: ['花菜', '菜花'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 7, freezer: 30, room: 2 }, openedFactor: 0.5, cutFactor: 0.4 },
  { name: '胡萝卜', aliases: ['红萝卜'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 21, freezer: 60, room: 7 }, openedFactor: 0.5, cutFactor: 0.3 },
  { name: '土豆', aliases: ['马铃薯'], category: '蔬菜', defaultStorage: 'room', days: { fridge: 21, freezer: null, room: 30 }, openedFactor: 1, cutFactor: 0.2 },
  { name: '洋葱', aliases: [], category: '蔬菜', defaultStorage: 'room', days: { fridge: 30, freezer: null, room: 30 }, openedFactor: 1, cutFactor: 0.2 },
  { name: '葱', aliases: ['小葱', '香葱'], category: '蔬菜', defaultStorage: 'fridge', days: { fridge: 7, freezer: 30, room: 2 }, openedFactor: 1, cutFactor: 0.3 },
  { name: '姜', aliases: ['生姜'], category: '蔬菜', defaultStorage: 'room', days: { fridge: 21, freezer: 60, room: 14 }, openedFactor: 1, cutFactor: 0.3 },
  { name: '蒜', aliases: ['大蒜', '蒜头'], category: '蔬菜', defaultStorage: 'room', days: { fridge: 30, freezer: null, room: 30 }, openedFactor: 1, cutFactor: 0.3 },
  { name: '鸡蛋', aliases: ['土鸡蛋'], category: '蛋奶', defaultStorage: 'fridge', days: { fridge: 30, freezer: null, room: 10 }, openedFactor: 1, cutFactor: 0.1 },
  { name: '猪肉', aliases: ['五花肉', '里脊', '猪肉馅'], category: '肉类', defaultStorage: 'fridge', days: { fridge: 3, freezer: 90, room: 0 }, openedFactor: 0.7, cutFactor: 0.7 },
  { name: '牛肉', aliases: ['牛腩', '牛排', '牛肉馅'], category: '肉类', defaultStorage: 'fridge', days: { fridge: 3, freezer: 120, room: 0 }, openedFactor: 0.7, cutFactor: 0.7 },
  { name: '鸡肉', aliases: ['鸡胸', '鸡胸肉', '鸡腿', '鸡翅', '整鸡'], category: '肉类', defaultStorage: 'fridge', days: { fridge: 2, freezer: 120, room: 0 }, openedFactor: 0.7, cutFactor: 0.7 },
  { name: '鱼', aliases: ['鲈鱼', '鲫鱼', '三文鱼', '鲜鱼'], category: '水产', defaultStorage: 'fridge', days: { fridge: 1, freezer: 60, room: 0 }, openedFactor: 0.7, cutFactor: 0.7 },
  { name: '虾', aliases: ['鲜虾', '基围虾', '虾仁'], category: '水产', defaultStorage: 'fridge', days: { fridge: 1, freezer: 60, room: 0 }, openedFactor: 0.7, cutFactor: 0.7 },
  { name: '豆腐', aliases: ['嫩豆腐', '老豆腐'], category: '豆制品', defaultStorage: 'fridge', days: { fridge: 3, freezer: null, room: 0 }, openedFactor: 0.4, cutFactor: 0.5 },
  { name: '牛奶', aliases: ['鲜奶', '鲜牛奶'], category: '蛋奶', defaultStorage: 'fridge', days: { fridge: 5, freezer: null, room: 0 }, openedFactor: 0.4, cutFactor: 1 },
  { name: '酸奶', aliases: [], category: '蛋奶', defaultStorage: 'fridge', days: { fridge: 14, freezer: null, room: 0 }, openedFactor: 0.3, cutFactor: 1 },
  { name: '米饭', aliases: ['熟米饭', '剩米饭'], category: '熟食', defaultStorage: 'fridge', days: { fridge: 2, freezer: 30, room: 0 }, openedFactor: 1, cutFactor: 1 },
  { name: '苹果', aliases: [], category: '水果', defaultStorage: 'fridge', days: { fridge: 21, freezer: null, room: 7 }, openedFactor: 1, cutFactor: 0.2 },
  { name: '香蕉', aliases: [], category: '水果', defaultStorage: 'room', days: { fridge: 5, freezer: null, room: 5 }, openedFactor: 1, cutFactor: 0.2 },
  { name: '橙子', aliases: ['橘子', '柑橘'], category: '水果', defaultStorage: 'fridge', days: { fridge: 14, freezer: null, room: 7 }, openedFactor: 1, cutFactor: 0.2 },
  { name: '面包', aliases: ['吐司'], category: '主食', defaultStorage: 'room', days: { fridge: 7, freezer: 30, room: 4 }, openedFactor: 0.6, cutFactor: 1 },
  { name: '大米', aliases: ['米', '面粉'], category: '干货', defaultStorage: 'room', days: { fridge: 180, freezer: null, room: 180 }, openedFactor: 0.7, cutFactor: 1 },
  { name: '食用油', aliases: ['菜籽油', '花生油', '橄榄油'], category: '调味', defaultStorage: 'room', days: { fridge: 270, freezer: null, room: 270 }, openedFactor: 0.4, cutFactor: 1 },
  { name: '酱油', aliases: ['生抽', '老抽', '醋'], category: '调味', defaultStorage: 'room', days: { fridge: 365, freezer: null, room: 365 }, openedFactor: 0.8, cutFactor: 1 }
]);

/** Use reference rules only for known names, not dishes containing an ingredient. */
export function matchShelfRule(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  return SHELF_LIFE_RULES.find(rule => rule.name === n || rule.aliases.includes(n)) ?? null;
}

const FRESHNESS_LABELS = { ok: '正常', use_soon: '建议近期使用', check: '建议优先检查', unknown: '状态未知' };
const ESTIMATE_NOTE = '仅供安排使用顺序，不是食品安全期限';

/** Estimate a use-by DATE (never hours) and a coarse prioritization status. */
export function estimateFreshness({ name, purchasedAt, storage, opened, cut, labelExpiryDate }, today) {
  if (labelExpiryDate) {
    const left = daysBetween(today, labelExpiryDate);
    const status = left < 0 ? 'check' : left <= 1 ? 'use_soon' : 'ok';
    return { status, label: FRESHNESS_LABELS[status], useByDate: labelExpiryDate, useByBasis: 'label', daysLeft: left,
      note: left < 0 ? '包装标注日期已过，建议优先检查' : '按包装标注日期判断' };
  }
  const rule = matchShelfRule(name);
  const base = rule?.days?.[storage];
  if (!rule || base == null) {
    return { status: 'unknown', label: FRESHNESS_LABELS.unknown, useByDate: null, useByBasis: null, daysLeft: null,
      note: rule ? `「${rule.name}」不适合${STORAGE_LABELS[storage] ?? storage}储存或未提供储存方式，无法估算` : '暂无该食材的保质期参考规则' };
  }
  // Multiply all factors first, then round once: per-step ceiling would undo the
  // shrink (ceil(3*0.7)=3), and float noise (2.0999999999999996) must not add a day.
  let factor = 1;
  if (opened) factor *= rule.openedFactor;
  if (cut) factor *= rule.cutFactor;
  const days = Math.max(0, Math.ceil(Math.round(base * factor * 100) / 100));
  const useByDate = shiftDay(purchasedAt, days);
  const left = daysBetween(today, useByDate);
  const status = left <= 0 ? 'check' : left <= 2 ? 'use_soon' : 'ok';
  return { status, label: FRESHNESS_LABELS[status], useByDate, useByBasis: 'estimate', daysLeft: left,
    note: `按常见储存条件估算（${rule.name}类，${STORAGE_LABELS[storage]}${opened ? '，已开封' : ''}${cut ? '，已切割' : ''}），${ESTIMATE_NOTE}` };
}

function estimateAfterStorageChanges(batch, initial, changes, today) {
  if (batch.labelExpiryDate || !changes.some(change => change.storage != null)) return estimateFreshness(batch, today);

  let condition = { name: batch.name, purchasedAt: batch.purchasedAt, ...initial };
  let limit = null;
  let daysBeforeFreezing = null;
  let frozenPriority = null;
  let insufficientHistory = condition.storage == null;
  const estimate = date => {
    const fresh = estimateFreshness(condition, date);
    if (limit && (limit <= date || (fresh.useByDate && limit < fresh.useByDate))) {
      const daysLeft = daysBetween(date, limit);
      const status = daysLeft <= 0 ? 'check' : daysLeft <= 2 ? 'use_soon' : 'ok';
      return { ...fresh, useByDate: limit, useByBasis: 'estimate', daysLeft, status, label: FRESHNESS_LABELS[status] };
    }
    return fresh;
  };
  for (const change of changes) {
    if (change.storage != null && change.storage !== condition.storage) {
      const before = estimate(change.date);
      const wasFrozen = condition.storage === 'freezer';
      if (change.storage === 'freezer') {
        daysBeforeFreezing = before.daysLeft;
        frozenPriority = before.status;
        limit = before.status === 'check' ? before.useByDate : null;
      } else if (wasFrozen) {
        insufficientHistory ||= daysBeforeFreezing == null;
        limit = before.status === 'check' ? before.useByDate
          : daysBeforeFreezing == null ? null : shiftDay(change.date, daysBeforeFreezing);
        frozenPriority = null;
      } else {
        limit = before.useByDate;
      }
      insufficientHistory ||= before.status === 'unknown';
      condition = { ...condition, storage: change.storage, purchasedAt: change.date };
    }
    condition.opened = change.opened ?? condition.opened;
    condition.cut = change.cut ?? condition.cut;
  }
  // Current flags may also have been explicitly corrected by the user.
  condition.opened = batch.opened;
  condition.cut = batch.cut;
  const fresh = estimate(today);
  if (fresh.status === 'check') return { ...fresh, note: `结合储存变化和此前期限，建议优先检查，${ESTIMATE_NOTE}` };
  if (insufficientHistory || fresh.status === 'unknown') {
    return { status: 'unknown', label: FRESHNESS_LABELS.unknown, useByDate: null, useByBasis: null, daysLeft: null,
      note: `储存变化后缺少可靠的期限依据，${ESTIMATE_NOTE}` };
  }
  if (fresh.status === 'ok' && frozenPriority === 'use_soon') {
    return { ...fresh, status: 'use_soon', label: FRESHNESS_LABELS.use_soon, priorStorageDaysLeft: daysBeforeFreezing,
      note: `冷冻前已临近估算期限，保留近期使用优先级，${ESTIMATE_NOTE}` };
  }
  return { ...fresh, note: `结合储存变化日期和此前期限估算，${ESTIMATE_NOTE}` };
}

const text = (v, field, max = 200) => {
  if (v == null) return null;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw Error(`${field} 须为 1–${max} 字的文本`);
  return v.trim();
};
const validDate = (v, field) => {
  if (v == null) return null;
  const date = typeof v === 'string' && DATE_RE.test(v) ? new Date(`${v}T12:00:00Z`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== v) {
    throw Error(`${field} 须为有效的 YYYY-MM-DD 日期`);
  }
  return v;
};

export function createInventory({ dbPath, now = () => new Date(), timeZone = process.env.NUTRITION_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  if (!dbPath || !path.isAbsolute(dbPath)) throw Error('inventory dbPath must be absolute');
  new Intl.DateTimeFormat('en-US', { timeZone });
  mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, aliases_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_batches (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES inventory_items(id),
      purchased_at TEXT NOT NULL, original_quantity TEXT, remaining_quantity TEXT,
      remaining_updated_at TEXT NOT NULL, quantity_notes_json TEXT NOT NULL DEFAULT '[]',
      storage TEXT NOT NULL DEFAULT 'unknown', opened INTEGER NOT NULL DEFAULT 0,
      cut INTEGER NOT NULL DEFAULT 0, label_expiry_date TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','used_up','discarded')),
      source TEXT NOT NULL DEFAULT 'user_text', source_ref TEXT, note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inventory_batch_item ON inventory_batches(item_id, status);
    CREATE TABLE IF NOT EXISTS inventory_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, operation TEXT NOT NULL,
      item_id TEXT, batch_id TEXT, item_name TEXT NOT NULL, detail_json TEXT NOT NULL,
      request_id TEXT, source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_request_receipts (
      request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );`);
  const q = sql => db.prepare(sql);
  const today = () => dayInZone(now(), timeZone);
  const stamp = () => now().toISOString();
  const hash = obj => createHash('sha256').update(JSON.stringify(obj)).digest('hex');

  const parseAliases = row => JSON.parse(row.aliases_json);
  const findItem = name => {
    if (!name) return null;
    const exact = q('SELECT * FROM inventory_items WHERE name COLLATE NOCASE=?').get(name);
    if (exact) return exact;
    const key = foodKey(name);
    const matches = q('SELECT * FROM inventory_items').all()
      .filter(row => foodKey(row.name) === key || parseAliases(row).some(alias => foodKey(alias) === key));
    if (matches.length > 1) throw Error(`「${name}」对应多个食材，请使用完整库存名称或 batchId`);
    return matches[0] ?? null;
  };
  const activeBatches = itemId => q("SELECT * FROM inventory_batches WHERE item_id=? AND status='active' ORDER BY purchased_at, created_at, rowid").all(itemId);
  const batchById = id => q('SELECT * FROM inventory_batches WHERE id=?').get(id);
  const itemById = id => q('SELECT * FROM inventory_items WHERE id=?').get(id);

  function conditionHistory(batch) {
    const rows = q(`SELECT at,operation,detail_json FROM inventory_changes
      WHERE batch_id=? AND operation IN ('purchase', 'update_condition') ORDER BY id`).all(batch.id);
    const initial = rows[0]?.operation === 'purchase' ? JSON.parse(rows.shift().detail_json) : {};
    const changes = rows.map(row => {
      const detail = JSON.parse(row.detail_json);
      return { date: detail.storageChangedAt ?? dayInZone(new Date(row.at), timeZone),
        storage: detail.storage, opened: detail.opened, cut: detail.cut };
    }).sort((a, b) => a.date.localeCompare(b.date));
    const storage = initial.storage ?? (changes.some(change => change.storage != null) ? null : batch.storage);
    return { initial: { storage,
      opened: initial.opened ?? (!changes.some(change => change.opened != null) && !!batch.opened),
      cut: initial.cut ?? (!changes.some(change => change.cut != null) && !!batch.cut) }, changes };
  }

  const currentSupplements = (batch, notes) => notes
    .filter(note => note.kind === 'supplement' && (note.current ?? note.at >= batch.remaining_updated_at))
    .map(note => note.text);

  const batchView = (batch, item) => {
    const notes = JSON.parse(batch.quantity_notes_json);
    // A new remainder retires older supplements. Legacy notes use timestamps.
    const supplements = currentSupplements(batch, notes);
    const remaining = batch.status === 'active'
      ? [batch.remaining_quantity, ...supplements].filter(Boolean).join(' / ') || '数量未说明'
      : null;
    const { initial, changes } = conditionHistory(batch);
    const storageHistory = [{ date: batch.purchased_at, storage: initial.storage ?? 'unknown' }];
    for (const { date, storage } of changes) {
      if (storage != null && storage !== storageHistory.at(-1).storage) storageHistory.push({ date, storage });
    }
    const freshness = estimateAfterStorageChanges({ name: item.name, purchasedAt: batch.purchased_at, storage: batch.storage,
      opened: !!batch.opened, cut: !!batch.cut, labelExpiryDate: batch.label_expiry_date }, initial, changes, today());
    return { batchId: batch.id, purchasedAt: batch.purchased_at, originalQuantity: batch.original_quantity,
      quantityNotes: notes.map(x => x.text), quantitySupplements: notes.filter(note => note.kind === 'supplement').map(note => note.text),
      remainingQuantity: remaining, storage: batch.storage, storageHistory,
      storageLabel: STORAGE_LABELS[batch.storage], opened: !!batch.opened, cut: !!batch.cut,
      labelExpiryDate: batch.label_expiry_date, status: batch.status, source: batch.source,
      sourceRef: batch.source_ref, note: batch.note, freshness };
  };
  const itemView = (item, { includeBatches = false } = {}) => {
    const batches = activeBatches(item.id);
    const all = includeBatches ? q('SELECT * FROM inventory_batches WHERE item_id=? ORDER BY purchased_at, created_at, rowid').all(item.id) : batches;
    const views = all.map(b => batchView(b, item));
    const activeViews = views.filter(v => v.status === 'active');
    const rank = { check: 0, use_soon: 1, unknown: 2, ok: 3 };
    const worst = activeViews.toSorted((a, b) => rank[a.freshness.status] - rank[b.freshness.status])[0]?.freshness ?? null;
    const last = batches.length ? null : q(`SELECT b.status FROM inventory_changes c
      JOIN inventory_batches b ON b.id=c.batch_id WHERE c.item_id=? ORDER BY c.id DESC LIMIT 1`).get(item.id);
    const state = batches.length ? 'available' : (last?.status ?? 'used_up');
    const remainings = activeViews.map(v => v.remainingQuantity).filter(Boolean);
    const storageLabels = [...new Set(activeViews.map(v => v.storageLabel))];
    const rule = matchShelfRule(item.name);
    return { itemId: item.id, name: item.name, aliases: parseAliases(item), category: rule?.category ?? null,
      state, remaining: remainings, freshness: worst, batchCount: batches.length,
      summary: batches.length
        ? `${item.name}：${remainings.join('；') || '数量未说明'}（${storageLabels.join(' / ')}，${worst?.label ?? '状态未知'}）`
        : `${item.name}：已${state === 'discarded' ? '丢弃' : '用完'}`,
      ...(includeBatches ? { batches: views } : {}) };
  };
  const journal = (operation, item, batch, detail, requestId, source) =>
    q('INSERT INTO inventory_changes(at,operation,item_id,batch_id,item_name,detail_json,request_id,source) VALUES(?,?,?,?,?,?,?,?)')
      .run(stamp(), operation, item?.id ?? null, batch?.id ?? null, item?.name ?? detail.name ?? '', JSON.stringify(detail), requestId ?? null, source);

  const resolveBatch = (args, item, { requireActive = true } = {}) => {
    if (args.batchId) {
      const b = batchById(args.batchId);
      if (!b || (args.name != null && b.item_id !== item?.id)) throw Error('batchId 不存在或不属于该食材');
      if (requireActive && b.status !== 'active') throw Error(`该批次已${b.status === 'discarded' ? '丢弃' : '用完'}，如需修正请用 adjust 并说明`);
      return { batch: b, target: item ?? itemById(b.item_id), selection: 'explicit' };
    }
    if (!item) throw Error(`库存中没有「${args.name ?? ''}」；请先入库或核对名称`);
    const batches = activeBatches(item.id);
    if (!batches.length) throw Error(`「${item.name}」当前没有在库批次；请先入库或核对名称`);
    return { batch: batches[0], target: item, selection: batches.length > 1 ? 'oldest_active' : 'single_active' };
  };
  const saveBatch = b => q(`UPDATE inventory_batches SET remaining_quantity=?, remaining_updated_at=?, quantity_notes_json=?,
      storage=?, opened=?, cut=?, label_expiry_date=?, status=?, note=?, updated_at=? WHERE id=?`)
      .run(b.remaining_quantity, b.remaining_updated_at, b.quantity_notes_json, b.storage, b.opened, b.cut,
        b.label_expiry_date, b.status, b.note, stamp(), b.id);
  const addNote = (b, kind, noteText) => {
    const notes = JSON.parse(b.quantity_notes_json);
    notes.push({ text: noteText, kind, at: stamp(), ...(kind === 'supplement' ? { current: true } : {}) });
    b.quantity_notes_json = JSON.stringify(notes);
  };
  const setRemaining = (b, value) => {
    const notes = JSON.parse(b.quantity_notes_json);
    for (const note of notes) {
      if (note.kind === 'supplement') note.current = false;
    }
    b.quantity_notes_json = JSON.stringify(notes);
    b.remaining_quantity = value;
    b.remaining_updated_at = stamp();
  };

  function purchase(args) {
    const name = text(args.name, 'name', 80);
    if (!name) throw Error('purchase 需要食材名称');
    const quantity = text(args.quantity, 'quantity');
    const quantityNote = text(args.quantityNote, 'quantityNote');
    const purchasedAt = validDate(args.purchasedAt, 'purchasedAt') ?? today();
    if (daysBetween(today(), purchasedAt) > 1) throw Error('purchasedAt 不能晚于明天');
    let item = findItem(name);
    const rule = matchShelfRule(item?.name ?? name);
    let storage = args.storage ?? null;
    if (storage != null && !STORAGE_MODES.includes(storage)) throw Error('storage 须为 fridge/freezer/room/unknown');
    const storageAssumed = storage == null;
    storage = storage ?? rule?.defaultStorage ?? 'unknown';
    const source = args.source ?? 'user_text';
    if (!SOURCES.includes(source)) throw Error('source 须为 receipt/user_text/agent_inference');
    if (!item) {
      const id = randomUUID();
      const aliases = Array.isArray(args.aliases) ? args.aliases.map(a => text(a, 'aliases', 80)).filter(Boolean) : [];
      q('INSERT INTO inventory_items(id,name,aliases_json,created_at) VALUES(?,?,?,?)').run(id, name, JSON.stringify(aliases), stamp());
      item = itemById(id);
    }
    const batchId = randomUUID();
    const at = stamp();
    const notes = quantityNote ? [{ text: quantityNote, kind: 'supplement', at, current: true }] : [];
    const labelExpiryDate = validDate(args.labelExpiryDate, 'labelExpiryDate');
    const sourceRef = text(args.sourceRef, 'sourceRef', 120);
    const note = text(args.note, 'note', 500);
    q(`INSERT INTO inventory_batches(id,item_id,purchased_at,original_quantity,remaining_quantity,remaining_updated_at,
       quantity_notes_json,storage,opened,cut,label_expiry_date,status,source,source_ref,note,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(batchId, item.id, purchasedAt, quantity, quantity, at, JSON.stringify(notes), storage,
        args.opened ? 1 : 0, args.cut ? 1 : 0, labelExpiryDate, 'active', source, sourceRef, note, at, at);
    const batch = batchById(batchId);
    journal('purchase', item, batch, { quantity, quantityNote, purchasedAt, storage, storageAssumed,
      opened: !!args.opened, cut: !!args.cut, labelExpiryDate, source, sourceRef, note }, args.requestId, source);
    return { ok: true, operation: 'purchase', item: itemView(item), batch: batchView(batch, item),
      ...(storageAssumed ? { storageAssumed: true } : {}) };
  }

  function consumeOrDiscard(args, operation) {
    const item = findItem(text(args.name, 'name', 80) ?? '');
    const { batch, target, selection } = resolveBatch(args, item);
    const usedQuantity = text(args.usedQuantity, 'usedQuantity');
    const remainingQuantity = text(args.remainingQuantity, 'remainingQuantity');
    let remainingQuantityBasis;
    if (operation === 'consume') {
      if (remainingQuantity != null) {
        setRemaining(batch, remainingQuantity);
        remainingQuantityBasis = 'reported';
      } else if (args.usedAll) {
        batch.status = 'used_up';
        setRemaining(batch, null);
        remainingQuantityBasis = 'reported';
      } else {
        const descriptions = [batch.remaining_quantity, ...currentSupplements(batch, JSON.parse(batch.quantity_notes_json))];
        const inferred = approximateRemainder(descriptions, usedQuantity);
        setRemaining(batch, inferred ?? (usedQuantity ? `剩余不明（已用${usedQuantity}）` : '剩余不明（已使用部分）'));
        remainingQuantityBasis = inferred ? 'inferred' : 'unknown';
      }
      if (usedQuantity) addNote(batch, 'consume', `用了${usedQuantity}`);
    } else {
      batch.status = 'discarded';
      setRemaining(batch, null);
      if (args.reason) addNote(batch, 'discard', `丢弃：${text(args.reason, 'reason', 200)}`);
    }
    if (args.note) batch.note = text(args.note, 'note', 500);
    saveBatch(batch);
    const allocation = operation === 'consume' ? { batchSelection: selection, batchSelectionInferred: selection !== 'explicit', remainingQuantityBasis } : {};
    journal(operation, target, batch, { usedQuantity, remainingQuantity, remainingAfter: batch.remaining_quantity, usedAll: batch.status === 'used_up',
      ...allocation,
      reason: args.reason ?? null, note: args.note ?? null }, args.requestId, args.source ?? 'user_text');
    return { ok: true, operation, item: itemView(target), batch: batchView(batch, target), batchSelection: selection, ...allocation,
      note: '营养摄入请继续用现有 nutrition_execute 记录；库存更新不写营养账本' };
  }

  function adjust(args) {
    const item = findItem(text(args.name, 'name', 80) ?? '');
    const { batch, target, selection } = resolveBatch(args, item, { requireActive: false });
    const remainingQuantity = text(args.remainingQuantity, 'remainingQuantity');
    const quantityNote = text(args.quantityNote, 'quantityNote');
    if (remainingQuantity == null && quantityNote == null && args.note == null && args.status == null)
      throw Error('adjust 需要 remainingQuantity / quantityNote / note / status 之一');
    const status = args.status ?? batch.status;
    if (!['active', 'used_up', 'discarded'].includes(status)) throw Error('status 须为 active/used_up/discarded');
    if (status !== 'active' && (remainingQuantity != null || quantityNote != null)) {
      throw Error('修正已结束批次的余量时，请同时将 status 设为 active');
    }
    batch.status = status;
    if (status !== 'active' || remainingQuantity != null) setRemaining(batch, remainingQuantity);
    if (quantityNote != null) addNote(batch, 'supplement', quantityNote);
    if (args.note != null) batch.note = text(args.note, 'note', 500);
    saveBatch(batch);
    journal('adjust', target, batch, { remainingQuantity, quantityNote, status: args.status ?? null, note: args.note ?? null }, args.requestId, args.source ?? 'user_text');
    return { ok: true, operation: 'adjust', item: itemView(target), batch: batchView(batch, target), batchSelection: selection,
      note: '以用户最新说明为准；原始数量描述保留在批次记录中' };
  }

  function updateCondition(args) {
    const item = findItem(text(args.name, 'name', 80) ?? '');
    const { batch, target, selection } = resolveBatch(args, item);
    const storageChangedAt = validDate(args.storageChangedAt, 'storageChangedAt');
    if (storageChangedAt != null) {
      if (args.storage == null) throw Error('storageChangedAt 需要同时提供 storage');
      const { changes } = conditionHistory(batch);
      const lastDate = changes.filter(change => change.storage != null).at(-1)?.date ?? batch.purchased_at;
      if (storageChangedAt < lastDate || storageChangedAt > today()) {
        throw Error('storageChangedAt 须介于上一次储存记录日期（或采购日期）与今天之间');
      }
    }
    if (args.storage != null) {
      if (!STORAGE_MODES.includes(args.storage)) throw Error('storage 须为 fridge/freezer/room/unknown');
      batch.storage = args.storage;
    }
    if (args.opened != null) batch.opened = args.opened ? 1 : 0;
    if (args.cut != null) batch.cut = args.cut ? 1 : 0;
    if (args.labelExpiryDate !== undefined) batch.label_expiry_date = validDate(args.labelExpiryDate, 'labelExpiryDate');
    if (args.storage == null && args.opened == null && args.cut == null && args.labelExpiryDate === undefined)
      throw Error('update_condition 需要 storage/opened/cut/labelExpiryDate 之一');
    if (args.note != null) batch.note = text(args.note, 'note', 500);
    saveBatch(batch);
    journal('update_condition', target, batch, { storage: args.storage, storageChangedAt, opened: args.opened, cut: args.cut,
      labelExpiryDate: args.labelExpiryDate, note: args.note }, args.requestId, args.source ?? 'user_text');
    return { ok: true, operation: 'update_condition', item: itemView(target), batch: batchView(batch, target), batchSelection: selection };
  }

  const QUERY_NOTE = '数量可在同单位下近似扣减；保鲜状态仅供安排使用顺序，不是食品安全判定';

  function query(args = {}) {
    const view = args.view ?? 'current';
    if (!INVENTORY_VIEWS.includes(view)) throw Error('view 须为 current/item/expiring/availability');
    if (view === 'current') {
      const items = q('SELECT * FROM inventory_items ORDER BY name').all()
        .map(i => itemView(i)).filter(v => args.includeUsedUp || v.state === 'available');
      return { ok: true, view, asOf: today(), count: items.length, items,
        summary: items.map(item => item.summary).join('；') || '没有符合条件的库存记录', note: QUERY_NOTE };
    }
    if (view === 'item') {
      const name = text(args.name, 'name', 80);
      if (!name) throw Error('item 查询需要 name');
      const item = findItem(name);
      if (!item) return { ok: true, view, asOf: today(), found: false, name, summary: `「${name}」无库存记录`, note: QUERY_NOTE };
      const history = q('SELECT at,operation,batch_id,source,request_id,detail_json FROM inventory_changes WHERE item_id=? ORDER BY id DESC LIMIT 10').all(item.id)
        .map(h => ({ at: h.at, operation: h.operation, batchId: h.batch_id, source: h.source,
          requestId: h.request_id, detail: JSON.parse(h.detail_json) }));
      const result = itemView(item, { includeBatches: true });
      return { ok: true, view, asOf: today(), found: true, item: result, summary: result.summary, recentChanges: history, note: QUERY_NOTE };
    }
    if (view === 'expiring') {
      const withinDays = args.withinDays ?? 3;
      if (!Number.isInteger(withinDays) || withinDays < 0 || withinDays > 30) throw Error('withinDays 须为 0–30 的整数');
      const rows = [];
      const unknown = new Set();
      for (const item of q('SELECT * FROM inventory_items ORDER BY name').all()) {
        for (const b of activeBatches(item.id)) {
          const v = batchView(b, item);
          const f = v.freshness;
          if (f.daysLeft === null) unknown.add(item.name);
          else if (f.status === 'check' || (f.priorStorageDaysLeft ?? f.daysLeft) <= withinDays)
            rows.push({ name: item.name, batchId: b.id, remainingQuantity: v.remainingQuantity, storage: v.storageLabel, freshness: f });
        }
      }
      const priorityDays = ({ freshness }) => freshness.priorStorageDaysLeft ?? freshness.daysLeft;
      rows.sort((a, b) => priorityDays(a) - priorityDays(b));
      return { ok: true, view, asOf: today(), withinDays, priority: rows, unknownFreshness: [...unknown],
        summary: `未来 ${withinDays} 天内建议优先安排的批次有 ${rows.length} 个，${unknown.size} 种食材存在期限未知的批次`, note: QUERY_NOTE };
    }
    const names = Array.isArray(args.names) ? args.names : (args.name ? [args.name] : null);
    if (!names || !names.length || names.length > 12) throw Error('availability 需要 1–12 个食材名称');
    const results = names.map(raw => {
      const name = text(raw, 'names', 80);
      const item = name ? findItem(name) : null;
      if (!item) return { name: raw, available: false, reason: '无库存记录' };
      const v = itemView(item);
      return { name: item.name, available: v.state === 'available', remaining: v.remaining, freshness: v.freshness, summary: v.summary };
    });
    return { ok: true, view, asOf: today(), results,
      summary: results.map(result => result.summary ?? `${result.name}：${result.reason}`).join('；'), note: QUERY_NOTE };
  }

  function update(args = {}) {
    const operation = args.operation;
    if (!INVENTORY_OPERATIONS.includes(operation)) throw Error('operation 须为 purchase/consume/discard/adjust/update_condition');
    const requestId = args.requestId != null ? text(args.requestId, 'requestId', 120) : null;
    const source = args.source ?? 'user_text';
    if (!SOURCES.includes(source)) throw Error('source 须为 receipt/user_text/agent_inference');
    const payload = { ...args, requestId, source };
    const payloadHash = requestId && hash(Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]])));
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      const prev = requestId && q('SELECT * FROM inventory_request_receipts WHERE request_id=?').get(requestId);
      if (prev) {
        // Older receipts hashed the original field order and remain replayable.
        if (prev.payload_hash !== payloadHash && prev.payload_hash !== hash(args)) {
          throw Error('requestId 已用于不同的库存更新内容');
        }
        result = { ...JSON.parse(prev.result_json), duplicate: true };
        db.exec('COMMIT');
        return result;
      }
      result = operation === 'purchase' ? purchase(args)
        : operation === 'consume' ? consumeOrDiscard(args, 'consume')
        : operation === 'discard' ? consumeOrDiscard(args, 'discard')
        : operation === 'adjust' ? adjust(args)
        : updateCondition(args);
      if (requestId) q('INSERT INTO inventory_request_receipts(request_id,payload_hash,result_json,created_at) VALUES(?,?,?,?)')
        .run(requestId, payloadHash, JSON.stringify(result), stamp());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return result;
  }

  return { update, query, close: () => db.close(), dataVersion: () => q('PRAGMA data_version').get().data_version };
}

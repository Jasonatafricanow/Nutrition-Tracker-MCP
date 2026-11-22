/**
 * The kitchen: from what is in the fridge and what was cooked lately to one menu that can be cooked tonight.
 *
 * Five things stay apart: the food library (what a food is), the pantry (what is at home), recipes, the
 * menu (what is going to be cooked) and the ledger (what each person ate). A menu is a DRAFT until the
 * user confirms it; neither a draft nor a confirmed menu touches the pantry or anyone's ledger. Only when the
 * user says a dish WAS cooked does the fridge lose what that dish used (as far as the amounts can be
 * subtracted; the rest is marked "剩多少待确认", never guessed). Each person books what they ate (meal).
 *
 * The cookbook holds the household's own dishes: a dish the user approved and asked to keep is saved with its
 * ingredients, timings and cooking notes, and a later menu can take it whole (fromRecipe).
 *
 * The agent composes the dishes (it knows cooking); this module keeps them, checks the shape the user asked
 * for, the household's stated preferences and recent repeats, works out what is missing against the pantry
 * ("not recorded" is unknown → 先查家里, never "none"), and lays out the prep and stove order. Swapping one
 * dish rewrites that dish only; the others stay exactly as they were.
 */
import { randomUUID } from 'node:crypto';
import { subtract } from './amounts.js';

const KINDS = ['荤', '素', '汤', '主食', '凉菜', '小食'];
const DISH_KINDS = new Set(['荤', '素', '凉菜']); // what "四菜" counts
const APPLIANCES = ['灶', '蒸锅', '电饭煲', '烤箱', '空气炸锅', '无'];
const STAPLE = /^(盐|糖|白糖|冰糖|酱油|生抽|老抽|醋|香醋|陈醋|料酒|黄酒|食用油|油|花生油|菜籽油|香油|麻油|蚝油|淀粉|生粉|胡椒粉?|白胡椒|味精|鸡精|花椒|八角|桂皮|香叶|豆瓣酱|番茄酱|蒜|大蒜|姜|生姜|葱|小葱|香葱|大葱|干辣椒|水)$/;
const PREF_KINDS = { avoid_main: '不做正菜', not_default: '不默认上', note: '备注' };
const DAY = 86400000;

export function createKitchen({ database, stock, now = () => new Date(), timeZone = 'Asia/Shanghai',
  recentMeals = () => [], planSet = null } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kitchen_prefs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS menus (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, slot TEXT NOT NULL, serve_at TEXT NOT NULL, diners TEXT NOT NULL DEFAULT '',
      want_json TEXT NOT NULL DEFAULT '{}', burners INTEGER NOT NULL DEFAULT 2, dishes_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cooked_on TEXT
    );
    CREATE TABLE IF NOT EXISTS menu_events (
      id TEXT PRIMARY KEY, menu_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, detail_json TEXT
    );
    CREATE TABLE IF NOT EXISTS kitchen_requests (request_id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kitchen_recipes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, dish_json TEXT NOT NULL, source_menu_id TEXT,
      saved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT
    );`);
  const q = sql => database.prepare(sql);
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
  const plusDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const text = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).slice(0, max));
  function once(requestId, write) {
    if (!requestId) throw Error('requestId required');
    const prev = q('SELECT result_json FROM kitchen_requests WHERE request_id=?').get(requestId);
    if (prev) return { ...JSON.parse(prev.result_json), duplicate: true };
    database.exec('BEGIN');
    try {
      const result = write();
      q('INSERT INTO kitchen_requests VALUES(?,?)').run(requestId, JSON.stringify(result));
      database.exec('COMMIT');
      return result;
    } catch (e) { database.exec('ROLLBACK'); throw e; }
  }
  const log = (menuId, action, detail, by) => q('INSERT INTO menu_events VALUES(?,?,?,?,?)')
    .run(randomUUID(), menuId, now().toISOString(), action, detail == null && !by ? null : JSON.stringify({ ...(detail ?? {}), ...(by ? { by: text(by, 40) } : {}) }));

  // ---------- preferences the household stated ----------
  const prefs = () => q('SELECT id, kind, text FROM kitchen_prefs WHERE removed_at IS NULL ORDER BY created_at').all()
    .map(p => ({ id: p.id, kind: p.kind, meaning: PREF_KINDS[p.kind], text: p.text }));
  function prefAdd({ kind, text: t, requestId } = {}) {
    if (!Object.hasOwn(PREF_KINDS, kind)) throw Error('kind must be avoid_main (不做正菜), not_default (不默认上) or note');
    const v = text(t, 80);
    if (!v) throw Error('text required');
    return once(requestId, () => {
      const same = q('SELECT id FROM kitchen_prefs WHERE kind=? AND text=? AND removed_at IS NULL').get(kind, v);
      const id = same?.id ?? 'kp_' + randomUUID();
      if (!same) q('INSERT INTO kitchen_prefs VALUES(?,?,?,?,?)').run(id, kind, v, now().toISOString(), null);
      return { ok: true, id, added: !same, prefs: prefs() };
    });
  }
  function prefRemove({ prefId, requestId } = {}) {
    return once(requestId, () => {
      const row = q('SELECT id FROM kitchen_prefs WHERE id=? AND removed_at IS NULL').get(prefId ?? '');
      if (!row) throw Error('没有这条偏好');
      q('UPDATE kitchen_prefs SET removed_at=? WHERE id=?').run(now().toISOString(), row.id);
      return { ok: true, removed: row.id, prefs: prefs() };
    });
  }

  // ---------- what was cooked / eaten lately ----------
  function recentDishes(days = 7) {
    const from = plusDays(today(), -days);
    const cooked = q("SELECT cooked_on, dishes_json FROM menus WHERE status='cooked' AND cooked_on >= ? ORDER BY cooked_on DESC").all(from)
      .flatMap(m => JSON.parse(m.dishes_json).filter(d => d.cooked !== false).map(d => ({ name: d.name, date: m.cooked_on, from: 'menu' })));
    const eaten = recentMeals(days).map(x => ({ name: x.name, date: x.date, from: 'meals' }));
    const seen = new Set();
    return [...cooked, ...eaten].filter(x => { const k = x.name + '|' + x.date; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // ---------- one dish ----------
  const minutes = (v, field, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw Error(`${field} must be 0–${max} minutes`);
    return n;
  };
  function cleanDish(raw, id) {
    if (!raw || typeof raw !== 'object') throw Error('each dish must be an object');
    if (raw.fromRecipe) {
      // A saved household dish, whole; anything given next to it (say a different amount) overrides that field.
      const r = q('SELECT * FROM kitchen_recipes WHERE id=? AND removed_at IS NULL').get(text(raw.fromRecipe, 80));
      if (!r) throw Error(`菜谱里没有 ${raw.fromRecipe}`);
      const { fromRecipe, ...over } = raw;
      return { ...cleanDish({ ...JSON.parse(r.dish_json), ...over }, id), kitchenRecipeId: r.id };
    }
    const name = text(raw.name, 40);
    if (!name) throw Error('each dish needs a name');
    if (!KINDS.includes(raw.kind)) throw Error(`「${name}」kind must be one of ${KINDS.join('/')}`);
    if (!Array.isArray(raw.ingredients) || !raw.ingredients.length || raw.ingredients.length > 20) throw Error(`「${name}」needs 1–20 ingredients`);
    const ingredients = raw.ingredients.map(i => {
      const n = text(i?.name, 30);
      if (!n) throw Error(`「${name}」has an ingredient without a name`);
      return { name: n, ...(i.amount ? { amount: text(i.amount, 30) } : {}), ...(i.foodId ? { foodId: text(i.foodId, 80) } : {}),
        ...(i.buy ? { buy: true } : {}) };
    });
    const appliance = raw.appliance ?? '灶';
    if (!APPLIANCES.includes(appliance)) throw Error(`「${name}」appliance must be one of ${APPLIANCES.join('/')}`);
    const guide = {};
    for (const k of ['heat', 'seasoning', 'doneness']) {
      const v = text(raw[k], 200);
      if (!v && ['荤', '素', '汤'].includes(raw.kind)) throw Error(`「${name}」needs ${k} (火候 / 调味先后 / 熟度判断)`);
      if (v) guide[k] = v;
    }
    const steps = Array.isArray(raw.steps) ? raw.steps.slice(0, 12).map(s => text(s, 160)).filter(Boolean) : [];
    return { id, name, kind: raw.kind, ...(raw.recipeId ? { recipeId: text(raw.recipeId, 80) } : {}),
      ...(raw.kitchenRecipeId ? { kitchenRecipeId: text(raw.kitchenRecipeId, 80) } : {}), ingredients,
      prepMin: minutes(raw.prepMin ?? 0, 'prepMin', 240), cookMin: minutes(raw.cookMin ?? 0, 'cookMin', 480), appliance,
      ...guide, ...(steps.length ? { steps } : {}) };
  }

  // ---------- what the menu needs and when to start what ----------
  const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
  const match = (inStock, i) => inStock.filter(p => (i.foodId && p.foodId === i.foodId) || p.name.includes(i.name) || i.name.includes(p.name))
    .sort((a, b) => a.daysLeft - b.daysLeft)[0];
  function shopping(dishes) {
    const inStock = stock.pantry().items;
    const gone = stock.recentlyGone(30);
    const lines = new Map();
    for (const d of dishes) for (const i of d.ingredients) {
      const hit = match(inStock, i);
      const status = hit && !i.buy ? 'have'
        : i.buy || gone.some(g => (i.foodId && g.foodId === i.foodId) || g.name === i.name) ? 'buy' : 'check';
      const key = status + '|' + (hit?.id ?? i.name);
      const line = lines.get(key) ?? { status, name: hit && status === 'have' ? hit.name : i.name, for: [],
        ...(status === 'have' ? { quantity: hit.quantity, daysLeft: hit.daysLeft, itemId: hit.id } : {}),
        ...(STAPLE.test(i.name) ? { staple: true } : {}) };
      if (!line.for.includes(d.name)) line.for.push(d.name);
      lines.set(key, line);
    }
    const all = [...lines.values()];
    const usedIds = new Set(all.filter(l => l.status === 'have').map(l => l.itemId));
    return {
      buy: all.filter(l => l.status === 'buy').map(({ status, ...l }) => l),
      checkAtHome: all.filter(l => l.status === 'check').map(({ status, ...l }) => l),
      have: all.filter(l => l.status === 'have').map(({ status, ...l }) => l),
      expiringNotUsed: inStock.filter(p => p.daysLeft <= 2 && !usedIds.has(p.id)).map(p => ({ name: p.name, daysLeft: p.daysLeft })),
      note: 'buy = 用户说没有或冰箱记录显示已用完；checkAtHome = 冰箱里没记，不知道有没有，先查家里；have = 冰箱记录里有（数量是当时的说法）',
    };
  }
  function schedule(dishes, serveAt, burners) {
    const [h, m] = serveAt.split(':').map(Number);
    const serve = h * 60 + m;
    const byStart = dishes.map(d => ({ d, cookStart: serve - d.cookMin })).sort((a, b) => a.cookStart - b.cookStart || b.d.cookMin - a.d.cookMin);
    // One person preps: walk back from the last dish so each is ready right before its own fire.
    let nextPrep = Infinity;
    for (const x of [...byStart].reverse()) {
      const prepEnd = Math.min(x.cookStart, nextPrep);
      x.prepStart = prepEnd - x.d.prepMin;
      nextPrep = x.prepStart;
    }
    const steps = [];
    for (const x of [...byStart].sort((a, b) => a.prepStart - b.prepStart)) if (x.d.prepMin) steps.push({ at: x.prepStart, what: `备料：${x.d.name}（约 ${x.d.prepMin} 分钟）` });
    for (const x of byStart) if (x.d.cookMin) steps.push({ at: x.cookStart, what: `${x.d.appliance === '无' ? '开做' : `上${x.d.appliance}`}：${x.d.name}（约 ${x.d.cookMin} 分钟）` });
    steps.push({ at: serve, what: '开饭' });
    steps.sort((a, b) => a.at - b.at);
    const warnings = [];
    const stove = byStart.filter(x => x.d.appliance === '灶' && x.d.cookMin);
    for (const x of stove) {
      const busy = stove.filter(y => y.cookStart <= x.cookStart && serve > x.cookStart).length;
      if (busy > burners) { warnings.push(`${hhmm(x.cookStart)} 起同时要 ${busy} 个灶眼，家里 ${burners} 个；把先做好的菜盛出保温，或改用蒸锅/电饭煲`); break; }
    }
    return { startPrepAt: hhmm(Math.min(...byStart.map(x => x.prepStart), serve)), serveAt, steps: steps.map(s => ({ at: hhmm(s.at), what: s.what })), warnings };
  }
  function checks(dishes, want) {
    const out = [];
    const count = dishes.filter(d => DISH_KINDS.has(d.kind)).length, soups = dishes.filter(d => d.kind === '汤').length;
    if (want.dishes != null && count !== want.dishes) out.push(`要 ${want.dishes} 个菜，现在 ${count} 个`);
    if (want.soups != null && soups !== want.soups) out.push(`要 ${want.soups} 个汤，现在 ${soups} 个`);
    for (const must of want.must ?? []) if (!dishes.some(d => d.name.includes(must))) out.push(`点名要的「${must}」不在菜单里`);
    const names = dishes.map(d => d.name);
    if (new Set(names).size !== names.length) out.push('菜单里有重复的菜');
    const recent = recentDishes(7);
    for (const d of dishes) {
      const hit = recent.find(r => r.name === d.name || (r.name.length >= 2 && d.name.includes(r.name)) || (d.name.length >= 2 && r.name.includes(d.name)));
      if (hit && !(want.must ?? []).some(m => d.name.includes(m))) out.push(`「${d.name}」${hit.date} 刚吃过（${hit.name}）`);
    }
    for (const p of prefs()) for (const d of dishes) {
      if (!d.name.includes(p.text) && !d.ingredients.some(i => i.name.includes(p.text))) continue;
      if (p.kind === 'avoid_main' && (d.kind === '荤' || d.kind === '素') && d.name.includes(p.text)) out.push(`偏好：${p.text}不做正菜（「${d.name}」）`);
      if (p.kind === 'not_default' && !(want.must ?? []).some(m => d.name.includes(m) || m.includes(p.text))) out.push(`偏好：不默认上${p.text}，用户没点名（「${d.name}」）`);
    }
    return out;
  }
  function view(row) {
    const dishes = JSON.parse(row.dishes_json), want = JSON.parse(row.want_json);
    const plan = schedule(dishes, row.serve_at, row.burners);
    return { ok: true, menuId: row.id, status: row.status, date: row.date, mealSlot: row.slot, diners: row.diners || undefined, want,
      dishes, shopping: shopping(dishes), timeline: plan, warnings: [...checks(dishes, want), ...plan.warnings],
      note: row.status === 'draft' ? '这是草案：没有写入库存，也没有记任何人的饮食' : row.status === 'cooked' ? '已做；冰箱已按做了的菜扣过（扣不准的标了待确认），各人吃了多少各自记 meal' : undefined };
  }
  const getMenu = menuId => {
    const row = q('SELECT * FROM menus WHERE id=?').get(menuId ?? '');
    if (!row) throw Error('没有这个菜单');
    return row;
  };

  // ---------- writes ----------
  function draft({ date, mealSlot = '晚餐', serveAt = '18:30', diners, want = {}, burners = 2, dishes, requestId, by } = {}) {
    const day = date ?? today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < today()) throw Error('date must be today or later (YYYY-MM-DD)');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(serveAt)) throw Error('serveAt must be HH:MM');
    if (!Number.isInteger(burners) || burners < 1 || burners > 6) throw Error('burners must be 1–6');
    if (!Array.isArray(dishes) || !dishes.length || dishes.length > 10) throw Error('dishes: 1–10 dishes');
    const w = { ...(Number.isInteger(want.dishes) ? { dishes: want.dishes } : {}), ...(Number.isInteger(want.soups) ? { soups: want.soups } : {}),
      ...(Array.isArray(want.must) && want.must.length ? { must: want.must.map(x => text(x, 30)).filter(Boolean) } : {}) };
    return once(requestId, () => {
      const id = 'menu_' + randomUUID();
      const clean = dishes.map((d, i) => cleanDish(d, `d${i + 1}`));
      const t = now().toISOString();
      q('INSERT INTO menus(id,date,slot,serve_at,diners,want_json,burners,dishes_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, day, text(mealSlot, 10), serveAt, text(diners, 40), JSON.stringify(w), burners, JSON.stringify(clean), 'draft', t, t);
      log(id, 'draft', { dishes: clean.map(d => d.name) }, by);
      return view(getMenu(id));
    });
  }
  // Replace ONE dish; every other dish keeps its content and id.
  function swap({ menuId, dishId, dishName, dish, requestId, by } = {}) {
    return once(requestId, () => {
      const row = getMenu(menuId);
      if (row.status !== 'draft') throw Error('只有草案能换菜；已确认的先说要改，再重新出草案');
      const dishes = JSON.parse(row.dishes_json);
      const at = dishes.findIndex(d => (dishId && d.id === dishId) || (!dishId && dishName && d.name === text(dishName, 40)));
      if (at < 0) throw Error('菜单里没有这道菜（用 dishId 或准确的菜名）');
      const used = dishes.map(d => Number(d.id.slice(1)));
      const next = cleanDish(dish, `d${Math.max(...used) + 1}`);
      const old = dishes[at];
      dishes[at] = next;
      q('UPDATE menus SET dishes_json=?, updated_at=? WHERE id=?').run(JSON.stringify(dishes), now().toISOString(), row.id);
      log(row.id, 'swap', { from: old.name, to: next.name }, by);
      return { ...view(getMenu(row.id)), swapped: { from: old.name, to: next.name, dishId: next.id } };
    });
  }
  // The user agreed to cook it. Dishes that have a saved recipe may go into members' meal plans (existing plan);
  // still nothing is eaten or taken out of the pantry.
  function confirm({ menuId, plan = [], requestId, by } = {}) {
    return once(requestId, () => {
      const row = getMenu(menuId);
      if (row.status !== 'draft') throw Error(`菜单已经是 ${row.status}`);
      const dishes = JSON.parse(row.dishes_json);
      const planned = [];
      for (const [i, p] of plan.entries()) {
        const d = dishes.find(x => x.id === p.dishId);
        if (!d) throw Error(`plan[${i}]: 菜单里没有 ${p.dishId}`);
        if (!d.recipeId) throw Error(`「${d.name}」没有存过菜谱，不能排进 plan`);
        if (!planSet) throw Error('plan needs household mode');
        planned.push({ memberId: p.memberId, dish: d.name, ...planSet(p.memberId, { date: row.date, mealSlot: row.slot, recipeId: d.recipeId,
          servings: p.servings, requestId: `${requestId}:plan:${i}` }) });
      }
      q("UPDATE menus SET status='confirmed', updated_at=? WHERE id=?").run(now().toISOString(), row.id);
      log(row.id, 'confirm', { planned: planned.length }, by);
      return { ...view(getMenu(row.id)), planned };
    });
  }
  // The user said it was cooked ("今天做了排骨和豆角"): those dishes leave the fridge what they used. An
  // ingredient the fridge has is subtracted when both amounts are numbers in a compatible unit; otherwise the
  // item stays, marked "剩多少待确认" — unknown, never zero and never a guess. Seasoning without a number is
  // left alone. Without a menu, `dishes` (or fromRecipe) says what was cooked.
  function cooked({ menuId, dishIds, dishes, date, deduct = true, requestId, by } = {}) {
    return once(requestId, () => {
      const day = date ?? today();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) throw Error('date must be today or earlier');
      let row;
      if (menuId) {
        row = getMenu(menuId);
        if (!['draft', 'confirmed'].includes(row.status)) throw Error(`菜单已经是 ${row.status}`);
      } else {
        if (!Array.isArray(dishes) || !dishes.length || dishes.length > 10) throw Error('cooked needs menuId, or dishes (1–10) that were cooked');
        const id = 'menu_' + randomUUID(), t = now().toISOString();
        const clean = dishes.map((d, i) => cleanDish(d, `d${i + 1}`));
        q('INSERT INTO menus(id,date,slot,serve_at,diners,want_json,burners,dishes_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, day, '', '18:30', '', '{}', 2, JSON.stringify(clean), 'draft', t, t);
        row = getMenu(id);
      }
      const all = JSON.parse(row.dishes_json);
      const made = Array.isArray(dishIds) && dishIds.length ? new Set(dishIds) : new Set(all.map(d => d.id));
      for (const id of made) if (!all.some(d => d.id === id)) throw Error(`菜单里没有 ${id}`);
      const marked = all.map(d => ({ ...d, cooked: made.has(d.id) }));
      const pantry = { deducted: [], usedUp: [], toCheck: [] };
      if (deduct) {
        const inStock = stock.pantry().items;
        for (const d of marked.filter(x => x.cooked)) for (const i of d.ingredients) {
          if (i.buy) continue; // bought for this dish; it was never in the fridge record
          const hit = match(inStock, i);
          const live = hit && stock.itemRow(hit.id);
          if (!live) continue; // not recorded, or already used up by an earlier dish
          const res = i.amount ? subtract(live.quantity, i.amount) : null;
          if (res) {
            const out = stock.useRow(live, res.left ? res.text : '', `做${d.name}用了 ${i.amount}`, by);
            (out.usedUp ? pantry.usedUp : pantry.deducted).push({ name: live.name, dish: d.name, used: i.amount, before: live.quantity, left: out.remaining ?? undefined });
          } else if (!STAPLE.test(i.name)) {
            const base = live.quantity.replace(/（[^（]*待确认）$/, '');
            stock.useRow(live, `${base}（做${d.name}用过，剩多少待确认）`.slice(0, 60), `做${d.name}用了 ${i.amount || '一些'}`, by);
            pantry.toCheck.push({ name: live.name, dish: d.name, used: i.amount || undefined, before: base });
          }
        }
      }
      q("UPDATE menus SET status='cooked', cooked_on=?, dishes_json=?, updated_at=? WHERE id=?").run(day, JSON.stringify(marked), now().toISOString(), row.id);
      log(row.id, 'cooked', { date: day, dishes: marked.filter(d => d.cooked).map(d => d.name), pantry }, by);
      return { ...view(getMenu(row.id)), pantry: { ...pantry,
        note: 'deducted / usedUp = 按菜里写的用量从冰箱扣了；toCheck = 用量没法算（没写量或单位对不上），标了「剩多少待确认」，问一句还剩多少再 pantry edit' } };
    });
  }

  // ---------- the household cookbook ----------
  const recipeOut = r => {
    const dish = JSON.parse(r.dish_json);
    const cooked = q("SELECT cooked_on, dishes_json FROM menus WHERE status='cooked' ORDER BY cooked_on DESC").all()
      .filter(m => JSON.parse(m.dishes_json).some(d => d.kitchenRecipeId === r.id && d.cooked !== false));
    return { recipeId: r.id, ...dish, timesCooked: cooked.length, lastCooked: cooked[0]?.cooked_on, savedBy: r.saved_by ?? undefined, updatedAt: r.updated_at };
  };
  // Keep a dish the user approved: from a menu (menuId + dishId) or given whole (dish). A name already kept is
  // refused unless recipeId says which kept dish to replace.
  function recipeSave({ menuId, dishId, dish, recipeId, requestId, by } = {}) {
    return once(requestId, () => {
      let raw, source = null;
      if (menuId) {
        const row = getMenu(menuId);
        raw = JSON.parse(row.dishes_json).find(d => d.id === dishId);
        if (!raw) throw Error('菜单里没有这道菜（dishId）');
        source = row.id;
      } else raw = dish;
      const { id: _i, cooked: _c, kitchenRecipeId: _k, ...rest } = cleanDish(raw, 'r');
      const t = now().toISOString();
      const same = q('SELECT id FROM kitchen_recipes WHERE name=? AND removed_at IS NULL').get(rest.name);
      let id = recipeId;
      if (id) {
        if (!q('SELECT id FROM kitchen_recipes WHERE id=? AND removed_at IS NULL').get(id)) throw Error('菜谱里没有这一条');
        if (same && same.id !== id) throw Error(`已有同名菜谱「${rest.name}」(${same.id})`);
        q('UPDATE kitchen_recipes SET name=?, kind=?, dish_json=?, updated_at=? WHERE id=?').run(rest.name, rest.kind, JSON.stringify(rest), t, id);
      } else {
        if (same) throw Error(`已有同名菜谱「${rest.name}」(${same.id})；要改它就带 recipeId`);
        id = 'kr_' + randomUUID();
        q('INSERT INTO kitchen_recipes VALUES(?,?,?,?,?,?,?,?,?)').run(id, rest.name, rest.kind, JSON.stringify(rest), source, text(by, 40) || null, t, t, null);
      }
      if (source) {
        // The menu's dish now points at the kept recipe, so cooking it counts for the recipe.
        const ds = JSON.parse(getMenu(source).dishes_json).map(d => d.id === dishId ? { ...d, kitchenRecipeId: id } : d);
        q('UPDATE menus SET dishes_json=? WHERE id=?').run(JSON.stringify(ds), source);
      }
      return { ok: true, saved: !recipeId, updated: !!recipeId, recipe: recipeOut(q('SELECT * FROM kitchen_recipes WHERE id=?').get(id)) };
    });
  }
  function recipeRemove({ recipeId, requestId } = {}) {
    return once(requestId, () => {
      const r = q('SELECT id, name FROM kitchen_recipes WHERE id=? AND removed_at IS NULL').get(recipeId ?? '');
      if (!r) throw Error('菜谱里没有这一条');
      q('UPDATE kitchen_recipes SET removed_at=? WHERE id=?').run(now().toISOString(), r.id);
      return { ok: true, removed: r.id, name: r.name };
    });
  }
  function cookbook({ recipeId, query = '' } = {}) {
    if (recipeId) {
      const r = q('SELECT * FROM kitchen_recipes WHERE id=? AND removed_at IS NULL').get(recipeId);
      if (!r) throw Error('菜谱里没有这一条');
      return { ok: true, recipe: recipeOut(r) };
    }
    const rows = q('SELECT * FROM kitchen_recipes WHERE removed_at IS NULL ORDER BY updated_at DESC').all()
      .filter(r => !query || r.name.includes(query) || r.dish_json.includes(query)).map(recipeOut);
    return { ok: true, count: rows.length, recipes: rows,
      note: '家里做过、认可了要留的菜；排菜单时用 {fromRecipe: recipeId} 整道拿来。营养菜谱（recipes / recipe_save，按食品库克数算营养）是另一回事' };
  }

  function discard({ menuId, requestId, by } = {}) {
    return once(requestId, () => {
      const row = getMenu(menuId);
      if (row.status === 'cooked') throw Error('已经做过的菜单不能撤');
      q("UPDATE menus SET status='discarded', updated_at=? WHERE id=?").run(now().toISOString(), row.id);
      log(row.id, 'discard', null, by);
      return { ok: true, menuId: row.id, discarded: true };
    });
  }

  // ---------- reads ----------
  function kitchen() {
    const p = stock.pantry();
    const open = q("SELECT * FROM menus WHERE status IN ('draft','confirmed') AND date >= ? ORDER BY date, created_at").all(today());
    return { ok: true, date: p.date,
      pantry: p.items.map(i => ({ name: i.name, quantity: i.quantity, daysLeft: i.daysLeft, expiryBasis: i.expiryBasis, ...(i.foodId ? { foodId: i.foodId } : {}) })),
      expiringSoon: p.expiringSoon, expired: p.expired, recentlyGone: stock.recentlyGone(30),
      recentDishes: recentDishes(7), prefs: prefs(),
      cookbook: q('SELECT id, name, kind FROM kitchen_recipes WHERE removed_at IS NULL ORDER BY updated_at DESC LIMIT 60').all()
        .map(r => ({ recipeId: r.id, name: r.name, kind: r.kind })),
      openMenus: open.map(m => ({ menuId: m.id, status: m.status, date: m.date, mealSlot: m.slot, dishes: JSON.parse(m.dishes_json).map(d => d.name) })),
      recentlyCooked: q("SELECT * FROM menus WHERE status='cooked' AND cooked_on >= ? ORDER BY cooked_on DESC, updated_at DESC LIMIT 5").all(plusDays(today(), -7))
        .map(m => ({ menuId: m.id, date: m.cooked_on, dishes: JSON.parse(m.dishes_json).filter(d => d.cooked !== false).map(d => d.name) })),
      note: '冰箱里没记的不是没有，是不知道。先用快到期的，但别为清库存硬凑；避开最近吃过的和偏好里说不要的；家里菜谱（cookbook）里的菜优先考虑' };
  }
  const menu = ({ menuId } = {}) => view(getMenu(menuId));

  return { kitchen, menu, draft, swap, confirm, cooked, discard, prefAdd, prefRemove, prefs, recentDishes, recipeSave, recipeRemove, cookbook };
}

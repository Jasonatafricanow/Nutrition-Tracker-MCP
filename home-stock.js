/**
 * Things the household keeps: the fridge (pantry) and the medicine cabinet. Shared by the family, so they
 * live in the household database, not in any member's ledger.
 *
 * Pantry (O51, the owner's 11-17 idea): a receipt or a sentence puts food in; cooking takes it out. Amounts
 * are whatever was said ("600g", "4根", "600g/四根") — the agent reads them, the ledger does no arithmetic.
 * Each item gets an expiry from what the agent estimated or a common shelf life, so "what goes off soon"
 * can be asked.
 *
 * Medicine cabinet (O40): what is at home, for whom, the dose and the minimum gap between doses. A dose taken
 * is the member's real state: it arrives from statebar (checked against the owner's words), never from the
 * agent directly, and gives "when can the next one be taken".
 */
import { randomUUID } from 'node:crypto';

// Common fridge shelf life in days, used only when the agent gives none. First match wins.
export const SHELF_LIFE = [
  [/冷冻|速冻|冻/, 90], [/鱼|虾|蟹|贝|海鲜|蛤/, 2], [/肉末|绞肉|肉馅/, 1], [/鸡|鸭|猪|牛|羊|肉|排骨|肝/, 3],
  [/豆腐|豆皮|豆芽/, 3], [/菠菜|生菜|油麦|空心菜|小白菜|青菜|韭菜|香菜|葱|叶/, 3], [/蘑菇|菇|菌/, 4],
  [/黄瓜|西葫芦|茄子|豆角|四季豆|青椒|辣椒|西兰花|花菜/, 5], [/番茄|西红柿/, 7], [/牛奶|鲜奶|酸奶/, 7],
  [/蛋/, 21], [/土豆|洋葱|胡萝卜|萝卜|红薯|南瓜|姜|蒜|山药|芋/, 14], [/苹果|橙|柚|梨/, 14],
  [/草莓|葡萄|樱桃|香蕉|桃|芒果|莓/, 4], [/面包|馒头|包子|饺子皮/, 3], [/剩菜|熟食|卤/, 2],
];
const DAY = 86400000;
const shelfLife = name => (SHELF_LIFE.find(([re]) => re.test(name)) ?? [null, 7])[1];

export function createHomeStock({ database, now = () => new Date(), timeZone = 'Asia/Shanghai' }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS pantry_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity TEXT NOT NULL DEFAULT '', note TEXT,
      added_date TEXT NOT NULL, expires_date TEXT NOT NULL, expiry_basis TEXT NOT NULL,
      source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pantry_events (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL,
      before_quantity TEXT, after_quantity TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_requests (request_id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS medications (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL DEFAULT '[]', for_members TEXT NOT NULL DEFAULT '[]',
      dose TEXT NOT NULL DEFAULT '', min_interval_hours REAL, max_per_day INTEGER, note TEXT,
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workouts (
      id TEXT PRIMARY KEY, member_id TEXT NOT NULL, date TEXT NOT NULL, activity TEXT NOT NULL,
      duration_min INTEGER, source TEXT NOT NULL, source_event_id TEXT UNIQUE, note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS doses (
      id TEXT PRIMARY KEY, medication_id TEXT, medication_name TEXT NOT NULL, member_id TEXT NOT NULL,
      taken_at TEXT NOT NULL, amount TEXT, source TEXT NOT NULL, source_event_id TEXT UNIQUE, note TEXT
    );`);
  const q = sql => database.prepare(sql);
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
  const plusDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / DAY);
  const text = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).slice(0, max));
  // A request id makes a retried write return its first result instead of writing twice.
  function once(requestId, write) {
    if (requestId) {
      const prev = q('SELECT result_json FROM stock_requests WHERE request_id=?').get(requestId);
      if (prev) return { ...JSON.parse(prev.result_json), duplicate: true };
    }
    database.exec('BEGIN');
    try {
      const result = write();
      if (requestId) q('INSERT INTO stock_requests VALUES(?,?)').run(requestId, JSON.stringify(result));
      database.exec('COMMIT');
      return result;
    } catch (e) { database.exec('ROLLBACK'); throw e; }
  }
  const event = (itemId, action, before, after, note) =>
    q('INSERT INTO pantry_events VALUES(?,?,?,?,?,?,?)').run(randomUUID(), itemId, now().toISOString(), action, before ?? null, after ?? null, note ?? null);

  // ---------- pantry ----------
  function pantryAdd({ items, source = 'text', requestId, date } = {}) {
    if (!Array.isArray(items) || !items.length || items.length > 60) throw Error('items: 1–60 items');
    if (!['text', 'receipt', 'photo'].includes(source)) throw Error('source must be text, receipt or photo');
    const day = date ?? today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today()) throw Error('date must be today or earlier (YYYY-MM-DD)');
    return once(requestId, () => {
      const added = items.map(raw => {
        const name = text(raw?.name, 60);
        if (!name) throw Error('each item needs a name');
        let expires, basis;
        if (raw.expiresOn) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.expiresOn)) throw Error('expiresOn must be YYYY-MM-DD');
          expires = raw.expiresOn; basis = 'stated';
        } else if (raw.shelfLifeDays != null) {
          const d = Number(raw.shelfLifeDays);
          if (!Number.isFinite(d) || d < 0 || d > 3650) throw Error('shelfLifeDays must be 0–3650');
          expires = plusDays(day, Math.round(d)); basis = 'estimate';
        } else { expires = plusDays(day, shelfLife(name)); basis = 'common'; }
        const id = 'p_' + randomUUID();
        q('INSERT INTO pantry_items VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, name, text(raw.quantity, 60), text(raw.note, 200) || null,
          day, expires, basis, source, 'in', now().toISOString());
        event(id, 'add', null, text(raw.quantity, 60), source);
        return { id, name, quantity: text(raw.quantity, 60), expiresOn: expires, expiryBasis: basis };
      });
      return { ok: true, added };
    });
  }
  // Find an item in stock by id or by name (the soonest to expire among same-named ones).
  function findItem({ itemId, name }) {
    if (itemId) {
      const row = q("SELECT * FROM pantry_items WHERE id=? AND status='in'").get(itemId);
      if (!row) throw Error('冰箱里没有这一条（可能已用完）');
      return row;
    }
    const n = text(name, 60);
    if (!n) throw Error('itemId or name required');
    const rows = q("SELECT * FROM pantry_items WHERE status='in' AND (name=? OR name LIKE ?) ORDER BY expires_date, added_date").all(n, `%${n}%`);
    if (!rows.length) throw Error(`冰箱里没有「${n}」`);
    const exact = rows.filter(r => r.name === n);
    const pick = exact.length ? exact : rows;
    if (new Set(pick.map(r => r.name)).size > 1) throw Error(`「${n}」对上好几样：${[...new Set(pick.map(r => r.name))].join('、')}，说清是哪个`);
    return pick[0];
  }
  // Cooking took some out: `remaining` is what is left, in the owner's words; empty/0/用完 = all used.
  function pantryUse({ itemId, name, remaining, note, requestId } = {}) {
    return once(requestId, () => {
      const row = findItem({ itemId, name });
      const left = text(remaining, 60);
      const finished = left === '' || /^(0|零|没了|用完|吃完|空)/.test(left);
      q("UPDATE pantry_items SET quantity=?, status=?, updated_at=? WHERE id=?")
        .run(finished ? row.quantity : left, finished ? 'used' : 'in', now().toISOString(), row.id);
      event(row.id, finished ? 'used_up' : 'use', row.quantity, finished ? null : left, text(note, 200) || null);
      return { ok: true, id: row.id, name: row.name, before: row.quantity, remaining: finished ? null : left, usedUp: finished };
    });
  }
  function pantryDiscard({ itemId, name, note, requestId } = {}) {
    return once(requestId, () => {
      const row = findItem({ itemId, name });
      q("UPDATE pantry_items SET status='discarded', updated_at=? WHERE id=?").run(now().toISOString(), row.id);
      event(row.id, 'discard', row.quantity, null, text(note, 200) || null);
      return { ok: true, id: row.id, name: row.name, discarded: true };
    });
  }
  // Correct an entry: quantity, name or expiry (e.g. "the milk says 11-28").
  function pantryEdit({ itemId, name, newName, quantity, expiresOn, requestId } = {}) {
    return once(requestId, () => {
      const row = findItem({ itemId, name });
      if (expiresOn != null && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) throw Error('expiresOn must be YYYY-MM-DD');
      const next = { name: text(newName, 60) || row.name, quantity: quantity != null ? text(quantity, 60) : row.quantity,
        expires: expiresOn ?? row.expires_date, basis: expiresOn ? 'stated' : row.expiry_basis };
      q('UPDATE pantry_items SET name=?, quantity=?, expires_date=?, expiry_basis=?, updated_at=? WHERE id=?')
        .run(next.name, next.quantity, next.expires, next.basis, now().toISOString(), row.id);
      event(row.id, 'edit', row.quantity, next.quantity, null);
      return { ok: true, id: row.id, name: next.name, quantity: next.quantity, expiresOn: next.expires };
    });
  }
  function pantry({ includeGone = false } = {}) {
    const t = today();
    const rows = q(`SELECT * FROM pantry_items WHERE ${includeGone ? '1' : "status='in'"} ORDER BY expires_date, name`).all();
    const items = rows.map(r => ({ id: r.id, name: r.name, quantity: r.quantity, addedOn: r.added_date, expiresOn: r.expires_date,
      expiryBasis: r.expiry_basis, daysLeft: daysBetween(t, r.expires_date), status: r.status, note: r.note ?? undefined }));
    const inStock = items.filter(i => i.status === 'in');
    return { ok: true, date: t, count: inStock.length,
      expired: inStock.filter(i => i.daysLeft < 0).map(i => i.name),
      expiringSoon: inStock.filter(i => i.daysLeft >= 0 && i.daysLeft <= 2).map(i => i.name),
      items: includeGone ? items : inStock,
      note: '数量是记录时的说法，粗略即可；expiryBasis: stated=包装/你说的, estimate=按估计, common=按常见保质期' };
  }

  // ---------- medicine cabinet ----------
  const medRow = r => ({ id: r.id, name: r.name, aliases: JSON.parse(r.aliases), forMembers: JSON.parse(r.for_members), dose: r.dose,
    minIntervalHours: r.min_interval_hours, maxPerDay: r.max_per_day, note: r.note ?? undefined, active: !!r.active });
  function medSave({ name, aliases = [], forMembers = [], dose = '', minIntervalHours, maxPerDay, note, active = true, requestId } = {}) {
    const n = text(name, 60);
    if (!n) throw Error('name required');
    if (minIntervalHours != null && !(Number(minIntervalHours) > 0 && Number(minIntervalHours) <= 168)) throw Error('minIntervalHours must be 0–168');
    if (maxPerDay != null && !(Number.isInteger(maxPerDay) && maxPerDay > 0 && maxPerDay <= 24)) throw Error('maxPerDay must be 1–24');
    return once(requestId, () => {
      const prev = q('SELECT * FROM medications WHERE name=?').get(n);
      const id = prev?.id ?? 'med_' + randomUUID();
      const row = [id, n, JSON.stringify((Array.isArray(aliases) ? aliases : []).map(a => text(a, 40)).filter(Boolean)),
        JSON.stringify((Array.isArray(forMembers) ? forMembers : []).map(a => text(a, 40)).filter(Boolean)), text(dose, 80),
        minIntervalHours == null ? (prev?.min_interval_hours ?? null) : Number(minIntervalHours), maxPerDay ?? prev?.max_per_day ?? null,
        text(note, 300) || prev?.note || null, active ? 1 : 0, now().toISOString()];
      q(`INSERT INTO medications VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET aliases=excluded.aliases,
         for_members=excluded.for_members, dose=excluded.dose, min_interval_hours=excluded.min_interval_hours,
         max_per_day=excluded.max_per_day, note=excluded.note, active=excluded.active, updated_at=excluded.updated_at`).run(...row);
      return { ok: true, created: !prev, medication: medRow(q('SELECT * FROM medications WHERE id=?').get(id)) };
    });
  }
  const findMed = name => {
    const n = text(name, 60);
    return q('SELECT * FROM medications').all().find(r => r.name === n || JSON.parse(r.aliases).includes(n)) ?? null;
  };
  // A dose the member took. Only statebar sends these (checked against the owner's words).
  function logDose({ memberId, medication, takenAt, amount, sourceEventId, source = 'statebar', note }) {
    const at = Date.parse(takenAt);
    if (!Number.isFinite(at)) throw Error('takenAt must be an ISO time with offset');
    if (at > now().getTime() + 5 * 60000) throw Error('takenAt is in the future');
    const name = text(medication, 60);
    if (!name) throw Error('medication required');
    if (sourceEventId) {
      const prev = q('SELECT id FROM doses WHERE source_event_id=?').get(sourceEventId);
      if (prev) return { ok: true, id: prev.id, duplicate: true };
    }
    const med = findMed(name);
    const id = 'dose_' + randomUUID();
    q('INSERT INTO doses VALUES(?,?,?,?,?,?,?,?,?)').run(id, med?.id ?? null, med?.name ?? name, memberId, new Date(at).toISOString(),
      text(amount, 60) || null, source, sourceEventId ?? null, text(note, 200) || null);
    return { ok: true, id, medication: med?.name ?? name, inCabinet: !!med, duplicate: false };
  }
  // Per member: last dose of each medicine, when the next is allowed, how many in the last 24h.
  function meds({ memberId } = {}) {
    const nowMs = now().getTime();
    const cabinet = q('SELECT * FROM medications WHERE active=1 ORDER BY name').all().map(medRow);
    const rows = q(`SELECT * FROM doses WHERE taken_at >= ? ${memberId ? 'AND member_id=?' : ''} ORDER BY taken_at DESC`)
      .all(new Date(nowMs - 14 * DAY).toISOString(), ...(memberId ? [memberId] : []));
    const status = [];
    const seen = new Set();
    for (const d of rows) {
      const key = d.member_id + '\u0000' + d.medication_name;
      if (seen.has(key)) continue;
      seen.add(key);
      const med = cabinet.find(m => m.name === d.medication_name);
      const last24 = rows.filter(x => x.member_id === d.member_id && x.medication_name === d.medication_name && Date.parse(x.taken_at) > nowMs - DAY).length;
      const nextAt = med?.minIntervalHours ? Date.parse(d.taken_at) + med.minIntervalHours * 3600000 : null;
      const capped = med?.maxPerDay != null && last24 >= med.maxPerDay;
      status.push({ memberId: d.member_id, medication: d.medication_name, lastTakenAt: d.taken_at, dosesLast24h: last24,
        nextAllowedAt: nextAt ? new Date(nextAt).toISOString() : null,
        canTakeNow: capped ? false : nextAt == null ? null : nextAt <= nowMs,
        waitMinutes: nextAt && nextAt > nowMs ? Math.ceil((nextAt - nowMs) / 60000) : 0,
        note: capped ? `24 小时内已到上限 ${med.maxPerDay} 次` : med ? undefined : '药箱里没登记这种药，没有间隔可算' });
    }
    return { ok: true, cabinet, recent: status,
      note: '间隔和上限是药箱里登记的；不是医嘱，拿不准问医生或看说明书' };
  }

  // ---------- exercise ----------
  // A workout the member did. Like doses, only statebar sends these (checked against the owner's words).
  function logWorkout({ memberId, activity, date, durationMin, sourceEventId, source = 'statebar', note }) {
    const name = text(activity, 40);
    if (!name) throw Error('activity required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || date > today()) throw Error('date must be today or earlier (YYYY-MM-DD)');
    if (durationMin != null && !(Number.isInteger(durationMin) && durationMin > 0 && durationMin <= 600)) throw Error('durationMin must be 1–600');
    if (sourceEventId) {
      const prev = q('SELECT id FROM workouts WHERE source_event_id=?').get(sourceEventId);
      if (prev) return { ok: true, id: prev.id, duplicate: true };
    }
    const id = 'wo_' + randomUUID();
    q('INSERT INTO workouts VALUES(?,?,?,?,?,?,?,?,?)').run(id, memberId, date, name, durationMin ?? null, source,
      sourceEventId ?? null, text(note, 200) || null, now().toISOString());
    return { ok: true, id, activity: name, date, durationMin: durationMin ?? null, duplicate: false };
  }
  function workouts({ memberId, days = 14 } = {}) {
    if (!Number.isInteger(days) || days < 1 || days > 90) throw Error('days must be 1..90');
    const from = plusDays(today(), -(days - 1)), weekFrom = plusDays(today(), -6);
    const rows = q(`SELECT * FROM workouts WHERE date >= ? ${memberId ? 'AND member_id=?' : ''} ORDER BY date DESC, created_at DESC`)
      .all(from, ...(memberId ? [memberId] : []));
    const byMember = {};
    for (const r of rows) {
      const m = byMember[r.member_id] ??= { memberId: r.member_id, sessionsThisWeek: 0, minutesThisWeek: 0, recent: [] };
      if (r.date >= weekFrom) { m.sessionsThisWeek += 1; m.minutesThisWeek += r.duration_min ?? 0; }
      m.recent.push({ date: r.date, activity: r.activity, durationMin: r.duration_min ?? undefined });
    }
    return { ok: true, from, members: Object.values(byMember), note: '时长没说的不计入分钟数；运动只来自用户说过的话（经 statebar 核对）' };
  }

  return { pantryAdd, pantryUse, pantryDiscard, pantryEdit, pantry, medSave, logDose, meds, logWorkout, workouts };
}

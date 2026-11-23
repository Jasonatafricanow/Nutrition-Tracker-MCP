import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHomeStock } from '../home-stock.js';

// 2026-11-20 10:00 Beijing
const at = ms => () => new Date(ms);
const T0 = Date.parse('2026-11-20T10:00:00+08:00');
const stock = (now = at(T0)) => createHomeStock({ database: new DatabaseSync(':memory:'), now });

test('fridge: a receipt goes in with rough amounts and an expiry; cooking takes some out in plain words', () => {
  const s = stock();
  const r = s.pantryAdd({ source: 'receipt', requestId: 'r1', items: [
    { name: '黄瓜', quantity: '600g/4根' }, { name: '牛奶', quantity: '1L', expiresOn: '2026-11-28' }, { name: '五花肉', quantity: '500g', shelfLifeDays: 2 }] });
  assert.deepEqual(r.added.map(x => [x.name, x.expiresOn, x.expiryBasis]),
    [['黄瓜', '2026-11-25', 'common'], ['牛奶', '2026-11-28', 'stated'], ['五花肉', '2026-11-22', 'estimate']]);
  assert.equal(s.pantryAdd({ source: 'receipt', requestId: 'r1', items: [{ name: '黄瓜' }] }).duplicate, true); // retried, not twice
  assert.deepEqual(s.pantry().expiringSoon, ['五花肉']);
  const used = s.pantryUse({ name: '黄瓜', remaining: '2根', note: '拍黄瓜' });
  assert.deepEqual([used.before, used.remaining, used.usedUp], ['600g/4根', '2根', false]);
  assert.equal(s.pantryUse({ name: '黄瓜', remaining: '用完了' }).usedUp, true);
  assert.deepEqual(s.pantry().items.map(i => i.name), ['五花肉', '牛奶']);       // soonest to expire first
  assert.throws(() => s.pantryUse({ name: '黄瓜' }), /没有/);
  assert.equal(s.pantry({ includeGone: true }).items.length, 3);
});

test('fridge: an ambiguous name asks which one instead of guessing', () => {
  const s = stock();
  s.pantryAdd({ items: [{ name: '牛肉片' }, { name: '牛肉丸' }] });
  assert.throws(() => s.pantryUse({ name: '牛肉', remaining: '' }), /好几样/);
});

test('medicine: cabinet interval and daily cap give when the next dose is allowed; doses are idempotent', () => {
  let now = T0;
  const s = createHomeStock({ database: new DatabaseSync(':memory:'), now: () => new Date(now) });
  s.medSave({ name: '布洛芬混悬液', aliases: ['美林'], forMembers: ['kid'], dose: '5ml', minIntervalHours: 6, maxPerDay: 4 });
  const d = s.logDose({ memberId: 'kid', medication: '美林', takenAt: '2026-11-20T08:00:00+08:00', sourceEventId: 'e1' });
  assert.equal(d.medication, '布洛芬混悬液');
  assert.equal(s.logDose({ memberId: 'kid', medication: '美林', takenAt: '2026-11-20T08:00:00+08:00', sourceEventId: 'e1' }).duplicate, true);
  let kid = s.meds({ memberId: 'kid' }).recent[0];
  assert.deepEqual([kid.canTakeNow, kid.waitMinutes, kid.nextAllowedAt], [false, 240, '2026-11-20T06:00:00.000Z']);
  now = Date.parse('2026-11-20T14:30:00+08:00');
  kid = s.meds({ memberId: 'kid' }).recent[0];
  assert.equal(kid.canTakeNow, true);
  assert.throws(() => s.logDose({ memberId: 'kid', medication: '美林', takenAt: '2026-11-21T08:00:00+08:00' }), /future/);
  const other = s.logDose({ memberId: 'owner', medication: '感冒灵', takenAt: '2026-11-20T09:00:00+08:00', sourceEventId: 'e2' });
  assert.equal(other.inCabinet, false);                                          // still recorded; no interval to compute
  assert.equal(s.meds({ memberId: 'owner' }).recent[0].canTakeNow, null);
});

test('exercise: statebar workouts add up per member for the week; a replay is not counted twice', () => {
  const s = stock();
  s.logWorkout({ memberId: 'owner', activity: '游泳', date: '2026-11-19', durationMin: 40, sourceEventId: 'w1' });
  assert.equal(s.logWorkout({ memberId: 'owner', activity: '游泳', date: '2026-11-19', durationMin: 40, sourceEventId: 'w1' }).duplicate, true);
  s.logWorkout({ memberId: 'owner', activity: '跑步', date: '2026-11-10', sourceEventId: 'w2' });
  assert.throws(() => s.logWorkout({ memberId: 'owner', activity: '跑步', date: '2026-11-21' }), /today or earlier/);
  const me = s.workouts({ memberId: 'owner' }).members[0];
  assert.deepEqual([me.sessionsThisWeek, me.minutesThisWeek, me.recent.length], [1, 40, 2]);
});

test('medicine: doses said before the box was registered match it later; filling in the box keeps what was there; a dose can be fixed or removed on the user words', () => {
  const s = stock();
  // What happened on 11-23: two supplements said by short names, the cabinet still empty.
  const d3 = s.logDose({ memberId: 'owner', medication: 'd3', takenAt: '2026-11-20T00:33:00+08:00', amount: '1颗', sourceEventId: 'e1' });
  s.logDose({ memberId: 'owner', medication: '维生素b族', takenAt: '2026-11-20T00:33:00+08:00', amount: '1颗', sourceEventId: 'e2' });
  const saved = s.medSave({ name: '维生素D3软胶囊', aliases: ['d3', '维生素D3'], forMembers: ['owner'], dose: '每粒2000 IU' });
  assert.deepEqual(saved.dosesLinked.map(x => x.said), ['d3']);
  assert.equal(s.meds({ memberId: 'owner' }).recent.find(r => r.medication === '维生素D3软胶囊').note, '没登记用药间隔，无法判断'); // in the cabinet now
  // Filling in later: only the new field; aliases, members and dose stay.
  const id = saved.medication.id;
  const later = s.medSave({ medicationId: id, strength: '50µg' }).medication;
  assert.deepEqual([later.strength, later.aliases, later.forMembers, later.dose], ['50µg', ['d3', '维生素D3'], ['owner'], '每粒2000 IU']);
  // A second entry for the same box is refused, not made.
  assert.throws(() => s.medSave({ name: 'D3', aliases: ['d3'] }), /已经是药箱里「维生素D3软胶囊」/);
  // Corrections need the user words; the old values are kept in the edit history.
  assert.throws(() => s.fixDose({ doseId: d3.id, amount: '2颗' }), /userWords/);
  const fixed = s.fixDose({ doseId: d3.id, amount: '2颗', userWords: '那颗D3其实是两颗', by: '主助手' });
  assert.deepEqual([fixed.was.amount, fixed.now.amount, fixed.now.inCabinet], ['1颗', '2颗', true]);
  const b = s.timeline({ memberIds: ['owner'] }).members[0].events.find(e => e.medication === '维生素b族');
  assert.equal(b.inCabinet, false);
  s.fixDose({ doseId: b.doseId, remove: true, userWords: '维生素B那次记重了' });
  assert.deepEqual(s.timeline({ memberIds: ['owner'] }).members[0].events.map(e => [e.medication, e.amount]), [['维生素D3软胶囊', '2颗']]);
  assert.throws(() => s.fixDose({ doseId: b.doseId, amount: '1颗', userWords: '再改一次' }), /没有这次服药/);
});

test('medicine: a box registered by an older version still picks up its earlier doses when the plugin starts', () => {
  const database = new DatabaseSync(':memory:');
  const s = createHomeStock({ database, now: at(T0) });
  s.logDose({ memberId: 'owner', medication: 'd3', takenAt: '2026-11-20T00:33:00+08:00', sourceEventId: 'e1' });
  // As the old medSave left it: the box saved, the dose never matched.
  database.prepare("INSERT INTO medications(id,name,aliases,updated_at) VALUES('med_x','维生素D3软胶囊','[\"d3\"]','2026-11-20')").run();
  const again = createHomeStock({ database, now: at(T0) });
  assert.equal(again.timeline({ memberIds: ['owner'] }).members[0].events[0].inCabinet, true);
});

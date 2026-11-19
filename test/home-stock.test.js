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

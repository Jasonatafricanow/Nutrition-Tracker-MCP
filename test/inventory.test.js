import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createInventory, matchShelfRule, estimateFreshness } from '../inventory.js';
import { createEngine } from '../engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let CLOCK = new Date('2026-11-16T04:00:00Z'); // Monday, Asia/Shanghai 12:00
const NOW = () => { const t = CLOCK; CLOCK = new Date(CLOCK.getTime() + 1000); return t; };
function fixture(now = NOW) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nutrition-inventory-'));
  const dbPath = path.join(dir, 'inventory.db');
  const inv = createInventory({ dbPath, now, timeZone: 'Asia/Shanghai' });
  return { dir, dbPath, inv, close() { inv.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const upd = (inv, args) => inv.update(args);

test('P1/P2 receipt quantity and user supplement coexist on one batch; no unit conversion', () => {
  const f = fixture(); try {
    const r = upd(f.inv, { operation: 'purchase', name: '黄瓜', quantity: '600g', source: 'receipt', sourceRef: 'receipt-20261116-01', requestId: 'buy-cucumber' });
    assert.equal(r.ok, true);
    assert.equal(r.batch.originalQuantity, '600g');
    assert.equal(r.batch.storage, 'fridge'); // typical storage assumed for known food
    assert.equal(r.storageAssumed, true);
    // User supplements the SAME batch: "actually four cucumbers".
    const fix = upd(f.inv, { operation: 'adjust', name: '黄瓜', batchId: r.batch.batchId, quantityNote: '实际是四根', requestId: 'supplement-cucumber' });
    assert.equal(fix.batch.quantityNotes.includes('实际是四根'), true);
    assert.equal(fix.batch.remainingQuantity, '600g / 实际是四根');
    const item = f.inv.query({ view: 'item', name: '黄瓜' });
    assert.equal(item.found, true);
    assert.equal(item.item.batches[0].originalQuantity, '600g');
    assert.ok(item.item.summary.includes('600g'));
    // Open-ended quantities are stored verbatim, never normalized.
    upd(f.inv, { operation: 'purchase', name: '菠菜', quantity: '一小把', requestId: 'buy-spinach' });
    upd(f.inv, { operation: 'purchase', name: '鸡蛋', quantity: '12个', requestId: 'buy-eggs' });
    const current = f.inv.query({ view: 'current' });
    assert.equal(current.count, 3);
    assert.ok(current.items.find(x => x.name === '菠菜').remaining.includes('一小把'));
  } finally { f.close(); }
});

test('P5 consume two cucumbers leaves an approximate remainder; user restatement wins', () => {
  const f = fixture(); try {
    const buy = upd(f.inv, { operation: 'purchase', name: '黄瓜', quantity: '600g', requestId: 'b1' });
    upd(f.inv, { operation: 'adjust', batchId: buy.batch.batchId, quantityNote: '实际是四根', requestId: 's1' });
    const used = upd(f.inv, { operation: 'consume', name: '黄瓜', usedQuantity: '两根', requestId: 'use-2' });
    assert.equal(used.batch.remainingQuantity, '约2根');
    assert.equal(used.remainingQuantityBasis, 'inferred');
    assert.equal(used.batch.originalQuantity, '600g');
    assert.deepEqual(used.batch.quantitySupplements, ['实际是四根']);
    assert.equal(used.batch.status, 'active');
    // User later states the remainder directly: overrides prior description.
    const restated = upd(f.inv, { operation: 'adjust', name: '黄瓜', remainingQuantity: '2根', requestId: 'restate' });
    assert.equal(restated.batch.remainingQuantity, '2根');
    assert.equal(restated.item.summary.includes('2根'), true);
    // Batch history keeps the original purchase description for auditing.
    const item = f.inv.query({ view: 'item', name: '黄瓜' });
    assert.equal(item.item.batches[0].originalQuantity, '600g');
    assert.equal(item.recentChanges.find(c => c.operation === 'consume').detail.remainingQuantityBasis, 'inferred');
  } finally { f.close(); }
});

test('same-unit counts, decimals and half packages are deducted without converting ambiguous quantities', () => {
  const f = fixture(); try {
    for (const [name, quantity, usedQuantity, expected] of [
      ['黄瓜', '4根', '2根', '约2根'], ['鸡蛋', '10个', '三个', '约7个'],
      ['菠菜', '1袋', '半袋', '约半袋'], ['猪肉', '500g', '200g', '约300g'],
      ['牛奶', '2盒', '1盒', '约1盒'], ['大米', '2.45kg', '0.2kg', '约2.25kg'],
      ['芹菜', '一些', '一部分', '剩余不明（已用一部分）'], ['葱', '500g', '2根', '剩余不明（已用2根）'],
      ['苹果', '三四个', '一个', '剩余不明（已用一个）'], ['面包', '2袋', '2袋', '剩余不明（已用2袋）']
    ]) {
      const buy = upd(f.inv, { operation: 'purchase', name, quantity });
      const used = upd(f.inv, { operation: 'consume', batchId: buy.batch.batchId, usedQuantity });
      assert.equal(used.batch.remainingQuantity, expected, name);
      assert.equal(used.batch.originalQuantity, quantity, name);
      assert.equal(used.batch.status, 'active', name);
    }
    assert.equal(upd(f.inv, { operation: 'consume', name: '黄瓜', usedQuantity: '一根' }).batch.remainingQuantity, '约1根');
    const reported = upd(f.inv, { operation: 'consume', name: '黄瓜', usedQuantity: '半根', remainingQuantity: '还剩小半根' });
    assert.equal(reported.batch.remainingQuantity, '还剩小半根');
    assert.equal(reported.remainingQuantityBasis, 'reported');
    assert.equal(upd(f.inv, { operation: 'consume', name: '黄瓜', usedAll: true }).batch.status, 'used_up');
  } finally { f.close(); }
});

test('batches distinguish purchase dates; oldest active batch is consumed first', () => {
  const f = fixture(); try {
    const monday = upd(f.inv, { operation: 'purchase', name: '黄瓜', quantity: '四根', purchasedAt: '2026-11-16', requestId: 'mon' });
    CLOCK = new Date('2026-11-18T04:00:00Z'); // Wednesday
    const wednesday = upd(f.inv, { operation: 'purchase', name: '黄瓜', quantity: '两根', purchasedAt: '2026-11-18', requestId: 'wed' });
    assert.notEqual(monday.batch.batchId, wednesday.batch.batchId);
    const item = f.inv.query({ view: 'item', name: '黄瓜' });
    assert.equal(item.item.batchCount, 2);
    assert.deepEqual(item.item.batches.map(b => b.purchasedAt), ['2026-11-16', '2026-11-18']);
    const used = upd(f.inv, { operation: 'consume', name: '黄瓜', usedAll: true, requestId: 'finish-monday' });
    assert.equal(used.batch.batchId, monday.batch.batchId);
    assert.equal(used.batchSelection, 'oldest_active');
    assert.equal(used.batchSelectionInferred, true);
    assert.equal(used.item.batchCount, 1);
    // Explicit batchId targets the newer batch.
    const second = upd(f.inv, { operation: 'consume', batchId: wednesday.batch.batchId, usedQuantity: '一根', requestId: 'use-wed' });
    assert.equal(second.batch.batchId, wednesday.batch.batchId);
    assert.equal(second.batchSelectionInferred, false);
    const [explicit, inferred] = f.inv.query({ view: 'item', name: '黄瓜' }).recentChanges;
    assert.equal(explicit.detail.batchSelection, 'explicit');
    assert.equal(inferred.detail.batchSelection, 'oldest_active');
    assert.equal(inferred.detail.batchSelectionInferred, true);
  } finally { f.close(); CLOCK = new Date('2026-11-16T04:00:00Z'); }
});

test('requestId retries are idempotent; conflicting payload rejected; failed write is atomic', () => {
  const f = fixture(); try {
    const args = { operation: 'purchase', name: '猪肉', quantity: '500g', requestId: 'pork-1' };
    const first = upd(f.inv, args);
    const retry = upd(f.inv, { name: '猪肉', source: 'user_text', requestId: 'pork-1', quantity: '500g', operation: 'purchase' });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.batch.batchId, first.batch.batchId);
    assert.equal(f.inv.query({ view: 'current' }).count, 1);
    assert.throws(() => upd(f.inv, { ...args, quantity: '600g' }), /requestId/);
    assert.throws(() => upd(f.inv, { operation: 'consume', name: '不存在的菜', usedQuantity: '一些', requestId: 'bad-1' }), /库存中没有/);
    assert.equal(f.inv.query({ view: 'current' }).count, 1); // failed write left no trace
    assert.throws(() => upd(f.inv, { operation: 'purchase', name: '黄瓜', purchasedAt: '2026-13-99' }), /YYYY-MM-DD/);
    assert.throws(() => upd(f.inv, { operation: 'purchase', name: '黄瓜', labelExpiryDate: '2026-02-30', requestId: 'bad-date' }), /YYYY-MM-DD/);
    assert.equal(f.inv.query({ view: 'item', name: '黄瓜' }).found, false);
    assert.equal(upd(f.inv, { operation: 'purchase', name: '黄瓜', labelExpiryDate: '2028-02-29', requestId: 'bad-date' }).ok, true);
  } finally { f.close(); }
});

test('a retry paused before the write lock reuses the other connection’s committed receipt', async () => {
  const f = fixture();
  const args = { operation: 'purchase', name: '黄瓜', quantity: '两根', requestId: 'race' };
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql === 'BEGIN IMMEDIATE') {
        parentPort.postMessage('at-lock');
        Atomics.wait(workerData.gate, 0, 0, 5000);
      }
      return exec.call(this, sql);
    };
    import(workerData.module).then(({ createInventory }) => {
      const inv = createInventory({ dbPath: workerData.dbPath });
      try { parentPort.postMessage(inv.update(workerData.args)); }
      finally { inv.close(); }
    });
  `, { eval: true, workerData: { module: new URL('../inventory.js', import.meta.url).href, dbPath: f.dbPath, gate, args } });
  try {
    assert.deepEqual(await once(worker, 'message'), ['at-lock']);
    const first = f.inv.update(args);
    const response = once(worker, 'message');
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const [retry] = await response;
    assert.equal(retry.duplicate, true);
    assert.equal(retry.batch.batchId, first.batch.batchId);
    assert.equal(f.inv.query({ view: 'item', name: '黄瓜' }).recentChanges.length, 1);
  } finally {
    await worker.terminate();
    f.close();
  }
});

test('exact food aliases keep distinct foods separate and conflicting batch targets are rejected', () => {
  const f = fixture(); try {
    const buy = f.inv.update({ operation: 'purchase', name: '番茄', aliases: ['西红柿'], quantity: '两个' });
    f.inv.update({ operation: 'purchase', name: '小西红柿', quantity: '一盒' });
    assert.equal(f.inv.query({ view: 'item', name: '西红柿' }).item.itemId, buy.item.itemId);
    assert.notEqual(f.inv.query({ view: 'item', name: '小西红柿' }).item.itemId, buy.item.itemId);
    assert.throws(() => f.inv.update({ operation: 'discard', name: '黄瓜', batchId: buy.batch.batchId }), /不属于该食材/);
    assert.throws(() => f.inv.update({ operation: 'adjust', name: '小西红柿', batchId: buy.batch.batchId, status: 'discarded' }), /不属于该食材/);
    const corrected = f.inv.update({ operation: 'adjust', name: '西红柿', batchId: buy.batch.batchId, status: 'discarded' });
    assert.equal(corrected.item.state, 'discarded');
    assert.equal(corrected.batch.remainingQuantity, null);
    assert.throws(() => f.inv.update({ operation: 'adjust', batchId: buy.batch.batchId, remainingQuantity: '一个' }), /status.*active/);
    const reopened = f.inv.update({ operation: 'adjust', batchId: buy.batch.batchId, status: 'active', remainingQuantity: '一个' });
    assert.equal(reopened.batch.remainingQuantity, '一个');
    assert.equal(reopened.item.state, 'available');
    assert.equal(matchShelfRule('玉米'), null);
    assert.equal(matchShelfRule('猪肉罐头'), null);
  } finally { f.close(); }
});

test('quantity supplements are visible without a base quantity and retire even in the same millisecond', () => {
  const f = fixture(() => new Date('2026-11-16T04:00:00Z')); try {
    const first = f.inv.update({ operation: 'purchase', name: '黄瓜', quantityNote: '四根' });
    assert.equal(first.batch.remainingQuantity, '四根');
    const second = f.inv.update({ operation: 'purchase', name: '黄瓜', quantity: '600g', quantityNote: '五根' });
    assert.equal(second.batch.remainingQuantity, '600g / 五根');
    const restated = f.inv.update({ operation: 'adjust', name: '黄瓜', remainingQuantity: '约两根' });
    assert.equal(restated.batch.batchId, first.batch.batchId);
    assert.equal(restated.batch.remainingQuantity, '约两根');
    assert.deepEqual(restated.batch.quantityNotes, ['四根']);
  } finally { f.close(); }
});

test('expiry lookup uses the full requested window and preserves mixed known/unknown batches', () => {
  const f = fixture(() => new Date('2026-11-16T04:00:00Z')); try {
    const labelled = f.inv.update({ operation: 'purchase', name: '黄瓜', labelExpiryDate: '2026-11-19' });
    f.inv.update({ operation: 'purchase', name: '黄瓜', storage: 'freezer' });
    const short = f.inv.query({ view: 'expiring', withinDays: 2 });
    assert.deepEqual(short.priority, []);
    const result = f.inv.query({ view: 'expiring', withinDays: 3 });
    assert.deepEqual(result.priority.map(row => row.batchId), [labelled.batch.batchId]);
    assert.equal(result.priority[0].freshness.status, 'ok');
    assert.deepEqual(result.unknownFreshness, ['黄瓜']);
    assert.match(result.summary, /1 个/);
    const corrected = f.inv.update({ operation: 'update_condition', batchId: labelled.batch.batchId, labelExpiryDate: null });
    assert.equal(corrected.batch.freshness.useByBasis, 'estimate');
    assert.deepEqual(f.inv.query({ view: 'expiring', withinDays: 3 }).priority, []);
  } finally { f.close(); }
});

test('P3 freshness: label date wins; storage/opened/cut shift estimates; unknown stays unknown', () => {
  const f = fixture(); try {
    // Pork bought Monday, fridge => estimate ~3 days; by Wednesday it needs checking.
    upd(f.inv, { operation: 'purchase', name: '猪肉', quantity: '500g', purchasedAt: '2026-11-16', requestId: 'pork' });
    // Cucumber with a real package date far away stays ok despite age.
    upd(f.inv, { operation: 'purchase', name: '黄瓜', quantity: '600g', purchasedAt: '2026-11-16', labelExpiryDate: '2026-11-30', requestId: 'cuke' });
    // Unknown food has no rule: status unknown, never fabricated.
    upd(f.inv, { operation: 'purchase', name: '神秘酱料', quantity: '一瓶', requestId: 'sauce' });
    CLOCK = new Date('2026-11-18T04:00:00Z');
    const exp = f.inv.query({ view: 'expiring', withinDays: 3 });
    const pork = exp.priority.find(x => x.name === '猪肉');
    assert.ok(pork);
    assert.equal(pork.freshness.useByBasis, 'estimate');
    assert.equal(pork.freshness.status, 'use_soon'); // 1 day left until the estimated use-by date
    assert.equal(pork.freshness.useByDate, '2026-11-19');
    const cuke = f.inv.query({ view: 'item', name: '黄瓜' }).item.batches[0];
    assert.equal(cuke.freshness.useByBasis, 'label');
    assert.equal(cuke.freshness.status, 'ok');
    assert.ok(exp.unknownFreshness.includes('神秘酱料'));
    // Freezing uses the change date and carries forward the existing priority.
    upd(f.inv, { operation: 'update_condition', name: '猪肉', storage: 'freezer', requestId: 'freeze' });
    let porkNow = f.inv.query({ view: 'item', name: '猪肉' }).item.batches[0];
    assert.equal(porkNow.freshness.status, 'use_soon');
    assert.equal(porkNow.freshness.useByDate, '2027-02-16');
    assert.deepEqual(porkNow.storageHistory, [{ date: '2026-11-16', storage: 'fridge' }, { date: '2026-11-18', storage: 'freezer' }]);
    upd(f.inv, { operation: 'update_condition', name: '猪肉', storage: 'fridge', cut: true, opened: true, requestId: 'cut' });
    porkNow = f.inv.query({ view: 'item', name: '猪肉' }).item.batches[0];
    assert.equal(porkNow.freshness.useByDate, '2026-11-19'); // prior refrigerated allowance of one day
    assert.equal(porkNow.freshness.status, 'use_soon');
    CLOCK = new Date('2026-11-19T04:00:00Z');
    assert.equal(f.inv.query({ view: 'item', name: '猪肉' }).item.batches[0].freshness.status, 'check');
    // Direct unit checks: room-temp raw meat is same-day; no rule => unknown.
    assert.equal(estimateFreshness({ name: '鸡肉', purchasedAt: '2026-11-16', storage: 'room' }, '2026-11-16').status, 'check');
    assert.equal(estimateFreshness({ name: '外星食物', purchasedAt: '2026-11-16', storage: 'fridge' }, '2026-11-16').status, 'unknown');
    assert.equal(matchShelfRule('鸡胸肉').name, '鸡肉');
  } finally { f.close(); CLOCK = new Date('2026-11-16T04:00:00Z'); }
});

test('storage history uses the reported freeze date and keeps opened/cut and prior condition evidence', () => {
  let today = '2026-11-16';
  const f = fixture(() => new Date(`${today}T04:00:00Z`)); try {
    const buy = f.inv.update({ operation: 'purchase', name: '猪肉', opened: true, cut: true });
    const batchId = buy.batch.batchId;
    today = '2026-11-19';
    const frozen = f.inv.update({ operation: 'update_condition', batchId, storage: 'freezer', storageChangedAt: '2026-11-17' }).batch;
    assert.equal(frozen.purchasedAt, '2026-11-16');
    assert.equal(frozen.storageHistory[1].date, '2026-11-17');
    assert.equal(frozen.opened, true);
    assert.equal(frozen.cut, true);
    assert.equal(frozen.freshness.useByDate, '2027-01-01');
    assert.equal(frozen.freshness.status, 'use_soon');
    assert.equal(f.inv.query({ view: 'expiring', withinDays: 1 }).priority[0].batchId, batchId);
    today = '2026-11-26';
    const thawed = f.inv.update({ operation: 'update_condition', batchId, storage: 'fridge' }).batch;
    assert.equal(thawed.freshness.useByDate, '2026-11-27');
    assert.equal(thawed.opened && thawed.cut, true);
    assert.equal(thawed.storageHistory.length, 3);
    assert.throws(() => f.inv.update({ operation: 'update_condition', batchId, storage: 'freezer', storageChangedAt: '2026-11-25' }), /storageChangedAt/);

    const old = f.inv.update({ operation: 'purchase', name: '牛肉', purchasedAt: '2026-11-16' });
    const late = f.inv.update({ operation: 'update_condition', batchId: old.batch.batchId, storage: 'freezer' }).batch;
    assert.equal(late.freshness.status, 'check');
    const unknown = f.inv.update({ operation: 'purchase', name: '鸡肉', storage: 'unknown' });
    const moved = f.inv.update({ operation: 'update_condition', batchId: unknown.batch.batchId, storage: 'freezer' });
    assert.equal(moved.batch.freshness.status, 'unknown');
    const boughtFrozen = f.inv.update({ operation: 'purchase', name: '虾', storage: 'freezer' });
    const thawedUnknown = f.inv.update({ operation: 'update_condition', batchId: boughtFrozen.batch.batchId, storage: 'fridge' });
    assert.equal(thawedUnknown.batch.freshness.status, 'unknown');
  } finally { f.close(); }
});

test('existing SQLite batches, timestamp-only supplements and request receipts stay readable', () => {
  let today = '2026-11-16';
  const f = fixture(() => new Date(`${today}T04:00:00Z`)); try {
    const args = { operation: 'purchase', name: '猪肉', quantity: '500g', quantityNote: '实际是四盒', requestId: 'legacy-buy' };
    const { batch } = f.inv.update(args);
    today = '2026-11-20';
    f.inv.update({ operation: 'update_condition', batchId: batch.batchId, storage: 'freezer' });
    const legacy = new DatabaseSync(f.dbPath);
    try {
      const legacyHash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
      legacy.prepare('UPDATE inventory_request_receipts SET payload_hash=? WHERE request_id=?').run(legacyHash, args.requestId);
      legacy.prepare('UPDATE inventory_batches SET quantity_notes_json=? WHERE id=?')
        .run(JSON.stringify([{ text: '实际是四盒', kind: 'supplement', at: '2026-11-16T04:00:00.000Z' }]), batch.batchId);
      legacy.exec(`UPDATE inventory_changes SET detail_json=json_remove(detail_json, '$.opened', '$.cut', '$.storageChangedAt')`);
    } finally { legacy.close(); }
    assert.equal(f.inv.update(args).duplicate, true);
    const observed = f.inv.query({ view: 'item', name: '猪肉' }).item.batches[0];
    assert.deepEqual(observed.storageHistory, [{ date: '2026-11-16', storage: 'fridge' }, { date: '2026-11-20', storage: 'freezer' }]);
    assert.equal(observed.freshness.status, 'check');
    assert.equal(observed.remainingQuantity, '500g / 实际是四盒');
    assert.equal(f.inv.update({ operation: 'consume', batchId: batch.batchId, usedQuantity: '一盒' }).batch.remainingQuantity, '约3盒');
  } finally { f.close(); }
});

test('discard and availability: gone foods are queryable, never silently available', () => {
  const f = fixture(); try {
    upd(f.inv, { operation: 'purchase', name: '菠菜', quantity: '一袋', requestId: 'sp' });
    upd(f.inv, { operation: 'purchase', name: '鸡蛋', quantity: '一盒', requestId: 'eg' });
    upd(f.inv, { operation: 'discard', name: '菠菜', reason: '坏了', requestId: 'sp-bad' });
    const avail = f.inv.query({ view: 'availability', names: ['菠菜', '鸡蛋', '牛肉'] });
    assert.equal(avail.results[0].available, false);
    assert.equal(avail.results[1].available, true);
    assert.equal(avail.results[2].available, false);
    assert.equal(f.inv.query({ view: 'current' }).count, 1);
    const all = f.inv.query({ view: 'current', includeUsedUp: true });
    const spinach = all.items.find(x => x.name === '菠菜');
    assert.equal(spinach.state, 'discarded');
    assert.ok(spinach.summary.includes('丢弃'));
    // A discarded batch cannot be consumed again without explicit correction.
    assert.throws(() => upd(f.inv, { operation: 'consume', name: '菠菜', usedQuantity: '一些' }), /没有在库批次/);
  } finally { f.close(); }
});

test('P5 full menu flow: planning reads never mutate stock; cooking report updates inventory AND existing nutrition ledger', () => {
  const f = fixture(); try {
    const engine = createEngine(path.join(f.dir, 'nutrition.db'), { now: NOW, timeZone: 'Asia/Shanghai' });
    try {
      upd(f.inv, { operation: 'purchase', name: '黄瓜', quantity: '600g', source: 'receipt', requestId: 'r-cuke' });
      upd(f.inv, { operation: 'adjust', name: '黄瓜', quantityNote: '实际是四根', requestId: 'r-cuke-note' });
      upd(f.inv, { operation: 'purchase', name: '鸡蛋', quantity: '12个', requestId: 'r-eggs' });
      upd(f.inv, { operation: 'purchase', name: '猪肉', quantity: '500g', requestId: 'r-pork' });
      // Agent proposes "五菜一汤": reads only. Stock must be untouched afterwards.
      const before = JSON.stringify(f.inv.query({ view: 'current' }));
      f.inv.query({ view: 'availability', names: ['黄瓜', '鸡蛋', '猪肉', '番茄', '豆腐'] });
      f.inv.query({ view: 'expiring' });
      assert.equal(JSON.stringify(f.inv.query({ view: 'current' })), before);
      // User: cucumber too small for 拍黄瓜 -> 黄瓜炒鸡蛋 instead. Still no deduction.
      assert.equal(JSON.stringify(f.inv.query({ view: 'current' })), before);
      // User reports cooking actually happened: 黄瓜炒鸡蛋 used two cucumbers + three eggs.
      upd(f.inv, { operation: 'consume', name: '黄瓜', usedQuantity: '两根', requestId: 'cook-cuke' });
      upd(f.inv, { operation: 'consume', name: '鸡蛋', usedQuantity: '三个', requestId: 'cook-eggs' });
      const meal = engine.execute('log_estimated_meal', {
        mealSlot: '晚餐', source: 'text', requestId: 'meal-cuke-eggs',
        items: [{ name: '黄瓜炒鸡蛋', weightGrams: 250, p: 12, c: 6, f: 14 }]
      }, 'MCP_AGENT');
      assert.equal(meal.estimated, true);
      const cuke = f.inv.query({ view: 'item', name: '黄瓜' }).item;
      assert.equal(cuke.remaining[0], '约2根');
      const history = engine.execute('get_meal_history', {}, 'MCP_AGENT');
      assert.equal(history.meals.length, 1);
      // Inventory writes did NOT create extra meal entries.
      assert.equal(engine.execute('get_meal_history', {}, 'MCP_AGENT').meals.length, 1);
    } finally { engine.close(); }
  } finally { f.close(); }
});

test('real stdio MCP client: inventory tools discoverable on everyday surface and roundtrip the receipt scenario', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'inventory-mcp-'));
  const client = new Client({ name: 'inventory-e2e', version: '1' });
  const env = { ...process.env, DB_PATH: path.join(dir, 'nutrition.db'), INVENTORY_DB_PATH: path.join(dir, 'inventory.db'), PORT: '0', NUTRITION_TIME_ZONE: 'Asia/Shanghai' };
  delete env.MCP_TOOL_SURFACE;
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'server.js')], env });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw Error(r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    assert.deepEqual(catalog.tools.map(x => x.name).sort(), ['inventory_query', 'inventory_update', 'nutrition_execute', 'nutrition_query']);
    const buy = await call('inventory_update', { operation: 'purchase', name: '黄瓜', quantity: '600g', source: 'receipt', requestId: 'e2e-buy' });
    assert.equal(buy.batch.originalQuantity, '600g');
    await call('inventory_update', { operation: 'adjust', batchId: buy.batch.batchId, quantityNote: '实际是四根', requestId: 'e2e-note' });
    const item = await call('inventory_query', { view: 'item', name: '黄瓜' });
    assert.equal(item.item.batches[0].remainingQuantity, '600g / 实际是四根');
    await call('inventory_update', { operation: 'consume', name: '黄瓜', usedQuantity: '两根', requestId: 'e2e-use' });
    const current = await call('inventory_query', { view: 'current' });
    assert.equal(current.items[0].remaining[0], '约2根');
    const guide = await client.getPrompt({ name: 'nutrition_agent_workflow' });
    assert.match(guide.messages[0].content.text, /inventory_update/);
    assert.match(guide.messages[0].content.text, /NEVER deducts stock/);
    // Nutrition tools still work unchanged alongside inventory.
    const meal = await call('nutrition_execute', { operation: 'meal', args: { mealSlot: '午餐', requestId: 'e2e-meal', items: [{ name: '米饭', weightGrams: 150, foodId: 'f7' }] } });
    assert.equal(meal.estimated, true);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');
const { runChecks, startScheduler } = require('../lib/siteCheckRunner');

function makeDb(n = 3) {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  for (let i = 1; i <= n; i++) store.addSite(db, { name: `S${i}`, url: `s${i}.example.com`, created_by: 'a' });
  return db;
}
const okResult = { ok: true, http_status: 200, response_ms: 120, ssl_expires: '2027-01-01', error: null };

test('全サイトを確認して結果を保存し、確認したサイト数を返す', async () => {
  const db = makeDb(3);
  const n = await runChecks(db, { checkFn: async () => okResult, domainFn: async () => '2027-05-01' });
  assert.strictEqual(n, 3);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks').get().n, 3);
  assert.strictEqual(store.listSites(db)[0].domain_expires_auto, '2027-05-01');
});

test('1サイトが例外になっても、他のサイトは確認される', async () => {
  const db = makeDb(3);
  const calls = [];
  await runChecks(db, {
    checkFn: async (url) => { calls.push(url); if (url.includes('s2.')) throw new Error('boom'); return okResult; },
    domainFn: async () => null,
  });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks').get().n, 2);
});

test('同時に確認するのは、指定数まで', async () => {
  const db = makeDb(8);
  let active = 0, peak = 0;
  await runChecks(db, {
    concurrency: 3, domainFn: async () => null,
    checkFn: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return okResult; },
  });
  assert.ok(peak <= 3, `同時数が多すぎる: ${peak}`);
  assert.ok(peak >= 2);
});

test('指定したサイトだけを確認できる（今すぐ確認）', async () => {
  const db = makeDb(3);
  const target = store.listSites(db)[1].id;
  const seen = [];
  await runChecks(db, { siteIds: [target], checkFn: async (u) => { seen.push(u); return okResult; }, domainFn: async () => null });
  assert.deepStrictEqual(seen, ['https://s2.example.com/']);
});

test('ドメイン期限の確認は、前回から20時間たつまで再取得しない。失敗しても前の値は残る', async () => {
  const db = makeDb(1);
  let calls = 0;
  const domainFn = async () => { calls += 1; return calls === 1 ? '2027-05-01' : null; };
  const t0 = Date.parse('2026-10-15T00:00:00Z');
  await runChecks(db, { checkFn: async () => okResult, domainFn, now: t0 });
  await runChecks(db, { checkFn: async () => okResult, domainFn, now: t0 + 3600 * 1000 });
  assert.strictEqual(calls, 1);
  await runChecks(db, { checkFn: async () => okResult, domainFn, now: t0 + 21 * 3600 * 1000 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(store.listSites(db)[0].domain_expires_auto, '2027-05-01');
});

test('サイトが0件でも動く', async () => {
  const db = makeDb(0);
  assert.strictEqual(await runChecks(db, { checkFn: async () => okResult }), 0);
});

test('定期実行: 最初の待ち時間のあとと、一定間隔で実行される。重なって実行しない。止められる', async () => {
  const db = makeDb(1);
  let runs = 0, active = 0, overlap = false;
  const stop = startScheduler(db, {
    intervalMs: 30, firstDelayMs: 10,
    run: async () => { runs += 1; active += 1; if (active > 1) overlap = true; await new Promise((r) => setTimeout(r, 50)); active -= 1; },
  });
  await new Promise((r) => setTimeout(r, 200));
  stop();
  const after = runs;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(runs >= 2, `実行回数: ${runs}`);
  assert.strictEqual(overlap, false);
  assert.strictEqual(runs, after);
});

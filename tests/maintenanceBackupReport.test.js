const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');
const { judgeSite } = require('../lib/maintenanceStatus');
const { applyBackupReport, MAX_RESULTS } = require('../lib/maintenanceBackupReport');
const { createBackupApiRouter } = require('../routes/maintenanceBackupApi');

function makeDb() {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  const a = store.addSite(db, { name: 'サイトA', url: 'https://a.example.com' });
  const b = store.addSite(db, { name: 'サイトB', url: 'https://b.example.com' });
  return { db, a, b };
}
const logsOf = (db, id) => db.prepare("SELECT * FROM maintenance_logs WHERE site_id = ? AND kind = 'バックアップ' ORDER BY log_date").all(id);
const ok = (url, date, size = 5 * 1024 * 1024) => ({ url, ok: true, date, size_bytes: size });

test('旧いDBにも、PC取得の項目が一度だけ追加される', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE maintenance_sites (id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL UNIQUE)');
  ensureMaintenanceSchema(db);
  ensureMaintenanceSchema(db);
  const cols = db.prepare('PRAGMA table_info(maintenance_sites)').all().map((c) => c.name);
  for (const c of ['pc_report_at', 'pc_report_ok', 'pc_report_error', 'pc_backup_size']) assert.ok(cols.includes(c), c);
});

test('成功: バックアップの記録が「自動取得」として追加され、サイズ・受信日時が残る', () => {
  const { db, a } = makeDb();
  const r = applyBackupReport(db, { results: [ok('https://a.example.com/', '2026-10-27', Math.round(12.3 * 1024 * 1024))] });
  assert.deepStrictEqual(r, { recorded: 1, failed: 0, ignored: 0 });
  const logs = logsOf(db, a);
  assert.strictEqual(logs.length, 1);
  assert.deepStrictEqual([logs[0].log_date, logs[0].created_by, logs[0].note], ['2026-10-27', 'auto:pc-backup', 'PC取得 12.3MB']);
  const row = store.getRow(db, a, '2026-10-28');
  assert.strictEqual(row.lastBackup, '2026-10-27');
  assert.strictEqual(row.pcFetched, true);
  assert.ok(row.pcBackup.ok && row.pcBackup.size > 0);
  assert.strictEqual(row.status.parts.backup.level, 'ok');
});

test('同じサイト・同じ日付は増えずに更新される。別の日付は追加される', () => {
  const { db, a } = makeDb();
  applyBackupReport(db, { results: [ok('https://a.example.com', '2026-10-27', 1024)] });
  applyBackupReport(db, { results: [ok('https://a.example.com', '2026-10-27', 2048)] });
  assert.strictEqual(logsOf(db, a).length, 1);
  assert.strictEqual(logsOf(db, a)[0].note, 'PC取得 2KB');
  applyBackupReport(db, { results: [ok('https://a.example.com', '2026-11-03', 2048)] });
  assert.strictEqual(logsOf(db, a).length, 2);
});

test('手入力のバックアップ記録は、自動取得と別に残る', () => {
  const { db, a } = makeDb();
  store.addLog(db, a, { kind: 'バックアップ', log_date: '2026-10-27', note: '手入力', created_by: 'admin' });
  applyBackupReport(db, { results: [ok('https://a.example.com', '2026-10-27')] });
  assert.strictEqual(logsOf(db, a).length, 2);
});

test('失敗: バックアップ日付には記録せず、最後の結果として残る。分類は決まった値だけ', () => {
  const { db, a, b } = makeDb();
  const r = applyBackupReport(db, { results: [
    { url: 'https://a.example.com', ok: false, error: 'auth' },
    { url: 'https://b.example.com', ok: false, error: '/home/secret/path password=xxx' },
  ] });
  assert.deepStrictEqual(r, { recorded: 0, failed: 2, ignored: 0 });
  assert.strictEqual(logsOf(db, a).length, 0);
  assert.strictEqual(store.getSite(db, a).pc_report_error, 'auth');
  assert.strictEqual(store.getSite(db, b).pc_report_error, 'other'); // 自由な文章は保存しない
  const st = store.getRow(db, a, '2026-10-28').status;
  assert.ok(st.reasons.some((x) => x.code === 'pc_backup_failed' && x.text.includes('ログインできません')));
  assert.strictEqual(st.level === 'ok' || st.level === 'unknown' ? 'x' : st.level, 'warn');
});

test('失敗のあとに成功すると、警告は消える。成功時のサイズは失敗でも残る', () => {
  const { db, a } = makeDb();
  applyBackupReport(db, { results: [ok('https://a.example.com', '2026-10-20', 3000)] });
  applyBackupReport(db, { results: [{ url: 'https://a.example.com', ok: false, error: 'connect' }] });
  assert.strictEqual(store.getSite(db, a).pc_backup_size, 3000);
  applyBackupReport(db, { results: [ok('https://a.example.com', '2026-10-27', 4000)] });
  const row = store.getRow(db, a, '2026-10-28');
  assert.ok(!row.status.reasons.some((x) => x.code === 'pc_backup_failed'));
});

test('登録のないサイト・形式の違うものは無視して件数だけ返す。URLの表記ゆれは同じサイトとして扱う', () => {
  const { db, a } = makeDb();
  const r = applyBackupReport(db, { results: [
    ok('https://unknown.example.com', '2026-10-27'),
    { url: 'not a url', ok: true, date: '2026-10-27' },
    { url: 'https://a.example.com', ok: 'yes', date: '2026-10-27' },
    ok('https://a.example.com', '2026-13-45'),
    null,
    ok('A.EXAMPLE.COM', '2026-10-27'),
  ] });
  assert.deepStrictEqual(r, { recorded: 1, failed: 0, ignored: 5 });
  assert.strictEqual(logsOf(db, a).length, 1);
});

test('一度も結果が届いていないサイトは、PC取得について注意しない', () => {
  const { db, b } = makeDb();
  const st = store.getRow(db, b, '2026-10-28').status;
  assert.ok(!st.reasons.some((x) => x.code.startsWith('pc_backup')));
});

test('結果が14日以上届いていなければ「止まっている」と注意。13日なら注意しない', () => {
  const base = { checks: [], sslExpires: null, domainExpires: null, lastBackup: '2026-10-27', lastInspect: null };
  const at = (reportAt, today) => judgeSite({ ...base, todayStr: today, pcBackup: { reportAt, ok: true, error: null } });
  assert.ok(at('2026-10-01 03:00:00', '2026-10-15').reasons.some((x) => x.code === 'pc_backup_silent'));
  assert.ok(!at('2026-10-01 03:00:00', '2026-10-14').reasons.some((x) => x.code === 'pc_backup_silent'));
});

test('古い世代のままのサイトは、これまでどおり「バックアップが古い」警告になる', () => {
  const { db, a } = makeDb();
  store.addLog(db, a, { kind: 'バックアップ', log_date: '2026-08-01', created_by: 'auto:pc-backup' });
  const st = store.getRow(db, a, '2026-10-28').status;
  assert.ok(st.reasons.some((x) => x.code === 'backup_stale'));
});

test('形が違う本文・多すぎる件数は拒否する', () => {
  const { db } = makeDb();
  assert.throws(() => applyBackupReport(db, {}), /bad_request/);
  assert.throws(() => applyBackupReport(db, { results: 'x' }), /bad_request/);
  assert.throws(() => applyBackupReport(db, { results: new Array(MAX_RESULTS + 1).fill(null) }), /too_many/);
});

async function withApi(db, token, fn) {
  const app = express();
  app.use('/api/maintenance', createBackupApiRouter(db, { getToken: () => token }));
  const server = app.listen(0);
  try {
    const post = (body, headers = {}, raw = false) =>
      fetch(`http://127.0.0.1:${server.address().port}/api/maintenance/backup-report`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw ? body : JSON.stringify(body),
      });
    return await fn(post);
  } finally {
    server.close();
  }
}

test('受け口: トークンがなければ拒否。未設定なら受け付けない。正しいトークンなら記録する', async () => {
  const { db, a } = makeDb();
  const body = { results: [ok('https://a.example.com', '2026-10-27')] };
  await withApi(db, 'dummy-token-1234', async (post) => {
    assert.strictEqual((await post(body)).status, 401);
    assert.strictEqual((await post(body, { Authorization: 'Bearer wrong' })).status, 401);
    assert.strictEqual((await post(body, { Authorization: 'dummy-token-1234' })).status, 401);
    assert.strictEqual(logsOf(db, a).length, 0);
    const res = await post(body, { Authorization: 'Bearer dummy-token-1234' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, recorded: 1, failed: 0, ignored: 0 });
    assert.strictEqual(logsOf(db, a).length, 1);
  });
  await withApi(db, '', async (post) => {
    assert.strictEqual((await post(body, { Authorization: 'Bearer ' })).status, 503);
  });
});

test('受け口: 壊れたJSON・形の違う本文は400、大きすぎる本文は413（JSONで返す）', async () => {
  const { db } = makeDb();
  const auth = { Authorization: 'Bearer dummy-token-1234' };
  await withApi(db, 'dummy-token-1234', async (post) => {
    const broken = await post('{oops', auth, true);
    assert.strictEqual(broken.status, 400);
    assert.deepStrictEqual(await broken.json(), { error: 'bad_request' });
    assert.strictEqual((await post({ nothing: 1 }, auth)).status, 400);
    const big = await post({ results: [], pad: 'x'.repeat(200 * 1024) }, auth);
    assert.strictEqual(big.status, 413);
  });
});

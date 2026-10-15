const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');

function makeDb() {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  return db;
}
const site = (over = {}) => ({ name: 'テスト', url: 'example.com', server_name: 's1', client_type: 'client', is_wordpress: true, created_by: 'admin', ...over });

test('スキーマは何度実行しても安全', () => {
  const db = makeDb();
  ensureMaintenanceSchema(db);
  assert.strictEqual(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'maintenance_%'").get().n >= 3, true);
});

test('サイトの追加: URLは正規化され、同じURLの二重登録は断る', () => {
  const db = makeDb();
  const id = store.addSite(db, site({ url: 'HTTPS://Example.com' }));
  assert.strictEqual(store.getSite(db, id).url, 'https://example.com/');
  assert.throws(() => store.addSite(db, site({ url: 'example.com/' })), /すでに登録/);
});

test('入力の検証: 名前が空・長すぎる／種別・日付・メモが不正', () => {
  assert.throws(() => store.cleanSiteFields(site({ name: '  ' })), /名前/);
  assert.throws(() => store.cleanSiteFields(site({ name: 'あ'.repeat(101) })), /名前/);
  assert.throws(() => store.cleanSiteFields(site({ client_type: 'x' })), /種別/);
  assert.throws(() => store.cleanSiteFields(site({ domain_expires_manual: '2026/13/40' })), /日付/);
  assert.throws(() => store.cleanSiteFields(site({ memo: 'あ'.repeat(501) })), /メモ/);
  const ok = store.cleanSiteFields(site({ domain_expires_manual: '', memo: '  メモ  ', is_wordpress: false }));
  assert.strictEqual(ok.domain_expires_manual, null);
  assert.strictEqual(ok.memo, 'メモ');
  assert.strictEqual(ok.is_wordpress, 0);
});

test('サイトを消すと、確認履歴と点検記録も消える', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  store.recordCheck(db, id, { ok: 1, http_status: 200, response_ms: 100, ssl_expires: null, error: null });
  store.addLog(db, id, { log_date: '2026-10-13', kind: '点検', note: '確認', created_by: 'admin' });
  store.deleteSite(db, id);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks').get().n, 0);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_logs').get().n, 0);
});

test('確認履歴は新しい順で、1サイト200件を超えた古いものから消える', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  for (let i = 0; i < 205; i++) store.recordCheck(db, id, { ok: 1, http_status: 200, response_ms: i, ssl_expires: null, error: null });
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks WHERE site_id=?').get(id).n, store.HISTORY_LIMIT);
  assert.strictEqual(store.latestChecks(db, id, 1)[0].response_ms, 204);
  assert.strictEqual(store.listChecks(db, id).length, 30);
});

test('点検記録: 種類・日付を検証し、バックアップ・点検の最新日が一覧の行に出る', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  assert.throws(() => store.addLog(db, id, { log_date: '2026-10-13', kind: '謎', note: '', created_by: 'a' }), /種類/);
  assert.throws(() => store.addLog(db, id, { log_date: 'きのう', kind: '点検', note: '', created_by: 'a' }), /日付/);
  assert.throws(() => store.addLog(db, id, { log_date: '2026-10-13', kind: '点検', note: 'あ'.repeat(1001), created_by: 'a' }), /内容/);
  store.addLog(db, id, { log_date: '2026-10-01', kind: 'バックアップ', note: '', created_by: 'a' });
  store.addLog(db, id, { log_date: '2026-10-12', kind: 'バックアップ', note: '', created_by: 'a' });
  store.addLog(db, id, { log_date: '2026-10-13', kind: '点検', note: '', created_by: 'a' });
  const row = store.getRow(db, id, '2026-10-15');
  assert.strictEqual(row.lastBackup, '2026-10-12');
  assert.strictEqual(row.lastInspect, '2026-10-13');
  assert.strictEqual(store.listLogs(db, id)[0].log_date, '2026-10-13');
});

test('点検記録の削除は、指定したサイトの記録だけ（別サイトの記録は消えない）', () => {
  const db = makeDb();
  const a = store.addSite(db, site({ url: 'a.example.com' }));
  const b = store.addSite(db, site({ url: 'b.example.com' }));
  const logB = store.addLog(db, b, { log_date: '2026-10-13', kind: '点検', note: '', created_by: 'a' });
  store.deleteLog(db, logB, a);
  assert.strictEqual(store.listLogs(db, b).length, 1);
  store.deleteLog(db, logB, b);
  assert.strictEqual(store.listLogs(db, b).length, 0);
});

test('ドメイン期限は、手入力が優先。自動取得に失敗（null）しても、前の値を消さない', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  store.setDomainAuto(db, id, '2027-01-01', '2026-10-15T00:00:00Z');
  store.setDomainAuto(db, id, null, '2026-10-16T00:00:00Z');
  assert.strictEqual(store.getSite(db, id).domain_expires_auto, '2027-01-01');
  assert.strictEqual(store.getRow(db, id, '2026-10-15').domainExpires, '2027-01-01');
  store.updateSite(db, id, site({ domain_expires_manual: '2026-12-01' }));
  assert.strictEqual(store.getRow(db, id, '2026-10-15').domainExpires, '2026-12-01');
});

test('一覧: 状態が重い順に並ぶ。0件でも動く。一度も確認していないサイトは「未確認」', () => {
  const db = makeDb();
  assert.deepStrictEqual(store.overview(db, '2026-10-15'), []);
  const a = store.addSite(db, site({ name: 'A', url: 'a.example.com' }));
  const b = store.addSite(db, site({ name: 'B', url: 'b.example.com' }));
  const c = store.addSite(db, site({ name: 'C', url: 'c.example.com' }));
  store.recordCheck(db, b, { ok: 1, http_status: 200, response_ms: 100, ssl_expires: null, error: null });
  store.recordCheck(db, c, { ok: 0, http_status: null, response_ms: 10000, ssl_expires: null, error: 'timeout' });
  store.recordCheck(db, c, { ok: 0, http_status: null, response_ms: 10000, ssl_expires: null, error: 'timeout' });
  const rows = store.sortOverview(store.overview(db, '2026-10-15'));
  assert.deepStrictEqual(rows.map((r) => [r.site.name, r.status.label]), [['C', '応答なし'], ['A', '未確認'], ['B', '稼働中']]);
  assert.ok(a && b);
});

test('集計: 要対応・期限が近い・最終確認・24時間以上更新なしの注意', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.strictEqual(store.summarize([], now).stale, false);
  const id = store.addSite(db, site());
  store.updateSite(db, id, site({ domain_expires_manual: '2026-10-25' }));
  let s = store.summarize(store.overview(db, '2026-10-15'), now);
  // 一度も確認していないだけのときは、「24時間以上更新なし」とは言わない（まだ確認待ち）
  assert.deepStrictEqual([s.total, s.urgent, s.expiring, s.lastCheckedAt, s.stale, s.pending], [1, 0, 1, null, false, true]);
  db.prepare("INSERT INTO maintenance_checks (site_id, checked_at, ok, http_status, response_ms) VALUES (?, '2026-10-15 11:00:00', 1, 200, 100)").run(id);
  s = store.summarize(store.overview(db, '2026-10-15'), now);
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.lastCheckedAt, '2026-10-15 11:00:00');
  assert.strictEqual(store.summarize(store.overview(db, '2026-10-15'), now + 25 * 3600 * 1000).stale, true);
});

test('【レビュー指摘I-3】確認が1件もない間は pending（確認待ち）。確認があって古いときだけ stale', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.deepStrictEqual(
    [store.summarize([], now).stale, store.summarize([], now).pending], [false, false]);
  const id = store.addSite(db, site());
  const fresh = store.summarize(store.overview(db, '2026-10-15'), now);
  assert.deepStrictEqual([fresh.stale, fresh.pending], [false, true]);
  db.prepare("INSERT INTO maintenance_checks (site_id, checked_at, ok, http_status, response_ms) VALUES (?, '2026-10-13 09:00:00', 1, 200, 100)").run(id);
  const old = store.summarize(store.overview(db, '2026-10-15'), now);
  assert.deepStrictEqual([old.stale, old.pending], [true, false]);
});

test('【レビュー指摘I-2】証明書の期限は、最後に取れた値を使う（確認の失敗が続いても、期限切れの表示が消えない）', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  store.recordCheck(db, id, { ok: 1, http_status: 200, response_ms: 100, ssl_expires: '2026-10-14', error: null });
  for (let i = 0; i < 4; i++) store.recordCheck(db, id, { ok: 0, http_status: null, response_ms: 50, ssl_expires: null, error: 'tls' });
  const row = store.getRow(db, id, '2026-10-15');
  assert.strictEqual(row.sslExpires, '2026-10-14');
  assert.ok(row.status.reasons.some((r) => r.code === 'ssl_expiry' && /期限切れ/.test(r.text)));
  assert.ok(row.status.reasons.some((r) => r.code === 'tls'));
  assert.ok(!row.status.reasons.some((r) => r.code === 'down'));
});

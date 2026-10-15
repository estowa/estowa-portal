const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');
const { avatarFor } = require('../lib/avatar');
const { formatJst } = require('../lib/jst');
const { createMaintenanceRouter } = require('../routes/maintenance');

const ADMIN = { user_id: 'admin', display_name: '管理者', role: 'admin' };
const MEMBER = { user_id: 'm1', display_name: 'メンバー', role: 'member' };

function makeDb() {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  return db;
}

async function withApp(db, user, opts, fn) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = user ? { user } : {};
    res.locals.currentUser = user || null;
    res.locals.currentUserAvatar = user ? avatarFor(user) : null;
    res.locals.formatJst = formatJst;
    next();
  });
  app.use(createMaintenanceRouter(db, opts));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const post = (base, p, body) => fetch(base + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const seed = (db, over = {}) => store.addSite(db, { name: '試験サイト', url: 'example.com', server_name: 'ss1', created_by: 'admin', ...over });

test('サイトが0件でも一覧が表示される。メンバーには追加ボタンが出ない', async () => {
  const db = makeDb();
  await withApp(db, MEMBER, {}, async (base) => {
    const res = await fetch(base + '/maintenance');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /サイト保守/);
    assert.match(html, /管理者が登録します/);
    assert.ok(!html.includes('+ サイトを追加'));
  });
});

test('管理者の一覧には追加ボタンが出る。0件のときは、追加への案内が出る', async () => {
  await withApp(makeDb(), ADMIN, {}, async (base) => {
    const html = await (await fetch(base + '/maintenance')).text();
    assert.match(html, /\+ サイトを追加/);
    assert.match(html, /まとめて追加/);
  });
});

test('一度も確認していないサイトは「未確認」、2回連続失敗のサイトは「応答なし」と出る', async () => {
  const db = makeDb();
  seed(db, { name: 'まだ', url: 'a.example.com' });
  const down = seed(db, { name: '落ちてる', url: 'b.example.com' });
  for (let i = 0; i < 2; i++) store.recordCheck(db, down, { ok: 0, http_status: null, response_ms: 10000, ssl_expires: null, error: 'timeout' });
  await withApp(db, MEMBER, {}, async (base) => {
    const html = await (await fetch(base + '/maintenance')).text();
    assert.match(html, /未確認/);
    assert.match(html, /応答なし/);
    assert.ok(html.indexOf('落ちてる') < html.indexOf('まだ'), '要対応が上に並ぶ');
  });
});

test('全サイトが失敗していても一覧は崩れない（要対応の件数に反映）', async () => {
  const db = makeDb();
  for (const n of ['a', 'b']) {
    const id = seed(db, { name: n, url: `${n}.example.com` });
    for (let i = 0; i < 2; i++) store.recordCheck(db, id, { ok: 0, http_status: 500, response_ms: 50, ssl_expires: null, error: null });
  }
  await withApp(db, ADMIN, {}, async (base) => {
    const res = await fetch(base + '/maintenance');
    assert.strictEqual(res.status, 200);
  });
});

test('未ログインは、ログイン画面へ。メンバーの変更操作は、すべて403で何も変わらない', async () => {
  const db = makeDb();
  const id = seed(db);
  await withApp(db, null, {}, async (base) => {
    const res = await fetch(base + '/maintenance', { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });
  let ran = 0;
  await withApp(db, MEMBER, { runChecksFn: async () => { ran += 1; } }, async (base) => {
    const gets = ['/maintenance/new', '/maintenance/bulk', `/maintenance/${id}/edit`];
    for (const g of gets) assert.strictEqual((await fetch(base + g)).status, 403, g);
    const posts = [
      ['/maintenance', { name: 'x', url: 'x.example.com' }],
      ['/maintenance/bulk', { text: 'A,a.example.com', confirm: '1' }],
      [`/maintenance/${id}`, { name: 'x', url: 'x.example.com' }],
      [`/maintenance/${id}/delete`, {}],
      [`/maintenance/${id}/check`, {}],
      [`/maintenance/${id}/logs`, { log_date: '2026-10-15', kind: '点検', note: 'x' }],
      [`/maintenance/${id}/logs/1/delete`, {}],
    ];
    for (const [p, b] of posts) assert.strictEqual((await post(base, p, b)).status, 403, p);
  });
  assert.strictEqual(ran, 0);
  assert.strictEqual(store.listSites(db).length, 1);
  assert.strictEqual(store.getSite(db, id).name, '試験サイト');
  assert.strictEqual(store.listLogs(db, id).length, 0);
});

test('管理者がサイトを追加できる。重複・不正なURLは、画面に理由が出て追加されない', async () => {
  const db = makeDb();
  await withApp(db, ADMIN, {}, async (base) => {
    const ok = await post(base, '/maintenance', { name: '新サイト', url: 'new.example.com', server_name: 'ss1', client_type: 'own', is_wordpress: '1' });
    assert.strictEqual(ok.status, 302);
    assert.strictEqual(store.listSites(db).length, 1);
    const dup = await post(base, '/maintenance', { name: '二重', url: 'https://NEW.example.com', client_type: 'client' });
    assert.strictEqual(dup.status, 200);
    assert.match(await dup.text(), /すでに登録/);
    const bad = await post(base, '/maintenance', { name: '悪い', url: 'ftp://x.example.com', client_type: 'client' });
    assert.strictEqual(bad.status, 200);
    assert.strictEqual(store.listSites(db).length, 1);
  });
});

test('まとめて追加: 確認画面では登録されず、確定すると、正しい行だけ登録される', async () => {
  const db = makeDb();
  const text = 'A,a.example.com,ss1,自社\nB,ftp://b.example.com\nC,c.example.com';
  await withApp(db, ADMIN, {}, async (base) => {
    const preview = await post(base, '/maintenance/bulk', { text });
    assert.strictEqual(preview.status, 200);
    const html = await preview.text();
    assert.match(html, /2件/);
    assert.match(html, /2行目/);
    assert.strictEqual(store.listSites(db).length, 0);
    const done = await post(base, '/maintenance/bulk', { text, confirm: '1' });
    assert.strictEqual(done.status, 302);
    assert.deepStrictEqual(store.listSites(db).map((s) => s.name), ['A', 'C']);
  });
});

test('詳細: 点検記録の追加・削除ができ、バックアップ最終日が反映される。サイトの削除もできる', async () => {
  const db = makeDb();
  const id = seed(db);
  await withApp(db, ADMIN, {}, async (base) => {
    const r = await post(base, `/maintenance/${id}/logs`, { log_date: '2026-10-12', kind: 'バックアップ', note: '手動で確認' });
    assert.strictEqual(r.status, 302);
    const html = await (await fetch(`${base}/maintenance/${id}`)).text();
    assert.match(html, /手動で確認/);
    assert.match(html, /バックアップ/);
    const bad = await post(base, `/maintenance/${id}/logs`, { log_date: 'きのう', kind: '点検', note: '' });
    assert.strictEqual(bad.status, 200);
    const logId = store.listLogs(db, id)[0].id;
    assert.strictEqual((await post(base, `/maintenance/${id}/logs/${logId}/delete`, {})).status, 302);
    assert.strictEqual(store.listLogs(db, id).length, 0);
    assert.strictEqual((await post(base, `/maintenance/${id}/delete`, {})).status, 302);
    assert.strictEqual(store.listSites(db).length, 0);
    assert.strictEqual((await fetch(`${base}/maintenance/${id}`)).status, 404);
  });
});

test('今すぐ確認: 実行され、30秒以内の連続実行は、実行されない', async () => {
  const db = makeDb();
  const id = seed(db);
  let ran = 0;
  const opts = {
    nowFn: () => Date.parse('2026-10-15T12:00:00Z'),
    runChecksFn: async (d, o) => { ran += 1; store.recordCheck(d, o.siteIds[0], { ok: 1, http_status: 200, response_ms: 50, ssl_expires: null, error: null }); },
  };
  await withApp(db, ADMIN, opts, async (base) => {
    const first = await post(base, `/maintenance/${id}/check`, {});
    assert.match(first.headers.get('location'), /notice=checked/);
    db.prepare("UPDATE maintenance_checks SET checked_at='2026-10-15 11:59:50'").run();
    const second = await post(base, `/maintenance/${id}/check`, {});
    assert.match(second.headers.get('location'), /notice=wait/);
    assert.strictEqual(ran, 1);
    db.prepare("UPDATE maintenance_checks SET checked_at='2026-10-15 11:59:00'").run();
    await post(base, `/maintenance/${id}/check`, {});
    assert.strictEqual(ran, 2);
  });
});

test('存在しないサイトは404。メモ欄の文字はエスケープされる', async () => {
  const db = makeDb();
  const id = seed(db, { memo: '<script>alert(1)</script>' });
  await withApp(db, MEMBER, {}, async (base) => {
    assert.strictEqual((await fetch(base + '/maintenance/9999')).status, 404);
    const html = await (await fetch(`${base}/maintenance/${id}`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const SessionStore = require('../lib/sessionStore');

function newStore() {
  return new SessionStore({ file: ':memory:' });
}

const call = (fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))));

test('保存したセッションを取り出せる', async () => {
  const s = newStore();
  await call((cb) => s.set('a', { cookie: { maxAge: 60000 }, user: { id: 1 } }, cb));
  const got = await call((cb) => s.get('a', cb));
  assert.deepStrictEqual(got.user, { id: 1 });
});

test('存在しないセッションは null', async () => {
  const s = newStore();
  assert.strictEqual(await call((cb) => s.get('none', cb)), null);
});

test('期限切れのセッションは取り出せない', async () => {
  const s = newStore();
  await call((cb) => s.set('a', { cookie: { maxAge: -1000 }, x: 1 }, cb));
  assert.strictEqual(await call((cb) => s.get('a', cb)), null);
});

test('destroy で消える', async () => {
  const s = newStore();
  await call((cb) => s.set('a', { cookie: { maxAge: 60000 } }, cb));
  await call((cb) => s.destroy('a', cb));
  assert.strictEqual(await call((cb) => s.get('a', cb)), null);
});

test('touch で期限が延びる', async () => {
  const s = newStore();
  await call((cb) => s.set('a', { cookie: { maxAge: 1000 } }, cb));
  const later = new Date(Date.now() + 3600000);
  await call((cb) => s.touch('a', { cookie: { expires: later } }, cb));
  const row = s.db.prepare('SELECT expired FROM sessions WHERE sid = ?').get('a');
  assert.strictEqual(row.expired, later.getTime());
});

test('connect-sqlite3 形式の既存データ（sid, expired, sess）を読める', async () => {
  const s = newStore();
  s.db
    .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    .run('old', Date.now() + 60000, JSON.stringify({ cookie: {}, user: { id: 9 } }));
  const got = await call((cb) => s.get('old', cb));
  assert.strictEqual(got.user.id, 9);
});

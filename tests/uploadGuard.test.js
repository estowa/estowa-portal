const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { createUploadGuard } = require('../lib/uploadGuard');

function setup() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, user_id TEXT, display_name TEXT, role TEXT)');
  db.prepare('INSERT INTO users (id, user_id, display_name, role) VALUES (1, ?, ?, ?)').run('taro', 'Taro', 'member');
  return { db, guard: createUploadGuard(db) };
}

function run(guard, session) {
  const out = { nexted: false, status: null, body: null };
  const res = {
    status(s) { out.status = s; return this; },
    type() { return this; },
    send(b) { out.body = b; },
  };
  guard({ session }, res, () => { out.nexted = true; });
  return out;
}

test('ログインしていなければ 401 で、ファイルは渡さない', () => {
  const { guard } = setup();
  const r = run(guard, {});
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 401);
});

test('セッション自体がなくても 401', () => {
  const { guard } = setup();
  assert.strictEqual(run(guard, undefined).status, 401);
});

test('ログイン中なら通す', () => {
  const { guard } = setup();
  const r = run(guard, { user: { id: 1, user_id: 'taro', display_name: 'Taro', role: 'member' } });
  assert.strictEqual(r.nexted, true);
});

test('削除済みユーザーのセッションは 401 で、ログイン情報も消す', () => {
  const { guard } = setup();
  const session = { user: { id: 9, user_id: 'gone', display_name: 'Gone', role: 'member' } };
  const r = run(guard, session);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(session.user, undefined);
});

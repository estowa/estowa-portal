const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { getRemoteUser, setRemoteUser, canPair, peersOf } = require('../lib/chatRules');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x',
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
  )`);
  ensureChatSchema(db);
  for (const [uid, name] of [['home', '在宅'], ['a', '社内A'], ['b', '社内B'], ['c', '社内C']]) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, name);
  }
  return db;
}
const idOf = (db, uid) => db.prepare('SELECT id FROM users WHERE user_id = ?').get(uid).id;

test('在宅未設定の間は誰も話せない', () => {
  const db = makeDb();
  assert.strictEqual(getRemoteUser(db), null);
  assert.strictEqual(canPair(db, 'home', 'a'), false);
  assert.deepStrictEqual(peersOf(db, 'a'), []);
});

test('在宅×社内は話せる、社内同士は話せない', () => {
  const db = makeDb();
  setRemoteUser(db, idOf(db, 'home'));
  assert.strictEqual(canPair(db, 'home', 'a'), true);
  assert.strictEqual(canPair(db, 'b', 'home'), true);
  assert.strictEqual(canPair(db, 'a', 'b'), false);
  assert.strictEqual(canPair(db, 'a', 'a'), false);
  assert.strictEqual(canPair(db, 'home', 'ghost'), false);
});

test('在宅フラグは常に1人だけ（移すと前の人は社内に戻る）', () => {
  const db = makeDb();
  setRemoteUser(db, idOf(db, 'home'));
  setRemoteUser(db, idOf(db, 'a'));
  assert.strictEqual(getRemoteUser(db).user_id, 'a');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users WHERE is_remote = 1').get().c, 1);
  setRemoteUser(db, null);
  assert.strictEqual(getRemoteUser(db), null);
});

test('相手一覧: 在宅は全社内、社内は在宅1人', () => {
  const db = makeDb();
  setRemoteUser(db, idOf(db, 'home'));
  assert.deepStrictEqual(peersOf(db, 'home').map((u) => u.user_id), ['a', 'b', 'c']);
  assert.deepStrictEqual(peersOf(db, 'a').map((u) => u.user_id), ['home']);
});

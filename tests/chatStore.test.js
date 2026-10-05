const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const store = require('../lib/chatStore');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensureChatSchema(db);
  return db;
}

test('保存した本文は前後の空白が除かれ、JST表示の時刻が付く', () => {
  const db = makeDb();
  const m = store.saveMessage(db, 'home', 'a', '  こんにちは  ');
  assert.strictEqual(m.body, 'こんにちは');
  assert.strictEqual(m.sender_id, 'home');
  assert.strictEqual(m.read, false);
  assert.match(m.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('空と2000文字超は拒否する', () => {
  const db = makeDb();
  assert.throws(() => store.saveMessage(db, 'home', 'a', '   '), /empty/);
  assert.throws(() => store.saveMessage(db, 'home', 'a', undefined), /empty/);
  assert.throws(() => store.saveMessage(db, 'home', 'a', 'あ'.repeat(2001)), /too_long/);
  assert.doesNotThrow(() => store.saveMessage(db, 'home', 'a', 'あ'.repeat(2000)));
});

test('HTMLを含む本文もそのまま保存する（表示側でテキスト扱い）', () => {
  const db = makeDb();
  const m = store.saveMessage(db, 'a', 'home', '<script>alert(1)</script>');
  assert.strictEqual(m.body, '<script>alert(1)</script>');
});

test('一覧は2人の間の会話だけを古い順に返す', () => {
  const db = makeDb();
  store.saveMessage(db, 'home', 'a', '1');
  store.saveMessage(db, 'a', 'home', '2');
  store.saveMessage(db, 'home', 'b', '別の人');
  const list = store.listMessages(db, 'home', 'a');
  assert.deepStrictEqual(list.map((m) => m.body), ['1', '2']);
});

test('一覧はlimit件の最新分を返す', () => {
  const db = makeDb();
  for (let i = 1; i <= 5; i++) store.saveMessage(db, 'home', 'a', String(i));
  assert.deepStrictEqual(store.listMessages(db, 'home', 'a', 3).map((m) => m.body), ['3', '4', '5']);
});

test('未読数は受信者ごと・送信者ごとに数え、既読にすると減る', () => {
  const db = makeDb();
  store.saveMessage(db, 'a', 'home', 'x');
  store.saveMessage(db, 'a', 'home', 'y');
  store.saveMessage(db, 'b', 'home', 'z');
  store.saveMessage(db, 'home', 'a', '自分が送ったもの');
  assert.deepStrictEqual(store.unreadCounts(db, 'home'), { a: 2, b: 1 });
  store.markRead(db, 'home', 'a');
  assert.deepStrictEqual(store.unreadCounts(db, 'home'), { b: 1 });
  assert.deepStrictEqual(store.unreadCounts(db, 'a'), { home: 1 });
});

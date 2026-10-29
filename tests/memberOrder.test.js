const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ORDER_SQL, ensureMemberOrder } = require('../lib/memberOrder');

function makeDb(ids) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, display_name TEXT)');
  ids.forEach((u) => db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(u, u));
  return db;
}
const order = (db) => db.prepare(`SELECT users.user_id FROM users ORDER BY ${ORDER_SQL}`).all().map((r) => r.user_id);

test('決めた順に並び、それ以外の人は後ろに登録順で並ぶ', () => {
  const db = makeDb(['yamaguchi', 'kudo', 'shiroto', 'kikuchi', 'ueda', 'kogawa', 'newbie1', 'newbie2']);
  ensureMemberOrder(db);
  assert.deepStrictEqual(order(db), ['yamaguchi', 'shiroto', 'ueda', 'kikuchi', 'kudo', 'kogawa', 'newbie1', 'newbie2']);
});

test('2回呼んでも、あとから変えた順を上書きしない', () => {
  const db = makeDb(['yamaguchi', 'kudo']);
  ensureMemberOrder(db);
  db.prepare("UPDATE users SET sort_order = 99 WHERE user_id = 'yamaguchi'").run();
  ensureMemberOrder(db);
  assert.deepStrictEqual(order(db), ['kudo', 'yamaguchi']);
});

test('一部の人がいなくても動く', () => {
  const db = makeDb(['kogawa', 'admin']);
  ensureMemberOrder(db);
  assert.deepStrictEqual(order(db), ['kogawa', 'admin']);
});

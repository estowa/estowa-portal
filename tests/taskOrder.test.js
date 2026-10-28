const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { TASK_ORDER_SQL, placeTask } = require('../lib/taskOrder');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT NOT NULL DEFAULT 'todo',
    board TEXT NOT NULL DEFAULT 'company', due_at TEXT, sort_order REAL)`);
  return db;
}
const add = (db, title, status = 'todo', due = null, board = 'company') =>
  db.prepare('INSERT INTO tasks (title, status, due_at, board) VALUES (?, ?, ?, ?)').run(title, status, due, board).lastInsertRowid;
const column = (db, status, board = 'company') =>
  db.prepare(`SELECT title FROM tasks WHERE board = ? AND status = ? ORDER BY ${TASK_ORDER_SQL}`).all(board, status).map((r) => r.title);

test('並べ替えていない列は、従来どおり締切日の順（締切なしは最後）', () => {
  const db = makeDb();
  add(db, 'B', 'todo', '2026-11-02T10:00');
  add(db, 'なし');
  add(db, 'A', 'todo', '2026-11-01T10:00');
  assert.deepStrictEqual(column(db, 'todo'), ['A', 'B', 'なし']);
});

test('列の中で、指定したカードの手前へ移せる。末尾へも移せる', () => {
  const db = makeDb();
  const a = add(db, 'A', 'todo', '2026-11-01T00:00'), b = add(db, 'B', 'todo', '2026-11-02T00:00'), c = add(db, 'C', 'todo', '2026-11-03T00:00');
  placeTask(db, c, 'todo', a); // CをAの手前へ
  assert.deepStrictEqual(column(db, 'todo'), ['C', 'A', 'B']);
  placeTask(db, c, 'todo', ''); // Cを末尾へ
  assert.deepStrictEqual(column(db, 'todo'), ['A', 'B', 'C']);
  placeTask(db, a, 'todo', c); // AをCの手前（Bの後ろ）へ
  assert.deepStrictEqual(column(db, 'todo'), ['B', 'A', 'C']);
  assert.ok(b);
});

test('別の列へ移すと、置いた位置に入る。元の列の並びは崩れない', () => {
  const db = makeDb();
  const a = add(db, 'A', 'todo', '2026-11-01T00:00'), b = add(db, 'B', 'todo', '2026-11-02T00:00');
  const x = add(db, 'X', 'doing', '2026-11-01T00:00'), y = add(db, 'Y', 'doing', '2026-11-02T00:00');
  placeTask(db, a, 'doing', y);
  db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").run(a); // ルート側でステータスも更新する
  assert.deepStrictEqual(column(db, 'doing'), ['X', 'A', 'Y']);
  assert.deepStrictEqual(column(db, 'todo'), ['B']);
  assert.ok(b && x);
});

test('新しく作ったタスク（並び順なし）は、並べ替え済みの列の一番上に出る', () => {
  const db = makeDb();
  const a = add(db, 'A', 'todo', '2026-11-01T00:00'), b = add(db, 'B', 'todo', '2026-11-02T00:00');
  placeTask(db, b, 'todo', a);
  add(db, '新規');
  assert.deepStrictEqual(column(db, 'todo'), ['新規', 'B', 'A']);
});

test('別のボード（プロジェクト）のタスクには影響しない。存在しないタスクはエラー', () => {
  const db = makeDb();
  const a = add(db, 'A'), p = add(db, 'P', 'todo', null, 'project');
  placeTask(db, a, 'todo', '');
  assert.strictEqual(db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(p).sort_order, null);
  assert.throws(() => placeTask(db, 999, 'todo', ''), /not_found/);
});

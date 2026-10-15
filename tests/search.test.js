const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { searchAll, splitTerms, escapeLike, makeSnippet } = require('../lib/search');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, description TEXT, status TEXT, board TEXT);
    CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
    CREATE TABLE knowledge_articles (id INTEGER PRIMARY KEY, category TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE TABLE ideas (id INTEGER PRIMARY KEY, category TEXT, title TEXT, body TEXT, updated_at TEXT);
  `);
  db.prepare("INSERT INTO tasks (title, description, status, board) VALUES ('LPのバナー修正', 'ダミー説明', 'todo', 'company')").run();
  db.prepare("INSERT INTO tasks (title, description, status, board) VALUES ('見積書作成', '100%対応のLP案件', 'doing', 'project')").run();
  db.prepare("INSERT INTO announcements (title, body) VALUES ('年末の休業のお知らせ', '12月29日から休みます')").run();
  db.prepare("INSERT INTO knowledge_articles (category, title, body, updated_at) VALUES ('手順', '請求書の発行手順', 'LP制作の請求は月末に行う', '2026-10-01')").run();
  db.prepare("INSERT INTO ideas (category, title, body, updated_at) VALUES ('グッズ', 'ステッカー企画', 'ロゴを使う', '2026-10-02')").run();
  return db;
}

const count = (r, key) => r.groups.find((g) => g.key === key).items.length;

test('空の検索語では何も返さない', () => {
  assert.deepStrictEqual(searchAll(makeDb(), '  　 ').groups, []);
});

test('4種類を横断して見つかり、タイトルと本文の両方が対象になる', () => {
  const r = searchAll(makeDb(), 'LP');
  assert.deepStrictEqual(
    [count(r, 'tasks'), count(r, 'announcements'), count(r, 'knowledge'), count(r, 'ideas')],
    [2, 0, 1, 0]
  );
});

test('空白区切りの語は、すべて含むものだけに絞る', () => {
  assert.strictEqual(count(searchAll(makeDb(), 'LP 見積'), 'tasks'), 1);
});

test('%や_は、ワイルドカードでなく文字として探す', () => {
  const db = makeDb();
  assert.strictEqual(count(searchAll(db, '100%'), 'tasks'), 1);
  assert.strictEqual(count(searchAll(db, '%'), 'tasks'), 1);
  assert.strictEqual(searchAll(db, '_').groups.reduce((n, g) => n + g.items.length, 0), 0);
  assert.strictEqual(escapeLike('a%b_c\\'), 'a\\%b\\_c\\\\');
});

test('SQL文字列を入れても壊れない', () => {
  const r = searchAll(makeDb(), "'; DROP TABLE tasks; --");
  assert.strictEqual(r.groups.reduce((n, g) => n + g.items.length, 0), 0);
});

test('リンク先と抜粋が付く', () => {
  const item = searchAll(makeDb(), '休みます').groups.find((g) => g.key === 'announcements').items[0];
  assert.match(item.href, /^\/announcements\/\d+$/);
  assert.ok(item.snippet.includes('休みます'));
});

test('語は5つまで、抜粋は前後を切り出す', () => {
  assert.strictEqual(splitTerms('a b c d e f g').length, 5);
  const s = makeSnippet('あ'.repeat(100) + '目的の語' + 'い'.repeat(100), ['目的の語']);
  assert.ok(s.startsWith('…') && s.endsWith('…') && s.includes('目的の語'));
});

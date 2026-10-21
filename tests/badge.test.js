const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
delete process.env.PUSH_DISABLED;

const push = require('../lib/push');
const badge = require('../lib/badge');
const { ensurePushSchema } = require('../lib/pushSchema');
const { ensureChatSchema } = require('../lib/chatSchema');

function makeDb({ withSeen = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member');
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT NOT NULL DEFAULT 'todo',
      created_by TEXT, updated_by TEXT, updated_at TEXT);
    CREATE TABLE task_assignees (task_id INTEGER, user_id TEXT, PRIMARY KEY (task_id, user_id));
    CREATE TABLE announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created_by TEXT);
    CREATE TABLE announcement_reads (announcement_id INTEGER, user_id TEXT, PRIMARY KEY (announcement_id, user_id));
  `);
  ensureChatSchema(db);
  if (withSeen) ensurePushSchema(db);
  for (const u of ['me', 'other']) db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(u, u);
  return db;
}

const addTask = (db, { by = 'other', assignee = 'me', status = 'todo' } = {}) => {
  const id = db.prepare('INSERT INTO tasks (title, status, created_by) VALUES (?, ?, ?)').run('T', status, by).lastInsertRowid;
  if (assignee) db.prepare('INSERT INTO task_assignees (task_id, user_id) VALUES (?, ?)').run(id, assignee);
  return id;
};

test('お知らせ: 未読だけ数える。自分が投稿したものと既読は数えない', () => {
  const db = makeDb();
  db.prepare("INSERT INTO announcements (title, created_by) VALUES ('a','other'), ('b','other'), ('c','me')").run();
  assert.strictEqual(badge.unreadBreakdown(db, 'me').announcements, 2);
  db.prepare("INSERT INTO announcement_reads VALUES (1, 'me')").run();
  assert.strictEqual(badge.unreadBreakdown(db, 'me').announcements, 1);
});

test('チャット: 自分宛ての未読だけ数える', () => {
  const db = makeDb();
  db.prepare("INSERT INTO chat_messages (sender_id, receiver_id, body) VALUES ('other','me','x'), ('other','me','y'), ('me','other','z')").run();
  assert.strictEqual(badge.unreadBreakdown(db, 'me').chat, 2);
  db.prepare("UPDATE chat_messages SET read_at = datetime('now') WHERE body = 'x'").run();
  assert.strictEqual(badge.unreadBreakdown(db, 'me').chat, 1);
});

test('タスク: 担当で未完了・未開封だけ。開くと外れる', () => {
  const db = makeDb();
  const t = addTask(db);
  addTask(db, { status: 'done' }); // 完了は数えない
  addTask(db, { assignee: 'other' }); // 担当でない
  addTask(db, { by: 'me' }); // 自分が作ったタスクの初回は数えない
  assert.strictEqual(badge.unreadBreakdown(db, 'me').tasks, 1);
  badge.markTaskSeen(db, 'me', t);
  assert.strictEqual(badge.unreadBreakdown(db, 'me').tasks, 0);
});

test('タスク: 開いたあとに他の人が更新すると未読に戻る。自分の更新では戻らない', () => {
  const db = makeDb();
  const t = addTask(db);
  badge.markTaskSeen(db, 'me', t);
  db.prepare("UPDATE tasks SET updated_by = 'other', updated_at = datetime('now', '+1 minute') WHERE id = ?").run(t);
  assert.strictEqual(badge.unreadBreakdown(db, 'me').tasks, 1);
  badge.markTaskSeen(db, 'me', t);
  db.prepare("UPDATE tasks SET updated_by = 'me', updated_at = datetime('now', '+5 minute') WHERE id = ?").run(t);
  assert.strictEqual(badge.unreadBreakdown(db, 'me').tasks, 0);
});

test('導入時: すでにある担当タスクは「見た」扱い（初回だけ）。2回目以降の起動では増やさない', () => {
  const db = makeDb({ withSeen: false });
  const t = addTask(db);
  ensurePushSchema(db);
  assert.strictEqual(badge.unreadTotal(db, 'me'), 0);
  const t2 = addTask(db);
  ensurePushSchema(db); // 再起動しても、新しいタスクを勝手に「見た」にしない
  assert.strictEqual(badge.unreadBreakdown(db, 'me').tasks, 1);
  assert.ok(t2 > t);
});

test('合計と、数えられないときのnull', () => {
  const db = makeDb();
  addTask(db);
  db.prepare("INSERT INTO announcements (title, created_by) VALUES ('a','other')").run();
  db.prepare("INSERT INTO chat_messages (sender_id, receiver_id, body) VALUES ('other','me','x')").run();
  assert.strictEqual(badge.unreadTotal(db, 'me'), 3);
  const bare = new Database(':memory:');
  assert.strictEqual(badge.unreadTotalSafe(bare, 'me'), null);
});

test('通知には、その人の未読の合計（badge）が付く。数えられないDBでは付けない', async () => {
  const db = makeDb();
  addTask(db);
  push.saveSubscription(db, 'me', { endpoint: 'https://push.example.test/me', keys: { p256dh: 'p', auth: 'a' } });
  const sent = [];
  push.setSender(async (s, payload) => sent.push(JSON.parse(payload)));
  await push.sendToUser(db, 'me', { title: 't' });
  assert.strictEqual(sent[0].badge, 1);

  const bare = new Database(':memory:');
  bare.exec(`CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, endpoint TEXT, p256dh TEXT, auth TEXT)`);
  bare.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ('me','https://x','p','a')").run();
  await push.sendToUser(bare, 'me', { title: 't' });
  assert.strictEqual('badge' in sent[1], false);
});

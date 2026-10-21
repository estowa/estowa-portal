const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const webpush = require('web-push');

// テスト用の鍵（.env の値には依存しない）
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
delete process.env.PUSH_DISABLED;

const push = require('../lib/push');
const { ensurePushSchema } = require('../lib/pushSchema');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const { createHub } = require('../lib/chatHub');

const sub = (name) => ({ endpoint: `https://push.example.test/${name}`, keys: { p256dh: `p-${name}`, auth: `a-${name}` } });

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensurePushSchema(db);
  ensureChatSchema(db);
  for (const [uid, name] of [['actor', '操作者'], ['a', '山田'], ['b', '佐藤'], ['c', '鈴木']]) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, name);
  }
  return db;
}

function recordSends() {
  const sent = [];
  push.setSender(async (s, payload) => {
    sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload) });
  });
  return sent;
}

test('登録の検証: https以外・鍵なしは拒否', () => {
  assert.strictEqual(push.validateSubscription(sub('x')), true);
  assert.strictEqual(push.validateSubscription({ endpoint: 'http://x', keys: sub('x').keys }), false);
  assert.strictEqual(push.validateSubscription({ endpoint: 'https://x' }), false);
  assert.strictEqual(push.validateSubscription(null), false);
});

test('同じ端末を別ユーザーで登録すると付け替わる。解除は本人の分だけ', () => {
  const db = makeDb();
  push.saveSubscription(db, 'a', sub('d1'));
  push.saveSubscription(db, 'b', sub('d1'));
  assert.strictEqual(push.hasSubscription(db, 'a', sub('d1').endpoint), false);
  assert.strictEqual(push.hasSubscription(db, 'b', sub('d1').endpoint), true);
  assert.strictEqual(push.removeSubscription(db, 'a', sub('d1').endpoint), 0);
  assert.strictEqual(push.removeSubscription(db, 'b', sub('d1').endpoint), 1);
});

test('設定の初期値は全部オン。保存した設定が優先される', () => {
  const db = makeDb();
  assert.deepStrictEqual(push.getPrefs(db, 'a'), { task_added: true, task_moved: true, chat_new: true, announcement_new: true, call_incoming: true });
  push.setPrefs(db, 'a', { task_added: false, chat_new: true });
  const p = push.getPrefs(db, 'a');
  assert.strictEqual(p.task_added, false);
  assert.strictEqual(p.task_moved, false);
  assert.strictEqual(p.chat_new, true);
});

test('送信先: 登録済み・オンの人だけ。操作した本人は除く', () => {
  const db = makeDb();
  for (const u of ['actor', 'a', 'b']) push.saveSubscription(db, u, sub(u));
  push.setPrefs(db, 'b', { task_added: false });
  assert.deepStrictEqual(push.recipientsAmong(db, 'task_added', ['actor', 'a', 'b', 'c'], 'actor'), ['a']);
});

test('通知は、登録した全端末に届く。中身はタイトルだけ', async () => {
  const db = makeDb();
  const sent = recordSends();
  push.saveSubscription(db, 'a', sub('a1'));
  push.saveSubscription(db, 'a', sub('a2'));
  const n = await push.notify(db, 'task_added', ['a'], push.buildTaskAddedPayload({ id: 7, title: '見積書を作る' }), 'actor');
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(sent.map((s) => s.endpoint).sort(), [sub('a1').endpoint, sub('a2').endpoint]);
  assert.deepStrictEqual(sent[0].payload, { title: '新しいタスク', body: '見積書を作る', url: '/tasks/7', tag: 'task_added-7' });
});

test('タスク移動・お知らせ・チャットの中身（長いタイトルは切り詰め、チャット本文は載せない）', () => {
  const long = 'あ'.repeat(60);
  assert.strictEqual(push.buildTaskMovedPayload({ id: 1, title: 'T' }, '未着手', '完了').body, 'T（未着手 → 完了）');
  const ann = push.buildAnnouncementPayload({ id: 3, title: long });
  assert.strictEqual(Array.from(ann.body).length, 41);
  assert.strictEqual(ann.url, '/announcements/3');
  const chat = push.buildChatPayload('山田');
  assert.strictEqual(chat.body, '山田さんからメッセージがあります');
  assert.strictEqual(push.buildCallPayload('山田').body, '山田さんから通話です。ポータルを開いて応答してください');
  assert.strictEqual(push.buildChatPayload('山田', 'デザイン班').body, 'デザイン班に新着メッセージがあります');
  assert.ok(!JSON.stringify(push.buildChatPayload('山田', 'デザイン班')).includes('山田'));
});

test('無効になった端末(410)は登録から外れ、他の失敗は残る', async () => {
  const db = makeDb();
  push.saveSubscription(db, 'a', sub('gone'));
  push.saveSubscription(db, 'a', sub('flaky'));
  push.setSender(async (s) => {
    const err = new Error('x');
    err.statusCode = s.endpoint.endsWith('gone') ? 410 : 500;
    throw err;
  });
  const origError = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(await push.sendToUser(db, 'a', { title: 't' }), 0);
  } finally {
    console.error = origError;
  }
  assert.strictEqual(push.countSubscriptions(db, 'a'), 1);
  assert.strictEqual(push.hasSubscription(db, 'a', sub('flaky').endpoint), true);
});

test('通知の例外は呼び出し側に漏れない', async () => {
  const db = makeDb();
  push.saveSubscription(db, 'a', sub('a'));
  const origError = console.error;
  console.error = () => {};
  try {
    db.exec('DROP TABLE notification_prefs');
    assert.strictEqual(await push.notify(db, 'task_added', ['a'], { title: 't' }), 0);
  } finally {
    console.error = origError;
  }
});

test('PUSH_DISABLED=1 のときは送らない', async () => {
  const db = makeDb();
  const sent = recordSends();
  push.saveSubscription(db, 'a', sub('a'));
  process.env.PUSH_DISABLED = '1';
  try {
    assert.strictEqual(await push.sendToUser(db, 'a', { title: 't' }), 0);
  } finally {
    delete process.env.PUSH_DISABLED;
  }
  assert.strictEqual(sent.length, 0);
});

test('チャット: その部屋を見ていない人にだけ onOfflineMessage が呼ばれる', () => {
  const db = makeDb();
  const store = require('../lib/chatStore');
  const calls = [];
  const hub = createHub(db, { onOfflineMessage: (m, offline) => calls.push({ m, offline }) });
  const mk = () => ({ sent: [], send(s) { this.sent.push(s); } });
  const sa = mk();
  const sb = mk();
  hub.connect('a', sa);
  hub.connect('b', sb);
  const room = store.getOrCreateDm(db, 'a', 'b');
  hub.handle('b', sb, JSON.stringify({ type: 'viewing', room: room.id }));
  hub.handle('a', sa, JSON.stringify({ type: 'chat', room: room.id, body: 'こんにちは' }));
  assert.strictEqual(calls.length, 0);
  hub.handle('b', sb, JSON.stringify({ type: 'viewing', room: null }));
  hub.handle('a', sa, JSON.stringify({ type: 'chat', room: room.id, body: 'いますか' }));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].offline, ['b']);
});

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const store = require('../lib/chatStore');
const { buildChatState } = require('../routes/chat');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensureChatSchema(db);
  for (const [uid, name] of [['home', '在宅'], ['a', '社内A'], ['b', '社内B']]) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, name);
  }
  return db;
}

test('在宅未設定でも、チャットの相手（全員）は返る。通話の相手は空', () => {
  const db = makeDb();
  const s = buildChatState(db, 'a', {});
  assert.strictEqual(s.remoteConfigured, false);
  assert.deepStrictEqual(s.dms.map((d) => d.user_id), ['a', 'home', 'b']); // 先頭は自分のメモ
  assert.deepStrictEqual(s.voicePeers, []);
});

test('チャットは全員が相手。通話の相手は、在宅の人には社内全員、社内の人には在宅1人', () => {
  const db = makeDb();
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id='home'").get().id);
  const home = buildChatState(db, 'home', {});
  assert.strictEqual(home.me.isRemote, true);
  assert.deepStrictEqual(home.voicePeers.map((p) => p.user_id), ['a', 'b']);
  const a = buildChatState(db, 'a', {});
  assert.strictEqual(a.me.isRemote, false);
  assert.deepStrictEqual(a.voicePeers.map((p) => p.user_id), ['home']);
  assert.deepStrictEqual(a.dms.map((d) => d.user_id), ['a', 'home', 'b']);
});

test('未読数は1対1とグループそれぞれに付く', () => {
  const db = makeDb();
  const dm = store.getOrCreateDm(db, 'a', 'b');
  const g = store.createGroup(db, 'a', 'チーム', ['b']);
  store.saveMessage(db, dm.id, 'a', 'x');
  store.saveMessage(db, g.id, 'a', 'y');
  store.saveMessage(db, g.id, 'a', 'z');
  const s = buildChatState(db, 'b', {});
  assert.strictEqual(s.dms.find((d) => d.user_id === 'a').unread, 1);
  assert.strictEqual(s.groups[0].unread, 2);
});

test('TURNの設定がある時だけiceServersに加わる（認証情報は環境変数から）', () => {
  const db = makeDb();
  const none = buildChatState(db, 'a', {});
  assert.deepStrictEqual(none.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  const withTurn = buildChatState(db, 'a', { TURN_URL: 'turn:example.test:3478', TURN_USER: 'u', TURN_PASS: 'p' });
  assert.deepStrictEqual(withTurn.iceServers[1], { urls: 'turn:example.test:3478', username: 'u', credential: 'p' });
});

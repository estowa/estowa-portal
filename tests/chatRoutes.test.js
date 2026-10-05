const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const { saveMessage } = require('../lib/chatStore');
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

test('在宅未設定ならremoteConfigured=false、相手なし', () => {
  const db = makeDb();
  const s = buildChatState(db, 'a', {});
  assert.strictEqual(s.remoteConfigured, false);
  assert.deepStrictEqual(s.peers, []);
});

test('在宅の人には社内全員（未読数つき）、社内の人には在宅1人が返る', () => {
  const db = makeDb();
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id='home'").get().id);
  saveMessage(db, 'a', 'home', 'x');
  const home = buildChatState(db, 'home', {});
  assert.strictEqual(home.me.isRemote, true);
  assert.deepStrictEqual(home.peers.map((p) => [p.user_id, p.unread]), [['a', 1], ['b', 0]]);
  const a = buildChatState(db, 'a', {});
  assert.strictEqual(a.me.isRemote, false);
  assert.deepStrictEqual(a.peers.map((p) => p.user_id), ['home']);
});

test('TURNの設定がある時だけiceServersに加わる（認証情報は環境変数から）', () => {
  const db = makeDb();
  const none = buildChatState(db, 'a', {});
  assert.deepStrictEqual(none.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  const withTurn = buildChatState(db, 'a', { TURN_URL: 'turn:example.test:3478', TURN_USER: 'u', TURN_PASS: 'p' });
  assert.deepStrictEqual(withTurn.iceServers[1], { urls: 'turn:example.test:3478', username: 'u', credential: 'p' });
});

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const { createHub } = require('../lib/chatHub');

function makeEnv() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensureChatSchema(db);
  for (const uid of ['home', 'a', 'b']) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid);
  }
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id = 'home'").get().id);
  return { db, hub: createHub(db) };
}
function fakeSocket() {
  const s = { sent: [], send(d) { s.sent.push(JSON.parse(d)); } };
  s.of = (type) => s.sent.filter((m) => m.type === type);
  return s;
}
const send = (hub, uid, sock, obj) => hub.handle(uid, sock, JSON.stringify(obj));

test('在宅→社内のチャットは保存され、双方の全接続に届く', () => {
  const { hub } = makeEnv();
  const home1 = fakeSocket(), home2 = fakeSocket(), a = fakeSocket();
  hub.connect('home', home1); hub.connect('home', home2); hub.connect('a', a);
  send(hub, 'home', home1, { type: 'chat', to: 'a', body: 'おはよう' });
  assert.strictEqual(a.of('chat')[0].message.body, 'おはよう');
  assert.strictEqual(home1.of('chat').length, 1);
  assert.strictEqual(home2.of('chat').length, 1);
});

test('社内同士のチャット・ptt・signalは拒否され、相手に何も届かない', () => {
  const { hub } = makeEnv();
  const a = fakeSocket(), b = fakeSocket();
  hub.connect('a', a); hub.connect('b', b);
  send(hub, 'a', a, { type: 'chat', to: 'b', body: 'こそこそ' });
  send(hub, 'a', a, { type: 'ptt', to: 'b', on: true });
  send(hub, 'a', a, { type: 'signal', to: 'b', data: { x: 1 } });
  assert.strictEqual(a.of('error').length, 3);
  assert.strictEqual(a.of('error')[0].code, 'forbidden');
  assert.strictEqual(b.of('chat').length, 0);
  assert.strictEqual(b.of('ptt').length, 0);
  assert.strictEqual(b.of('signal').length, 0);
});

test('空・長すぎる本文はエラーを返し、保存も配信もしない', () => {
  const { hub, db } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'chat', to: 'a', body: '  ' });
  send(hub, 'home', home, { type: 'chat', to: 'a', body: 'あ'.repeat(2001) });
  assert.deepStrictEqual(home.of('error').map((e) => e.code), ['empty', 'too_long']);
  assert.strictEqual(a.of('chat').length, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_messages').get().c, 0);
});

test('不正なJSON・未知のtypeは無視する（落ちない）', () => {
  const { hub } = makeEnv();
  const home = fakeSocket();
  hub.connect('home', home);
  assert.doesNotThrow(() => hub.handle('home', home, 'これはJSONではない'));
  assert.doesNotThrow(() => send(hub, 'home', home, { type: 'unknown' }));
  assert.doesNotThrow(() => send(hub, 'home', home, null));
});

test('オンライン状態は話せる相手の分だけ、最新の接続番号つきで届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket(), b = fakeSocket();
  hub.connect('home', home);
  hub.connect('a', a);
  hub.connect('b', b);
  const last = (s) => s.of('presence').at(-1).online;
  assert.deepStrictEqual(Object.keys(last(home)).sort(), ['a', 'b']);
  assert.deepStrictEqual(Object.keys(last(a)), ['home']);   // 社内のaに、社内のbは見えない
  assert.strictEqual(last(a).home, home.cid);
});

test('複数タブ: 1つ閉じてもオンラインのまま、全部閉じるとオフライン', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2);
  hub.disconnect('a', a1);
  assert.ok('a' in home.of('presence').at(-1).online);
  hub.disconnect('a', a2);
  assert.ok(!('a' in home.of('presence').at(-1).online));
});

test('音声シグナルとpttは、相手の最新の接続にだけ届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2);
  send(hub, 'home', home, { type: 'signal', to: 'a', data: { sdp: 'offer' } });
  send(hub, 'home', home, { type: 'ptt', to: 'a', on: true });
  assert.strictEqual(a1.of('signal').length, 0);
  assert.deepStrictEqual(a2.of('signal')[0], { type: 'signal', from: 'home', data: { sdp: 'offer' } });
  assert.deepStrictEqual(a2.of('ptt')[0], { type: 'ptt', from: 'home', on: true });
});

test('既読にすると送信者に通知され、未読が消える', () => {
  const { hub, db } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'chat', to: 'a', body: 'x' });
  send(hub, 'a', a, { type: 'read', from: 'home' });
  assert.deepStrictEqual(home.of('read')[0], { type: 'read', by: 'a' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE read_at IS NULL').get().c, 0);
});

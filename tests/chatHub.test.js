const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const store = require('../lib/chatStore');
const { createHub } = require('../lib/chatHub');

function makeEnv(hubOptions) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  for (const uid of ['home', 'a', 'b']) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid);
  }
  ensureChatSchema(db);
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id = 'home'").get().id);
  return { db, hub: createHub(db, hubOptions) };
}
function fakeSocket() {
  const s = { sent: [], send(d) { s.sent.push(JSON.parse(d)); } };
  s.of = (type) => s.sent.filter((m) => m.type === type);
  return s;
}
const send = (hub, uid, sock, obj) => hub.handle(uid, sock, JSON.stringify(obj));

test('1対1のチャットは保存され、双方の全接続に届く（社内同士でもよい）', () => {
  const { hub, db } = makeEnv();
  const a1 = fakeSocket(), a2 = fakeSocket(), b = fakeSocket();
  hub.connect('a', a1); hub.connect('a', a2); hub.connect('b', b);
  const room = store.getOrCreateDm(db, 'a', 'b');
  send(hub, 'a', a1, { type: 'chat', room: room.id, body: 'おはよう' });
  assert.strictEqual(b.of('chat')[0].message.body, 'おはよう');
  assert.strictEqual(a1.of('chat').length, 1);
  assert.strictEqual(a2.of('chat').length, 1);
});

test('グループの発言はメンバー全員に届き、メンバーでない人には届かない', () => {
  const { hub, db } = makeEnv();
  const home = fakeSocket(), a = fakeSocket(), b = fakeSocket();
  hub.connect('home', home); hub.connect('a', a); hub.connect('b', b);
  const g = store.createGroup(db, 'a', 'チーム', ['b']);
  send(hub, 'a', a, { type: 'chat', room: g.id, body: 'みなさん' });
  assert.strictEqual(b.of('chat').length, 1);
  assert.strictEqual(home.of('chat').length, 0);
  send(hub, 'home', home, { type: 'chat', room: g.id, body: '入れて' });
  assert.strictEqual(home.of('error')[0].code, 'forbidden');
  assert.strictEqual(a.of('chat').length, 1);
});

test('空・長すぎる本文はエラーを返し、保存も配信もしない', () => {
  const { hub, db } = makeEnv();
  const a = fakeSocket(), b = fakeSocket();
  hub.connect('a', a); hub.connect('b', b);
  const room = store.getOrCreateDm(db, 'a', 'b');
  send(hub, 'a', a, { type: 'chat', room: room.id, body: '  ' });
  send(hub, 'a', a, { type: 'chat', room: room.id, body: 'あ'.repeat(2001) });
  assert.deepStrictEqual(a.of('error').map((e) => e.code), ['empty', 'too_long']);
  assert.strictEqual(b.of('chat').length, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_msgs').get().c, 0);
});

test('不正なJSON・未知のtype・存在しない部屋は無視またはエラー（落ちない）', () => {
  const { hub } = makeEnv();
  const a = fakeSocket();
  hub.connect('a', a);
  assert.doesNotThrow(() => hub.handle('a', a, 'これはJSONではない'));
  assert.doesNotThrow(() => send(hub, 'a', a, { type: 'unknown' }));
  assert.doesNotThrow(() => send(hub, 'a', a, null));
  assert.doesNotThrow(() => send(hub, 'a', a, { type: 'chat', room: 999, body: 'x' }));
  assert.doesNotThrow(() => send(hub, 'a', a, { type: 'read', room: 'abc' }));
});

test('オンライン状態は、つながっている全員の分が、最新の接続番号つきで届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket(), b = fakeSocket();
  hub.connect('home', home); hub.connect('a', a); hub.connect('b', b);
  const last = (s) => s.of('presence').at(-1).online;
  assert.deepStrictEqual(Object.keys(last(a)).sort(), ['a', 'b', 'home']);
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

test('通話のシグナルとpttは、在宅×社内だけ。社内同士は拒否され、相手の最新の接続にだけ届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket(), b = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2); hub.connect('b', b);
  send(hub, 'home', home, { type: 'signal', to: 'a', data: { sdp: 'offer' } });
  send(hub, 'home', home, { type: 'ptt', to: 'a', on: true });
  assert.strictEqual(a1.of('signal').length, 0);
  assert.deepStrictEqual(a2.of('signal')[0], { type: 'signal', from: 'home', data: { sdp: 'offer' } });
  assert.deepStrictEqual(a2.of('ptt')[0], { type: 'ptt', from: 'home', on: true });
  send(hub, 'a', a2, { type: 'ptt', to: 'b', on: true });
  send(hub, 'a', a2, { type: 'signal', to: 'b', data: { x: 1 } });
  assert.strictEqual(a2.of('error').length, 2);
  assert.strictEqual(b.of('ptt').length + b.of('signal').length, 0);
});

test('既読にすると未読が消える。メンバーでない部屋の既読は拒否される', () => {
  const { hub, db } = makeEnv();
  const a = fakeSocket(), b = fakeSocket(), home = fakeSocket();
  hub.connect('a', a); hub.connect('b', b); hub.connect('home', home);
  const room = store.getOrCreateDm(db, 'a', 'b');
  send(hub, 'a', a, { type: 'chat', room: room.id, body: 'x' });
  assert.strictEqual(store.totalUnread(db, 'b'), 1);
  send(hub, 'b', b, { type: 'read', room: room.id });
  assert.strictEqual(store.totalUnread(db, 'b'), 0);
  send(hub, 'home', home, { type: 'read', room: room.id });
  assert.strictEqual(home.of('error')[0].code, 'forbidden');
});

test('接続のないメンバーにだけ onOfflineMessage が呼ばれる（送信者は除く）', () => {
  const calls = [];
  const { hub, db } = makeEnv({ onOfflineMessage: (m, offline) => calls.push({ m, offline }) });
  const a = fakeSocket(), b = fakeSocket();
  hub.connect('a', a); hub.connect('b', b);
  const g = store.createGroup(db, 'a', 'チーム', ['b', 'home']);
  send(hub, 'a', a, { type: 'chat', room: g.id, body: 'こんにちは' });
  assert.deepStrictEqual(calls[0].offline, ['home']);
  hub.disconnect('b', b);
  send(hub, 'a', a, { type: 'chat', room: g.id, body: 'いますか' });
  assert.deepStrictEqual(calls[1].offline.sort(), ['b', 'home']);
});

test('publish: HTTPで保存された添付つきメッセージも同じように配られる', () => {
  const { hub, db } = makeEnv();
  const b = fakeSocket();
  hub.connect('b', b);
  const room = store.getOrCreateDm(db, 'a', 'b');
  const message = store.saveMessage(db, room.id, 'a', '', [{ originalName: 'x.pdf', storedName: 's', size: 1 }]);
  hub.publish(message);
  assert.strictEqual(b.of('chat')[0].message.files[0].name, 'x.pdf');
});

test('notifyRooms: 指定した人の全接続に rooms を送る', () => {
  const { hub } = makeEnv();
  const a = fakeSocket(), b = fakeSocket();
  hub.connect('a', a); hub.connect('b', b);
  hub.notifyRooms(['a', 'a']);
  assert.strictEqual(a.of('rooms').length, 1);
  assert.strictEqual(b.of('rooms').length, 0);
});

test('画面が見えていない接続（スマホのバックグラウンドなど）だけの人は、プッシュ通知の対象になる', () => {
  const calls = [];
  const { hub, db } = makeEnv({ onOfflineMessage: (m, offline) => calls.push(offline) });
  const a = fakeSocket(), bPc = fakeSocket(), bPhone = fakeSocket();
  hub.connect('a', a); hub.connect('b', bPc); hub.connect('b', bPhone);
  const room = store.getOrCreateDm(db, 'a', 'b');
  send(hub, 'a', a, { type: 'chat', room: room.id, body: '1' });
  assert.deepStrictEqual(calls, []);                          // 見えている接続があれば、通知しない
  send(hub, 'b', bPc, { type: 'visible', on: false });
  send(hub, 'a', a, { type: 'chat', room: room.id, body: '2' });
  assert.deepStrictEqual(calls, []);                          // もう1つが見えているので、まだ通知しない
  send(hub, 'b', bPhone, { type: 'visible', on: false });
  send(hub, 'a', a, { type: 'chat', room: room.id, body: '3' });
  assert.deepStrictEqual(calls, [['b']]);                     // どれも見えていなければ通知する
  send(hub, 'b', bPc, { type: 'visible', on: true });
  send(hub, 'a', a, { type: 'chat', room: room.id, body: '4' });
  assert.strictEqual(calls.length, 1);                        // 見えるようになれば、また通知しない
});

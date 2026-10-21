const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const { createHub } = require('../lib/chatHub');

function makeEnv(options) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  for (const uid of ['home', 'a', 'b']) db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid);
  ensureChatSchema(db);
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id = 'home'").get().id);
  return { db, hub: createHub(db, options) };
}
function fakeSocket() {
  const s = { sent: [], send(d) { s.sent.push(JSON.parse(d)); } };
  s.of = (type) => s.sent.filter((m) => m.type === type);
  s.calls = (action) => s.of('call').filter((m) => m.action === action);
  return s;
}
const send = (hub, uid, sock, obj) => hub.handle(uid, sock, JSON.stringify(obj));

test('呼び出し→応答→終了。相手の画面に着信が届き、応答で呼んだ側に通話開始が伝わる', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  assert.deepStrictEqual(a.calls('invite')[0], { type: 'call', action: 'invite', from: 'home' });
  send(hub, 'a', a, { type: 'call', to: 'home', action: 'accept' });
  assert.strictEqual(home.calls('accepted')[0].from, 'a');
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'end' });
  assert.strictEqual(a.calls('ended')[0].reason, 'ended');
  assert.strictEqual(home.calls('ended')[0].reason, 'ended');
});

test('断ると、呼んだ側に declined が届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'a', a, { type: 'call', to: 'home', action: 'invite' });
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'decline' });
  assert.strictEqual(a.calls('ended')[0].reason, 'declined');
});

test('社内同士の通話は拒否され、相手に何も届かない', () => {
  const { hub } = makeEnv();
  const a = fakeSocket(), b = fakeSocket();
  hub.connect('a', a); hub.connect('b', b);
  send(hub, 'a', a, { type: 'call', to: 'b', action: 'invite' });
  assert.strictEqual(a.of('error')[0].code, 'forbidden');
  assert.strictEqual(b.of('call').length, 0);
});

test('相手がオフラインなら offline、話し中なら busy を返す', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket(), b = fakeSocket();
  hub.connect('home', home);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  assert.strictEqual(home.calls('ended')[0].reason, 'offline');
  hub.connect('a', a); hub.connect('b', b);
  send(hub, 'a', a, { type: 'call', to: 'home', action: 'invite' });
  send(hub, 'b', b, { type: 'call', to: 'home', action: 'invite' });
  assert.strictEqual(b.calls('ended')[0].reason, 'busy');
  assert.strictEqual(a.calls('ended').length, 0); // 最初の呼び出しは、そのまま続く
});

test('応答できるのは、呼ばれた側だけ。呼んでいない相手への応答や、呼んだ本人の応答は無視される', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'accept' }); // 呼ぶ前の応答
  assert.strictEqual(a.calls('accepted').length + home.calls('accepted').length, 0);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'accept' }); // 呼んだ本人が応答しても無効
  assert.strictEqual(home.calls('accepted').length, 0);
});

test('通話中に相手の接続が全部切れたら、通話を終える', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  send(hub, 'a', a, { type: 'call', to: 'home', action: 'accept' });
  hub.disconnect('a', a);
  assert.strictEqual(home.calls('ended').at(-1).reason, 'offline');
});

test('呼び出しに誰も出ないと、時間切れで missed になる', async () => {
  const { hub } = makeEnv({ ringMs: 20 });
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(home.calls('ended')[0].reason, 'missed');
  assert.strictEqual(a.calls('ended')[0].reason, 'missed');
});

test('通話の最大時間を過ぎると、limit で終わる', async () => {
  const { hub } = makeEnv({ maxCallMs: 20 });
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  send(hub, 'a', a, { type: 'call', to: 'home', action: 'accept' });
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(a.calls('ended')[0].reason, 'limit');
});

test('着信は「音声ON」を押した画面にだけ届く。接続番号（cid）もその画面のものになる', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2);
  send(hub, 'a', a1, { type: 'voice', ready: true, visible: true }); // a1が音声ON。a2のほうが新しいが、a1が受け口
  assert.strictEqual(home.of('presence').at(-1).online.a, a1.cid);
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  assert.strictEqual(a1.calls('invite').length, 1);
  assert.strictEqual(a2.calls('invite').length, 0);
  send(hub, 'home', home, { type: 'signal', to: 'a', data: { x: 1 } });
  assert.strictEqual(a1.of('signal').length, 1);
  assert.strictEqual(a2.of('signal').length, 0);
});

test('音声ONの画面がないときは、最新の接続が受け口になる', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2);
  assert.strictEqual(home.of('presence').at(-1).online.a, a2.cid);
});

test('画面が見えている画面がないときだけ、着信のプッシュ通知を送る', () => {
  const calls = [];
  const { hub } = makeEnv({ onCallRing: (from, to) => calls.push([from, to]) });
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'a', a, { type: 'voice', ready: true, visible: true });
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  assert.deepStrictEqual(calls, []); // 見えているので、画面の着信音だけ
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'end' });
  send(hub, 'a', a, { type: 'voice', ready: true, visible: false }); // 別のタブを見ている
  send(hub, 'home', home, { type: 'call', to: 'a', action: 'invite' });
  assert.deepStrictEqual(calls, [['home', 'a']]);
});

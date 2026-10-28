const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const store = require('../lib/chatStore');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  for (const uid of ['home', 'a', 'b', 'c']) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid + 'さん');
  }
  ensureChatSchema(db);
  return db;
}

test('1対1は社内同士でも作れ、同じ組み合わせは同じ部屋になる', () => {
  const db = makeDb();
  const r1 = store.getOrCreateDm(db, 'a', 'b');
  const r2 = store.getOrCreateDm(db, 'b', 'a');
  assert.strictEqual(r1.id, r2.id);
  assert.deepStrictEqual(store.memberIds(db, r1.id).sort(), ['a', 'b']);
  assert.throws(() => store.getOrCreateDm(db, 'a', 'nobody'), /forbidden/);
  assert.throws(() => store.getOrCreateDm(db, '', 'a'), /forbidden/);
});

test('保存した本文は前後の空白が除かれ、送信者名とJST時刻が付く', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'home', 'a');
  const m = store.saveMessage(db, room.id, 'home', '  こんにちは  ');
  assert.strictEqual(m.body, 'こんにちは');
  assert.strictEqual(m.sender_name, 'homeさん');
  assert.deepStrictEqual(m.files, []);
  assert.match(m.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('空・2000文字超は拒否。ただし添付があれば本文は空でもよい', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'home', 'a');
  assert.throws(() => store.saveMessage(db, room.id, 'home', '   '), /empty/);
  assert.throws(() => store.saveMessage(db, room.id, 'home', 'あ'.repeat(2001)), /too_long/);
  assert.doesNotThrow(() => store.saveMessage(db, room.id, 'home', 'あ'.repeat(2000)));
  const withFile = store.saveMessage(db, room.id, 'home', '', [{ originalName: '写真.PNG', storedName: 's1.png', size: 10 }]);
  assert.strictEqual(withFile.body, '');
  assert.deepStrictEqual(withFile.files.map((f) => [f.name, f.is_image]), [['写真.PNG', true]]);
  const pdf = store.saveMessage(db, room.id, 'home', 'x', [{ originalName: 'a.pdf', storedName: 's2.pdf', size: 10 }]);
  assert.strictEqual(pdf.files[0].is_image, false);
  const six = Array.from({ length: 6 }, (_, i) => ({ originalName: `f${i}.txt`, storedName: `s${i}`, size: 1 }));
  assert.throws(() => store.saveMessage(db, room.id, 'home', 'x', six), /too_many_files/);
});

test('メンバーでない人は送れない・読めない', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'a', 'b');
  assert.throws(() => store.saveMessage(db, room.id, 'c', 'こそこそ'), /forbidden/);
  assert.strictEqual(store.isMember(db, room.id, 'c'), false);
});

test('HTMLを含む本文もそのまま保存する（表示側でテキスト扱い）', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'a', 'b');
  assert.strictEqual(store.saveMessage(db, room.id, 'a', '<script>alert(1)</script>').body, '<script>alert(1)</script>');
});

test('一覧は部屋ごとに分かれ、limit件の最新分を古い順に返す', () => {
  const db = makeDb();
  const ab = store.getOrCreateDm(db, 'a', 'b');
  const ac = store.getOrCreateDm(db, 'a', 'c');
  for (let i = 1; i <= 5; i++) store.saveMessage(db, ab.id, 'a', String(i));
  store.saveMessage(db, ac.id, 'a', '別の人');
  assert.deepStrictEqual(store.listMessages(db, ab.id, 3).map((m) => m.body), ['3', '4', '5']);
  assert.deepStrictEqual(store.listMessages(db, ac.id).map((m) => m.body), ['別の人']);
});

test('グループ: 名前とメンバーの検証、作った人は自動で入る', () => {
  const db = makeDb();
  assert.throws(() => store.createGroup(db, 'a', '  ', ['b']), /name_required/);
  assert.throws(() => store.createGroup(db, 'a', 'あ'.repeat(31), ['b']), /name_too_long/);
  assert.throws(() => store.createGroup(db, 'a', 'チーム', []), /members_required/);
  assert.throws(() => store.createGroup(db, 'a', 'チーム', ['a']), /members_required/);
  assert.throws(() => store.createGroup(db, 'a', 'チーム', ['nobody']), /unknown_member/);
  const g = store.createGroup(db, 'a', 'あ'.repeat(30), ['b', 'b', 'c']);
  assert.deepStrictEqual(store.memberIds(db, g.id).sort(), ['a', 'b', 'c']);
});

test('グループ: メンバーだけが追加・名前変更・退出でき、追加された人は過去分が未読にならない', () => {
  const db = makeDb();
  const g = store.createGroup(db, 'a', 'チーム', ['b']);
  store.saveMessage(db, g.id, 'a', '追加前の発言');
  assert.throws(() => store.addMembers(db, g.id, 'c', ['home']), /forbidden/);
  assert.deepStrictEqual(store.addMembers(db, g.id, 'b', ['c', 'b']), ['c']);
  assert.deepStrictEqual(store.unreadByRoom(db, 'c'), {});
  assert.deepStrictEqual(store.unreadByRoom(db, 'b'), { [g.id]: 1 });
  store.renameGroup(db, g.id, 'c', '新しい名前');
  assert.strictEqual(store.getRoom(db, g.id).name, '新しい名前');
  assert.throws(() => store.renameGroup(db, g.id, 'home', 'x'), /forbidden/);
  store.leaveGroup(db, g.id, 'c');
  assert.strictEqual(store.isMember(db, g.id, 'c'), false);
  assert.throws(() => store.saveMessage(db, g.id, 'c', '抜けた後'), /forbidden/);
});

test('1対1の部屋に人を足したり、1対1から退出したりはできない', () => {
  const db = makeDb();
  const dm = store.getOrCreateDm(db, 'a', 'b');
  assert.throws(() => store.addMembers(db, dm.id, 'a', ['c']), /forbidden/);
  assert.throws(() => store.leaveGroup(db, dm.id, 'a'), /forbidden/);
});

test('未読は部屋ごと・人ごとに数え、自分の発言は数えず、既読で消える', () => {
  const db = makeDb();
  const dm = store.getOrCreateDm(db, 'a', 'home');
  const g = store.createGroup(db, 'a', 'チーム', ['home', 'b']);
  store.saveMessage(db, dm.id, 'a', 'x');
  store.saveMessage(db, dm.id, 'a', 'y');
  store.saveMessage(db, g.id, 'b', 'z');
  store.saveMessage(db, dm.id, 'home', '自分の発言');
  // 自分の発言は数えない。返信しただけでは、見ていない発言は既読にならない
  assert.deepStrictEqual(store.unreadByRoom(db, 'home'), { [dm.id]: 2, [g.id]: 1 });
  assert.strictEqual(store.totalUnread(db, 'a'), 2); // dmのhomeの発言1 + グループのbの発言1
  store.markRead(db, g.id, 'a');
  assert.strictEqual(store.totalUnread(db, 'a'), 1);
  store.markRead(db, dm.id, 'home');
  assert.deepStrictEqual(store.unreadByRoom(db, 'home'), { [g.id]: 1 });
});

test('画面用の一覧: 自分以外の全員の1対1と、入っているグループだけ', () => {
  const db = makeDb();
  const g1 = store.createGroup(db, 'a', 'Aのグループ', ['b']);
  store.createGroup(db, 'b', '別のグループ', ['c']);
  store.saveMessage(db, g1.id, 'b', 'こんにちは');
  const { groups, dms } = store.listForUser(db, 'a');
  assert.deepStrictEqual(groups.map((g) => [g.name, g.unread]), [['Aのグループ', 1]]);
  assert.deepStrictEqual(dms.map((d) => d.user_id), ['a', 'home', 'b', 'c']); // 先頭は、自分のメモ
  assert.strictEqual(dms[0].self, true);
  assert.deepStrictEqual(dms.slice(1).map((d) => d.self), [false, false, false]);
  assert.strictEqual(dms[1].room_id, null);
});

test('添付をダウンロードできるのは、その部屋のメンバーだけ', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'a', 'b');
  const m = store.saveMessage(db, room.id, 'a', '', [{ originalName: 'a.pdf', storedName: 'x.pdf', size: 1 }]);
  const fileId = m.files[0].id;
  assert.strictEqual(store.getFileForUser(db, fileId, 'b').stored_name, 'x.pdf');
  assert.strictEqual(store.getFileForUser(db, fileId, 'c'), null);
});

test('旧チャットの履歴は1対1の部屋へ一度だけ引き継がれ、未読の位置も保たれる', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  for (const uid of ['home', 'a']) db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid);
  // 旧スキーマだけを作り、旧データを入れる
  db.exec(`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id TEXT NOT NULL, receiver_id TEXT NOT NULL,
    body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT)`);
  const ins = db.prepare('INSERT INTO chat_messages (sender_id, receiver_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('home', 'a', '1', '2026-10-01 00:00:00', '2026-10-01 00:01:00');
  ins.run('a', 'home', '2', '2026-10-01 00:02:00', '2026-10-01 00:03:00');
  ins.run('home', 'a', '3', '2026-10-01 00:04:00', null); // aにとって未読
  ensureChatSchema(db);
  ensureChatSchema(db); // 2回目は増えない
  const dm = store.getOrCreateDm(db, 'home', 'a');
  assert.deepStrictEqual(store.listMessages(db, dm.id).map((m) => m.body), ['1', '2', '3']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_msgs').get().c, 3);
  assert.deepStrictEqual(store.unreadByRoom(db, 'a'), { [dm.id]: 1 });
  assert.deepStrictEqual(store.unreadByRoom(db, 'home'), {});
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_messages').get().c, 3); // 旧データは残す
});

test('自分宛てのメモ: 自分だけの部屋ができ、同じ部屋を使い回し、未読にならず、他の人は読めない', () => {
  const db = makeDb();
  const memo = store.getOrCreateDm(db, 'a', 'a');
  assert.strictEqual(store.getOrCreateDm(db, 'a', 'a').id, memo.id);
  assert.deepStrictEqual(store.memberIds(db, memo.id), ['a']);
  const m = store.saveMessage(db, memo.id, 'a', 'あとで電話', [{ originalName: 'メモ.pdf', storedName: 'm1.pdf', size: 1 }]);
  assert.strictEqual(m.body, 'あとで電話');
  assert.strictEqual(store.totalUnread(db, 'a'), 0);                         // 自分の発言は未読にならない
  assert.throws(() => store.saveMessage(db, memo.id, 'b', 'のぞき見'), /forbidden/);
  assert.strictEqual(store.getFileForUser(db, m.files[0].id, 'b'), null);     // 添付も他の人は開けない
  assert.strictEqual(store.getFileForUser(db, m.files[0].id, 'a').stored_name, 'm1.pdf');
  const listed = store.listForUser(db, 'a').dms[0];
  assert.deepStrictEqual([listed.user_id, listed.self, listed.room_id], ['a', true, memo.id]);
  assert.strictEqual(store.listForUser(db, 'b').dms.find((d) => d.user_id === 'a').room_id, null); // 他の人の一覧に、自分のメモの部屋は出ない
});

test('取り消し: 送った本人だけができ、本文と添付が消え、一覧には出なくなる', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'a', 'b');
  const m = store.saveMessage(db, room.id, 'a', '秘密の話', [{ originalName: 'a.pdf', storedName: 'x.pdf', size: 1 }]);
  assert.throws(() => store.deleteMessage(db, m.id, 'b'), /forbidden/);      // 相手は取り消せない
  assert.throws(() => store.deleteMessage(db, m.id, 'c'), /forbidden/);      // 部屋の外の人も不可
  assert.throws(() => store.deleteMessage(db, 99999, 'a'), /forbidden/);     // 存在しないid
  const r = store.deleteMessage(db, m.id, 'a');
  assert.deepStrictEqual(r.storedNames, ['x.pdf']);
  assert.deepStrictEqual([r.message.deleted, r.message.body, r.message.files], [true, '', []]);
  const listed = store.listMessages(db, room.id);
  assert.deepStrictEqual(listed, []); // 一覧には出ない（跡は残さない）
  assert.strictEqual(db.prepare('SELECT body FROM chat_msgs WHERE id = ?').get(m.id).body, ''); // DBにも本文は残らない
  assert.strictEqual(store.getFileForUser(db, m.files[0].id, 'b'), null);     // 添付は開けない
  assert.deepStrictEqual(store.deleteMessage(db, m.id, 'a').storedNames, []); // 2回目は何もしない
});

test('取り消したメッセージは未読に数えない', () => {
  const db = makeDb();
  const room = store.getOrCreateDm(db, 'a', 'b');
  const m1 = store.saveMessage(db, room.id, 'a', '1');
  store.saveMessage(db, room.id, 'a', '2');
  assert.strictEqual(store.totalUnread(db, 'b'), 2);
  store.deleteMessage(db, m1.id, 'a');
  assert.strictEqual(store.totalUnread(db, 'b'), 1);
});

test('自分宛てのメモの発言も取り消せる', () => {
  const db = makeDb();
  const memo = store.getOrCreateDm(db, 'a', 'a');
  const m = store.saveMessage(db, memo.id, 'a', 'あとで');
  assert.strictEqual(store.deleteMessage(db, m.id, 'a').message.deleted, true);
});

test('抜けたグループの発言は、取り消せない', () => {
  const db = makeDb();
  const g = store.createGroup(db, 'a', 'チーム', ['b']);
  const m = store.saveMessage(db, g.id, 'b', 'x');
  store.leaveGroup(db, g.id, 'b');
  assert.throws(() => store.deleteMessage(db, m.id, 'b'), /forbidden/);
});

test('取り消し列は、旧いDBにも一度だけ追加される', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  db.exec(`CREATE TABLE chat_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, sender_id TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  ensureChatSchema(db);
  ensureChatSchema(db);
  assert.ok(db.prepare('PRAGMA table_info(chat_msgs)').all().some((c) => c.name === 'deleted_at'));
});

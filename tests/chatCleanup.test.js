const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const store = require('../lib/chatStore');
const { purgeOldImages, IMAGE_KEEP_DAYS } = require('../lib/chatCleanup');

function makeEnv() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  for (const uid of ['a', 'b']) db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid);
  ensureChatSchema(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatfiles-'));
  return { db, dir, room: store.getOrCreateDm(db, 'a', 'b') };
}
function addMessage(env, daysAgo, files) {
  for (const f of files) fs.writeFileSync(path.join(env.dir, f.storedName), 'x');
  const m = store.saveMessage(env.db, env.room.id, 'a', '本文', files.map((f) => ({ ...f, size: 1 })));
  env.db.prepare("UPDATE chat_msgs SET created_at = datetime('now', ?) WHERE id = ?").run(`-${daysAgo} days`, m.id);
  return m;
}

test('保持日数は15日', () => {
  assert.strictEqual(IMAGE_KEEP_DAYS, 15);
});

test('15日より古い「画像」の添付だけを削除し、本文・PDF・新しい画像は残す', () => {
  const env = makeEnv();
  const old = addMessage(env, 16, [
    { originalName: '古い.png', storedName: 'old.png' },
    { originalName: '古い.pdf', storedName: 'old.pdf' },
  ]);
  const fresh = addMessage(env, 14, [{ originalName: '新しい.jpg', storedName: 'fresh.jpg' }]);
  const n = purgeOldImages(env.db, env.dir);
  assert.strictEqual(n, 1);
  assert.ok(!fs.existsSync(path.join(env.dir, 'old.png')));   // 古い画像の実体は消える
  assert.ok(fs.existsSync(path.join(env.dir, 'old.pdf')));    // PDFは残る
  assert.ok(fs.existsSync(path.join(env.dir, 'fresh.jpg')));  // 新しい画像は残る
  const msgs = store.listMessages(env.db, env.room.id);
  const oldMsg = msgs.find((m) => m.id === old.id);
  assert.strictEqual(oldMsg.body, '本文');                    // メッセージの文字は残る
  assert.deepStrictEqual(oldMsg.files.map((f) => [f.name, f.deleted]), [['古い.png', true], ['古い.pdf', false]]);
  assert.strictEqual(msgs.find((m) => m.id === fresh.id).files[0].deleted, false);
});

test('削除済みの添付は、メンバーでもダウンロードできない。2回実行しても増えない', () => {
  const env = makeEnv();
  const m = addMessage(env, 20, [{ originalName: 'a.png', storedName: 'a.png' }]);
  assert.strictEqual(purgeOldImages(env.db, env.dir), 1);
  assert.strictEqual(purgeOldImages(env.db, env.dir), 0);
  assert.strictEqual(store.getFileForUser(env.db, m.files[0].id, 'a'), null);
});

test('実体のファイルが既に無くても落ちず、削除済みとして記録する', () => {
  const env = makeEnv();
  const m = addMessage(env, 20, [{ originalName: 'a.png', storedName: 'a.png' }]);
  fs.unlinkSync(path.join(env.dir, 'a.png'));
  assert.strictEqual(purgeOldImages(env.db, env.dir), 1);
  assert.strictEqual(store.listMessages(env.db, env.room.id)[0].files[0].deleted, true);
});

test('保存名に ../ などが入っていても、置き場の外は消さない', () => {
  const env = makeEnv();
  const outside = path.join(os.tmpdir(), 'chat-outside-' + Date.now() + '.png');
  fs.writeFileSync(outside, 'x');
  const m = addMessage(env, 20, [{ originalName: 'a.png', storedName: 'ok.png' }]);
  env.db.prepare('UPDATE chat_files SET stored_name = ? WHERE msg_id = ?').run('../' + path.basename(outside), m.id);
  purgeOldImages(env.db, env.dir);
  assert.ok(fs.existsSync(outside));
  fs.unlinkSync(outside);
});

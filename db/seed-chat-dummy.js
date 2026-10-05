// ローカル確認用のダミーアカウントを作る（本番では実行しない）
const bcrypt = require('bcryptjs');
const db = require('./connection');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');

if (process.env.NODE_ENV === 'production') {
  console.error('本番環境では実行できません');
  process.exit(1);
}

ensureChatSchema(db);
const hash = bcrypt.hashSync('dummy1234', 10);
const dummies = [
  ['chat_home', '在宅ダミー'],
  ['chat_a', '社内ダミーA'],
  ['chat_b', '社内ダミーB'],
  ['chat_c', '社内ダミーC'],
  ['chat_d', '社内ダミーD'],
];
for (const [userId, name] of dummies) {
  if (!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)) {
    db.prepare("INSERT INTO users (user_id, password_hash, display_name, role) VALUES (?, ?, ?, 'member')").run(userId, hash, name);
  }
}
setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id = 'chat_home'").get().id);
console.log('ダミーアカウントを作成しました（パスワードはすべて dummy1234）。在宅は chat_home です');

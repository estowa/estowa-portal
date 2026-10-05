// チャット用のテーブル・列を作る（何度実行しても安全）
function ensureChatSchema(db) {
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('is_remote')) {
    db.exec('ALTER TABLE users ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,     -- users.user_id
      receiver_id TEXT NOT NULL,   -- users.user_id
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_receiver_unread ON chat_messages(receiver_id, sender_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, receiver_id, id);
  `);
}

module.exports = { ensureChatSchema };

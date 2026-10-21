// プッシュ通知用のテーブルを作る（何度実行しても安全）
function ensurePushSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,          -- users.user_id
      endpoint TEXT NOT NULL UNIQUE,  -- 端末ごとの宛先
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
  `);
}

module.exports = { ensurePushSchema };

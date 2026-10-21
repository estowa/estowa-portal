// プッシュ通知用のテーブルを作る（何度実行しても安全）
function ensurePushSchema(db) {
  // バッジ用: タスクを「見た」記録。初めて作るときだけ、今ある担当タスクを「見た」ことにする（導入直後に大きな数字が出ないように）
  const hadTaskSeen = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_seen'").get();
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
    CREATE TABLE IF NOT EXISTS task_seen (
      user_id TEXT NOT NULL,
      task_id INTEGER NOT NULL,
      seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, task_id)
    );
  `);
  const hasAssignees = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_assignees'").get();
  if (!hadTaskSeen && hasAssignees) {
    db.exec(`INSERT OR IGNORE INTO task_seen (user_id, task_id)
             SELECT user_id, task_id FROM task_assignees`);
  }
}

module.exports = { ensurePushSchema };

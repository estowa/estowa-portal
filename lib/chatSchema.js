// チャット用のテーブル・列を作る（何度実行しても安全）
// 旧: chat_messages（在宅×社内の1対1のみ）。新: 部屋（1対1・グループ）＋メンバー＋メッセージ＋添付。
// 旧テーブルは消さずに残し、中身を新しい形へ一度だけ引き継ぐ。
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

    CREATE TABLE IF NOT EXISTS chat_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
      name TEXT NOT NULL DEFAULT '',
      dm_key TEXT UNIQUE,            -- 1対1のときだけ。2人のuser_idを並べ替えてつないだもの
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      room_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
    CREATE TABLE IF NOT EXISTS chat_msgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msgs_room ON chat_msgs(room_id, id);
    CREATE TABLE IF NOT EXISTS chat_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      msg_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      is_image INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chat_files_msg ON chat_files(msg_id);
  `);
  // 2026-10-21追加: 自動削除した添付の記録
  const fileColumns = db.prepare('PRAGMA table_info(chat_files)').all().map((c) => c.name);
  if (!fileColumns.includes('deleted_at')) db.exec('ALTER TABLE chat_files ADD COLUMN deleted_at TEXT');
  // 2026-10-28追加: 送った本人による取り消し（本文は空にして、取り消した日時だけ残す）
  const msgColumns = db.prepare('PRAGMA table_info(chat_msgs)').all().map((c) => c.name);
  if (!msgColumns.includes('deleted_at')) db.exec('ALTER TABLE chat_msgs ADD COLUMN deleted_at TEXT');
  migrateLegacyChat(db);
}

function dmKey(a, b) {
  return [a, b].sort().join('\n');
}

// 旧chat_messagesを、1対1の部屋へ引き継ぐ。部屋がまだ無い組み合わせだけ（2回目以降は何もしない）
function migrateLegacyChat(db) {
  const pairs = db
    .prepare(
      `SELECT DISTINCT CASE WHEN sender_id < receiver_id THEN sender_id ELSE receiver_id END AS a,
                       CASE WHEN sender_id < receiver_id THEN receiver_id ELSE sender_id END AS b
       FROM chat_messages`
    )
    .all();
  if (pairs.length === 0) return;
  const hasRoom = db.prepare('SELECT 1 FROM chat_rooms WHERE dm_key = ?');
  const addRoom = db.prepare("INSERT INTO chat_rooms (kind, name, dm_key, created_by) VALUES ('dm', '', ?, NULL)");
  const addMember = db.prepare('INSERT INTO chat_members (room_id, user_id, last_read_id) VALUES (?, ?, ?)');
  const legacy = db.prepare(
    'SELECT * FROM chat_messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) ORDER BY id'
  );
  const addMsg = db.prepare('INSERT INTO chat_msgs (room_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (const { a, b } of pairs) {
      const key = dmKey(a, b);
      if (hasRoom.get(key)) continue;
      const roomId = addRoom.run(key).lastInsertRowid;
      // 各人の「未読の手前」のメッセージidを求める（未読がなければ最後まで読んだ扱い）
      const firstUnread = { [a]: null, [b]: null };
      let lastId = 0;
      for (const m of legacy.all(a, b, b, a)) {
        const newId = addMsg.run(roomId, m.sender_id, m.body, m.created_at).lastInsertRowid;
        lastId = newId;
        if (!m.read_at && firstUnread[m.receiver_id] === null) firstUnread[m.receiver_id] = newId;
      }
      for (const uid of [a, b]) {
        addMember.run(roomId, uid, firstUnread[uid] === null ? lastId : firstUnread[uid] - 1);
      }
    }
  })();
}

module.exports = { ensureChatSchema, dmKey };

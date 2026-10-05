const { formatJst } = require('./jst');

const MAX_BODY = 2000;

function toMessage(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id,
    body: row.body,
    created_at: formatJst(row.created_at),
    read: !!row.read_at,
  };
}

function saveMessage(db, fromUserId, toUserId, body) {
  const text = String(body === undefined || body === null ? '' : body).trim();
  if (!text) throw new Error('empty');
  if (text.length > MAX_BODY) throw new Error('too_long');
  const result = db
    .prepare('INSERT INTO chat_messages (sender_id, receiver_id, body) VALUES (?, ?, ?)')
    .run(fromUserId, toUserId, text);
  return toMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid));
}

function listMessages(db, userIdA, userIdB, limit = 100) {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(userIdA, userIdB, userIdB, userIdA, limit);
  return rows.reverse().map(toMessage);
}

function markRead(db, readerUserId, fromUserId) {
  db.prepare(
    "UPDATE chat_messages SET read_at = datetime('now') WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL"
  ).run(readerUserId, fromUserId);
}

function unreadCounts(db, userId) {
  const rows = db
    .prepare(
      'SELECT sender_id, COUNT(*) AS c FROM chat_messages WHERE receiver_id = ? AND read_at IS NULL GROUP BY sender_id'
    )
    .all(userId);
  return Object.fromEntries(rows.map((r) => [r.sender_id, r.c]));
}

module.exports = { MAX_BODY, saveMessage, listMessages, markRead, unreadCounts };

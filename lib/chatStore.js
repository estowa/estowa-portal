const { formatJst } = require('./jst');
const { dmKey } = require('./chatSchema');

const MAX_BODY = 2000;
const MAX_GROUP_NAME = 30;
const MAX_FILES = 5;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

function userExists(db, userId) {
  return !!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId);
}

function isMember(db, roomId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
}

function memberIds(db, roomId) {
  return db.prepare('SELECT user_id FROM chat_members WHERE room_id = ? ORDER BY joined_at, user_id').all(roomId).map((r) => r.user_id);
}

function getRoom(db, roomId) {
  return db.prepare('SELECT * FROM chat_rooms WHERE id = ?').get(roomId) || null;
}

// 1対1の部屋。なければ作る（社内の誰とでも作れる）。同じ人を2回渡すと、自分だけのメモの部屋になる
function getOrCreateDm(db, userA, userB) {
  if (!userA || !userB) throw new Error('forbidden');
  if (!userExists(db, userA) || !userExists(db, userB)) throw new Error('forbidden');
  const key = dmKey(userA, userB);
  const found = db.prepare('SELECT * FROM chat_rooms WHERE dm_key = ?').get(key);
  if (found) return found;
  return db.transaction(() => {
    const id = db.prepare("INSERT INTO chat_rooms (kind, name, dm_key, created_by) VALUES ('dm', '', ?, ?)").run(key, userA).lastInsertRowid;
    const add = db.prepare('INSERT INTO chat_members (room_id, user_id) VALUES (?, ?)');
    add.run(id, userA);
    if (userB !== userA) add.run(id, userB);
    return getRoom(db, id);
  })();
}

function currentMaxMsgId(db, roomId) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM chat_msgs WHERE room_id = ?').get(roomId).m;
}

function cleanGroupName(name) {
  const title = String(name === undefined || name === null ? '' : name).trim();
  if (!title) throw new Error('name_required');
  if (Array.from(title).length > MAX_GROUP_NAME) throw new Error('name_too_long');
  return title;
}

// グループを作る。作った人は自動で入る。名前は1〜30文字、メンバーは自分以外に1人以上
function createGroup(db, creatorId, name, memberUserIds) {
  const title = cleanGroupName(name);
  if (!userExists(db, creatorId)) throw new Error('forbidden');
  const others = [...new Set((memberUserIds || []).map(String))].filter((u) => u !== creatorId);
  if (others.length === 0) throw new Error('members_required');
  if (!others.every((u) => userExists(db, u))) throw new Error('unknown_member');
  return db.transaction(() => {
    const id = db.prepare("INSERT INTO chat_rooms (kind, name, created_by) VALUES ('group', ?, ?)").run(title, creatorId).lastInsertRowid;
    const add = db.prepare('INSERT INTO chat_members (room_id, user_id) VALUES (?, ?)');
    [creatorId, ...others].forEach((u) => add.run(id, u));
    return getRoom(db, id);
  })();
}

// メンバーの追加（グループのメンバーなら誰でも可）。追加された人にとって、追加前の発言は未読にしない
function addMembers(db, roomId, byUserId, userIds) {
  const room = getRoom(db, roomId);
  if (!room || room.kind !== 'group' || !isMember(db, roomId, byUserId)) throw new Error('forbidden');
  const ids = [...new Set((userIds || []).map(String))];
  if (ids.length === 0) throw new Error('members_required');
  if (!ids.every((u) => userExists(db, u))) throw new Error('unknown_member');
  const max = currentMaxMsgId(db, roomId);
  const added = [];
  db.transaction(() => {
    for (const u of ids) {
      if (isMember(db, roomId, u)) continue;
      db.prepare('INSERT INTO chat_members (room_id, user_id, last_read_id) VALUES (?, ?, ?)').run(roomId, u, max);
      added.push(u);
    }
  })();
  return added;
}

function leaveGroup(db, roomId, userId) {
  const room = getRoom(db, roomId);
  if (!room || room.kind !== 'group' || !isMember(db, roomId, userId)) throw new Error('forbidden');
  db.prepare('DELETE FROM chat_members WHERE room_id = ? AND user_id = ?').run(roomId, userId);
}

function renameGroup(db, roomId, byUserId, name) {
  const room = getRoom(db, roomId);
  if (!room || room.kind !== 'group' || !isMember(db, roomId, byUserId)) throw new Error('forbidden');
  db.prepare('UPDATE chat_rooms SET name = ? WHERE id = ?').run(cleanGroupName(name), roomId);
}

function filesOfMessages(db, msgIds) {
  if (msgIds.length === 0) return new Map();
  const rows = db
    .prepare(`SELECT id, msg_id, original_name, size, is_image, deleted_at FROM chat_files WHERE msg_id IN (${msgIds.map(() => '?').join(',')}) ORDER BY id`)
    .all(...msgIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.msg_id)) map.set(r.msg_id, []);
    map.get(r.msg_id).push({ id: r.id, name: r.original_name, size: r.size, is_image: !!r.is_image, deleted: !!r.deleted_at });
  }
  return map;
}

function toMessages(db, rows) {
  const files = filesOfMessages(db, rows.map((r) => r.id));
  const names = new Map(db.prepare('SELECT user_id, display_name FROM users').all().map((u) => [u.user_id, u.display_name]));
  return rows.map((r) => ({
    id: r.id,
    room_id: r.room_id,
    sender_id: r.sender_id,
    sender_name: names.get(r.sender_id) || r.sender_id,
    body: r.deleted_at ? '' : r.body,
    created_at: formatJst(r.created_at),
    files: r.deleted_at ? [] : files.get(r.id) || [],
    deleted: !!r.deleted_at,
  }));
}

// files: [{ originalName, storedName, size }]
function saveMessage(db, roomId, senderId, body, files = []) {
  if (!isMember(db, roomId, senderId)) throw new Error('forbidden');
  const text = String(body === undefined || body === null ? '' : body).trim();
  if (text.length > MAX_BODY) throw new Error('too_long');
  if (!text && files.length === 0) throw new Error('empty');
  if (files.length > MAX_FILES) throw new Error('too_many_files');
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO chat_msgs (room_id, sender_id, body) VALUES (?, ?, ?)').run(roomId, senderId, text).lastInsertRowid;
    const addFile = db.prepare('INSERT INTO chat_files (msg_id, original_name, stored_name, size, is_image) VALUES (?, ?, ?, ?, ?)');
    for (const f of files) {
      const ext = (f.originalName.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      addFile.run(id, f.originalName, f.storedName, f.size || 0, IMAGE_EXT.includes(ext) ? 1 : 0);
    }
    return toMessages(db, [db.prepare('SELECT * FROM chat_msgs WHERE id = ?').get(id)])[0];
  })();
}

// 自分が送ったメッセージを取り消す。本文は空にし、添付は削除済みにする（実体のファイル名を返すので、呼び出し側で消す）。
// 取り消し済みのものをもう一度取り消しても、何も起きない（storedNames は空）
function deleteMessage(db, msgId, userId) {
  const msg = db.prepare('SELECT * FROM chat_msgs WHERE id = ?').get(msgId);
  if (!msg || msg.sender_id !== userId || !isMember(db, msg.room_id, userId)) throw new Error('forbidden');
  return db.transaction(() => {
    if (msg.deleted_at) return { message: toMessages(db, [msg])[0], storedNames: [] };
    const files = db.prepare('SELECT id, stored_name FROM chat_files WHERE msg_id = ? AND deleted_at IS NULL').all(msgId);
    db.prepare("UPDATE chat_files SET deleted_at = datetime('now') WHERE msg_id = ? AND deleted_at IS NULL").run(msgId);
    db.prepare("UPDATE chat_msgs SET body = '', deleted_at = datetime('now') WHERE id = ?").run(msgId);
    return {
      message: toMessages(db, [db.prepare('SELECT * FROM chat_msgs WHERE id = ?').get(msgId)])[0],
      storedNames: files.map((f) => f.stored_name),
    };
  })();
}

function listMessages(db, roomId, limit = 100) {
  const rows = db.prepare('SELECT * FROM chat_msgs WHERE room_id = ? ORDER BY id DESC LIMIT ?').all(roomId, limit);
  return toMessages(db, rows.reverse());
}

function markRead(db, roomId, userId) {
  db.prepare('UPDATE chat_members SET last_read_id = ? WHERE room_id = ? AND user_id = ?').run(currentMaxMsgId(db, roomId), roomId, userId);
}

// 部屋ごとの未読数（自分が送ったもの・取り消されたものは数えない）
function unreadByRoom(db, userId) {
  const rows = db
    .prepare(
      `SELECT m.room_id AS room_id, COUNT(*) AS c
       FROM chat_members cm JOIN chat_msgs m ON m.room_id = cm.room_id AND m.id > cm.last_read_id AND m.sender_id != cm.user_id AND m.deleted_at IS NULL
       WHERE cm.user_id = ? GROUP BY m.room_id`
    )
    .all(userId);
  return Object.fromEntries(rows.map((r) => [r.room_id, r.c]));
}

function totalUnread(db, userId) {
  return Object.values(unreadByRoom(db, userId)).reduce((n, c) => n + c, 0);
}

// 画面の一覧用: 自分が入っているグループと、自分以外の全員との1対1
function listForUser(db, userId) {
  const unread = unreadByRoom(db, userId);
  const memberStmt = db.prepare(
    'SELECT u.user_id, u.display_name FROM chat_members cm JOIN users u ON u.user_id = cm.user_id WHERE cm.room_id = ? ORDER BY cm.joined_at, u.id'
  );
  const groups = db
    .prepare(
      `SELECT r.id, r.name, (SELECT MAX(id) FROM chat_msgs WHERE room_id = r.id) AS last_id
       FROM chat_rooms r JOIN chat_members cm ON cm.room_id = r.id AND cm.user_id = ?
       WHERE r.kind = 'group' ORDER BY COALESCE(last_id, 0) DESC, r.id DESC`
    )
    .all(userId)
    .map((g) => ({ room_id: g.id, name: g.name, members: memberStmt.all(g.id), unread: unread[g.id] || 0 }));
  const roomOf = db.prepare('SELECT id FROM chat_rooms WHERE dm_key = ?');
  const dms = db
    .prepare('SELECT user_id, display_name FROM users ORDER BY (user_id = ?) DESC, id') // 先頭は、自分だけのメモ
    .all(userId)
    .map((u) => {
      const room = roomOf.get(dmKey(userId, u.user_id));
      return {
        user_id: u.user_id,
        display_name: u.display_name,
        self: u.user_id === userId,
        room_id: room ? room.id : null,
        unread: room ? unread[room.id] || 0 : 0,
      };
    });
  return { groups, dms };
}

// 添付をダウンロードできるのは、その部屋のメンバーだけ
function getFileForUser(db, fileId, userId) {
  return (
    db
      .prepare(
        `SELECT f.* FROM chat_files f JOIN chat_msgs m ON m.id = f.msg_id
         JOIN chat_members cm ON cm.room_id = m.room_id AND cm.user_id = ?
         WHERE f.id = ? AND f.deleted_at IS NULL`
      )
      .get(userId, fileId) || null
  );
}

module.exports = {
  MAX_BODY, MAX_GROUP_NAME, MAX_FILES, MAX_FILE_SIZE, IMAGE_EXT,
  isMember, memberIds, getRoom, getOrCreateDm, createGroup, addMembers, leaveGroup, renameGroup,
  saveMessage, deleteMessage, listMessages, markRead, unreadByRoom, totalUnread, listForUser, getFileForUser,
};

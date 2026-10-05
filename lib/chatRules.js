// 「在宅の人1人 ↔ 社内の各人」だけが話せる、というルールを集めたモジュール

function getRemoteUser(db) {
  return db.prepare('SELECT id, user_id, display_name FROM users WHERE is_remote = 1').get() || null;
}

// 指定した1人だけを在宅にする。nullなら全解除
function setRemoteUser(db, id) {
  db.transaction(() => {
    db.prepare('UPDATE users SET is_remote = 0').run();
    if (id !== null && id !== undefined) {
      db.prepare('UPDATE users SET is_remote = 1 WHERE id = ?').run(id);
    }
  })();
}

function canPair(db, userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  const remote = getRemoteUser(db);
  if (!remote) return false;
  const aIsRemote = remote.user_id === userIdA;
  const bIsRemote = remote.user_id === userIdB;
  if (aIsRemote === bIsRemote) return false; // 社内同士
  const other = aIsRemote ? userIdB : userIdA;
  return !!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(other);
}

function peersOf(db, userId) {
  const remote = getRemoteUser(db);
  if (!remote) return [];
  if (remote.user_id === userId) {
    return db
      .prepare('SELECT id, user_id, display_name FROM users WHERE user_id != ? ORDER BY id')
      .all(userId);
  }
  return [remote];
}

module.exports = { getRemoteUser, setRemoteUser, canPair, peersOf };

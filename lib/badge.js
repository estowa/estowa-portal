// ホーム画面アイコンの赤い数字（バッジ）に使う、自分宛ての未読の合計
// 内訳: 未読のお知らせ + 未読のチャット + 自分が担当で未完了の「新着」タスク

const chatStore = require('./chatStore');

function unreadAnnouncements(db, userId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM announcements a
       WHERE COALESCE(a.created_by, '') != ?
         AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?)`
    )
    .get(userId, userId).n;
}

function unreadChat(db, userId) {
  return chatStore.totalUnread(db, userId);
}

// 新着タスク: まだ開いていない、または開いたあとに他の人が更新した（自分が作ったタスクの初回・自分の更新は数えない）
const UNREAD_TASKS_FROM = `FROM tasks t
       JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = ?
       LEFT JOIN task_seen s ON s.task_id = t.id AND s.user_id = ?
       WHERE t.status != 'done'
         AND ((s.task_id IS NULL AND COALESCE(t.created_by, '') != ?)
           OR (s.task_id IS NOT NULL AND t.updated_at > s.seen_at AND COALESCE(t.updated_by, '') != ?))`;

function unreadTasks(db, userId) {
  return db.prepare(`SELECT COUNT(*) AS n ${UNREAD_TASKS_FROM}`).get(userId, userId, userId, userId).n;
}

// 新着のタスクのid（ボードのカードの赤い点に使う）
function unreadTaskIds(db, userId) {
  return db.prepare(`SELECT t.id AS id ${UNREAD_TASKS_FROM}`).all(userId, userId, userId, userId).map((r) => r.id);
}

function unreadBreakdown(db, userId) {
  return { announcements: unreadAnnouncements(db, userId), chat: unreadChat(db, userId), tasks: unreadTasks(db, userId) };
}

function unreadTotal(db, userId) {
  const b = unreadBreakdown(db, userId);
  return b.announcements + b.chat + b.tasks;
}

// 数えられないとき（テーブルがないなど）はnull。バッジの失敗で、画面や通知を止めない
function unreadTotalSafe(db, userId) {
  try {
    return unreadTotal(db, userId);
  } catch (e) {
    return null;
  }
}

// 画面表示用。数えられないとき（テーブルがないなど）はnull
function unreadBreakdownSafe(db, userId) {
  try {
    return unreadBreakdown(db, userId);
  } catch (e) {
    return null;
  }
}

// タスクの詳細を開いたら「見た」ことにする
function markTaskSeen(db, userId, taskId) {
  db.prepare(
    `INSERT INTO task_seen (user_id, task_id, seen_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id, task_id) DO UPDATE SET seen_at = excluded.seen_at`
  ).run(userId, taskId);
}

module.exports = { unreadBreakdown, unreadBreakdownSafe, unreadTaskIds, unreadTotal, unreadTotalSafe, markTaskSeen };

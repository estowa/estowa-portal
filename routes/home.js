const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { toJstParts, nowJstDateStr } = require('../lib/jst');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const user = req.session.user;

  // お知らせ（最新3件）
  const announcements = db
    .prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 3')
    .all();

  // 自分の直近タスク（最大5件、未完了優先）
  const myTasks = db
    .prepare(
      `SELECT tasks.* FROM tasks
       JOIN task_assignees ON task_assignees.task_id = tasks.id
       WHERE task_assignees.user_id = ? AND tasks.status != 'done'
       ORDER BY tasks.due_at IS NULL, tasks.due_at ASC LIMIT 5`
    )
    .all(user.user_id);

  // 本日の勤怠状態（最後の打刻がinかoutか）
  const lastLog = db
    .prepare('SELECT * FROM attendance_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1')
    .get(user.user_id);
  const isCheckedIn = lastLog && lastLog.type === 'in';

  // 売上サマリー（今月の合計。sales_ordersにデータがなければnull表示）
  const today = new Date();
  const monthStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const salesRow = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM sales_orders WHERE strftime('%Y-%m', order_date) = ?")
    .get(monthStr);
  const salesSummary = {
    monthlyTotal: salesRow.cnt > 0 ? salesRow.total : null,
  };

  // 管理者向け: 本日のメンバー出勤状況（管理者は打刻不要なため代わりに表示）
  let teamAttendanceToday = null;
  if (user.role === 'admin') {
    const members = db
      .prepare("SELECT user_id, display_name FROM users WHERE role != 'admin' ORDER BY id")
      .all();
    const todayStr = nowJstDateStr();
    // UTC保存のため、直近2日分を広めに取得してJST変換後に本日分だけ絞り込む
    const recentLogs = db
      .prepare("SELECT * FROM attendance_logs WHERE datetime(logged_at) >= datetime('now', '-2 day') ORDER BY logged_at ASC")
      .all();
    const lastTypeToday = {};
    recentLogs.forEach((log) => {
      const { dateStr } = toJstParts(log.logged_at);
      if (dateStr !== todayStr) return;
      lastTypeToday[log.user_id] = log.type; // 昇順なのでその日最後の打刻が残る
    });
    teamAttendanceToday = members.map((m) => {
      const status = lastTypeToday[m.user_id] || 'none';
      const label = status === 'in' ? '出勤中' : status === 'out' ? '退勤済' : '未出勤';
      return { name: m.display_name, status, label };
    });
  }

  res.render('home', {
    user,
    announcements,
    myTasks,
    isCheckedIn,
    salesSummary,
    teamAttendanceToday,
  });
});

module.exports = router;

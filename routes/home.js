const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

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

  res.render('home', {
    user,
    announcements,
    myTasks,
    isCheckedIn,
    salesSummary,
  });
});

module.exports = router;

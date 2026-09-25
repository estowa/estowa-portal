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
      "SELECT * FROM tasks WHERE user_id = ? AND status != 'done' ORDER BY due_date IS NULL, due_date ASC LIMIT 5"
    )
    .all(user.user_id);

  // 本日の勤怠状態（最後の打刻がinかoutか）
  const lastLog = db
    .prepare('SELECT * FROM attendance_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1')
    .get(user.user_id);
  const isCheckedIn = lastLog && lastLog.type === 'in';

  // 売上サマリー（フェーズ3で本実装。現時点は仮データ）
  const salesSummary = {
    monthlyTotal: null, // ROBOTIN CSV連携後に実データへ
    monthlyChangePct: null,
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

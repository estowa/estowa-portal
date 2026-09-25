const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// 出勤・退勤の打刻（ホーム画面のボタンから呼ばれる）
router.post('/attendance/punch', requireLogin, (req, res) => {
  const user = req.session.user;

  const lastLog = db
    .prepare('SELECT * FROM attendance_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1')
    .get(user.user_id);

  const nextType = lastLog && lastLog.type === 'in' ? 'out' : 'in';

  db.prepare('INSERT INTO attendance_logs (user_id, type) VALUES (?, ?)').run(user.user_id, nextType);

  res.redirect('/');
});

module.exports = router;

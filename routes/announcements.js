const express = require('express');
const db = require('../db/connection');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// お知らせ一覧
router.get('/announcements', requireLogin, (req, res) => {
  const announcements = db
    .prepare(
      `SELECT announcements.*, users.display_name AS author_name
       FROM announcements
       LEFT JOIN users ON users.user_id = announcements.created_by
       ORDER BY announcements.created_at DESC`
    )
    .all();

  res.render('announcements/index', { announcements, error: null });
});

// お知らせ投稿（管理者のみ）
router.post('/announcements', requireLogin, requireAdmin, (req, res) => {
  const { title, body } = req.body;
  if (!title) {
    const announcements = db
      .prepare(
        `SELECT announcements.*, users.display_name AS author_name
         FROM announcements
         LEFT JOIN users ON users.user_id = announcements.created_by
         ORDER BY announcements.created_at DESC`
      )
      .all();
    return res.render('announcements/index', { announcements, error: 'タイトルを入力してください' });
  }

  db.prepare('INSERT INTO announcements (title, body, created_by) VALUES (?, ?, ?)').run(
    title,
    body || '',
    req.session.user.user_id
  );
  res.redirect('/announcements');
});

// お知らせ削除（管理者のみ）
router.post('/announcements/:id/delete', requireLogin, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.redirect('/announcements');
});

module.exports = router;

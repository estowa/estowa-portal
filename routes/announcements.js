const express = require('express');
const db = require('../db/connection');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { avatarFor } = require('../lib/avatar');

const router = express.Router();

const ANNOUNCEMENT_SELECT = `SELECT announcements.*, users.display_name AS author_name,
    users.avatar_emoji AS author_avatar_emoji, users.avatar_color AS author_avatar_color,
    users.avatar_image AS author_avatar_image
   FROM announcements
   LEFT JOIN users ON users.user_id = announcements.created_by
   ORDER BY announcements.created_at DESC`;

function withAuthorAvatar(rows) {
  return rows.map((a) => ({
    ...a,
    authorAvatar: avatarFor({
      user_id: a.created_by,
      display_name: a.author_name,
      avatar_emoji: a.author_avatar_emoji,
      avatar_color: a.author_avatar_color,
      avatar_image: a.author_avatar_image,
    }),
  }));
}

// お知らせ一覧
router.get('/announcements', requireLogin, (req, res) => {
  const announcements = withAuthorAvatar(db.prepare(ANNOUNCEMENT_SELECT).all());
  res.render('announcements/index', { announcements, error: null });
});

// お知らせ投稿（管理者のみ）
router.post('/announcements', requireLogin, requireAdmin, (req, res) => {
  const { title, body } = req.body;
  if (!title) {
    const announcements = withAuthorAvatar(db.prepare(ANNOUNCEMENT_SELECT).all());
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

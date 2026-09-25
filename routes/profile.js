const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { avatarFor, COLOR_OPTIONS, EMOJI_OPTIONS } = require('../lib/avatar');

const router = express.Router();

// 自分のアイコン設定画面
router.get('/profile', requireLogin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.session.user.user_id);
  res.render('profile/icon', {
    profileUser: user,
    avatar: avatarFor(user),
    colorOptions: COLOR_OPTIONS,
    emojiOptions: EMOJI_OPTIONS,
    success: null,
  });
});

// 自分のアイコン(絵文字・色)を更新
router.post('/profile/icon', requireLogin, (req, res) => {
  const { avatar_emoji, avatar_color } = req.body;
  const emoji = EMOJI_OPTIONS.includes(avatar_emoji) ? avatar_emoji : null;
  const color = COLOR_OPTIONS.includes(avatar_color) ? avatar_color : null;

  db.prepare('UPDATE users SET avatar_emoji = ?, avatar_color = ? WHERE user_id = ?').run(
    emoji,
    color,
    req.session.user.user_id
  );

  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.session.user.user_id);
  res.render('profile/icon', {
    profileUser: user,
    avatar: avatarFor(user),
    colorOptions: COLOR_OPTIONS,
    emojiOptions: EMOJI_OPTIONS,
    success: 'アイコンを更新しました',
  });
});

module.exports = router;

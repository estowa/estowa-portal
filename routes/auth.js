const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');

const router = express.Router();

// ログイン画面表示
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

// ログイン処理
router.post('/login', (req, res) => {
  const { user_id, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'IDまたはパスワードが正しくありません' });
  }

  req.session.user = {
    id: user.id,
    user_id: user.user_id,
    display_name: user.display_name,
    role: user.role,
  };

  res.redirect('/');
});

// ログアウト
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;

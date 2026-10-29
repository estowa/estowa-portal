const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');
const { createLoginThrottle } = require('../lib/loginThrottle');

const router = express.Router();

const throttle = createLoginThrottle();
setInterval(() => throttle.sweep(), 60 * 60 * 1000).unref();

// ログイン画面表示
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

// ログイン処理
router.post('/login', (req, res, next) => {
  const { user_id, password } = req.body;

  if (throttle.isBlocked(user_id, req.ip)) {
    return res.status(429).render('login', { error: 'ログインの失敗が続いたため、しばらく待ってからやり直してください' });
  }

  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throttle.recordFailure(user_id, req.ip);
    return res.render('login', { error: 'IDまたはパスワードが正しくありません' });
  }

  throttle.recordSuccess(user_id);

  // ログインの前後でセッションIDを作り直す（事前に仕込まれたIDでの乗っ取りを防ぐ）
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = {
      id: user.id,
      user_id: user.user_id,
      display_name: user.display_name,
      role: user.role,
    };
    req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      res.redirect('/');
    });
  });
});

// ログアウト
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;

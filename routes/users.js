const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/connection');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const USER_LIST_SELECT = 'SELECT id, user_id, display_name, role, email, created_at FROM users ORDER BY id';

// ユーザー一覧（管理者のみ）
router.get('/users', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare(USER_LIST_SELECT).all();
  res.render('users/list', { users, error: null, success: null });
});

// ユーザー新規作成
router.post('/users', requireLogin, requireAdmin, (req, res) => {
  const { user_id, password, display_name, role, email } = req.body;
  const users = db.prepare(USER_LIST_SELECT).all();

  if (!user_id || !password || !display_name) {
    return res.render('users/list', { users, error: '全ての項目を入力してください', success: null });
  }

  const existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(user_id);
  if (existing) {
    return res.render('users/list', { users, error: 'このIDは既に使用されています', success: null });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (user_id, password_hash, display_name, role, email) VALUES (?, ?, ?, ?, ?)'
  ).run(user_id, hash, display_name, role === 'admin' ? 'admin' : 'member', email || null);

  const updatedUsers = db.prepare(USER_LIST_SELECT).all();
  res.render('users/list', { users: updatedUsers, error: null, success: `${display_name} さんを追加しました` });
});

// メールアドレス更新（通知の送信先）
router.post('/users/:id/email', requireLogin, requireAdmin, (req, res) => {
  const { email } = req.body;
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || null, req.params.id);
  const users = db.prepare(USER_LIST_SELECT).all();
  res.render('users/list', { users, error: null, success: 'メールアドレスを更新しました' });
});

// 権限変更
router.post('/users/:id/role', requireLogin, requireAdmin, (req, res) => {
  const { role } = req.body;
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role === 'admin' ? 'admin' : 'member', req.params.id);
  res.redirect('/users');
});

// パスワードリセット
router.post('/users/:id/password', requireLogin, requireAdmin, (req, res) => {
  const { password } = req.body;
  const users = db.prepare(USER_LIST_SELECT).all();

  if (!password || password.length < 4) {
    return res.render('users/list', { users, error: 'パスワードは4文字以上にしてください', success: null });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.render('users/list', { users, error: null, success: 'パスワードを更新しました' });
});

// ユーザー削除
router.post('/users/:id/delete', requireLogin, requireAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.redirect('/users');
});

module.exports = router;

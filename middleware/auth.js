// ログイン必須ミドルウェア
function requireLogin(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login');
}

// 管理者権限必須ミドルウェア
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  return res.status(403).render('error', {
    message: 'この操作には管理者権限が必要です',
    user: req.session.user,
  });
}

module.exports = { requireLogin, requireAdmin };

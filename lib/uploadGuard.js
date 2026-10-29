// /uploads（タスク・お知らせ・ナレッジ・アイディアの添付、アバター）を、ログイン中の人にだけ渡す。
// 静的ファイルの配信はセッションより前にあるため、/uploads だけ先にセッションを読んでから確かめる。
// 画像の読み込みを邪魔しないよう、ログイン画面への転送ではなく 401 を返す

const { applyFreshUser } = require('./sessionUser');

function createUploadGuard(db) {
  return function uploadGuard(req, res, next) {
    const sessionUser = req.session && req.session.user;
    if (sessionUser) {
      const fresh = db
        .prepare('SELECT id, user_id, display_name, role FROM users WHERE user_id = ?')
        .get(sessionUser.user_id);
      if (applyFreshUser(req.session, fresh)) return next();
    }
    res.status(401).type('text/plain; charset=utf-8').send('ログインが必要です');
  };
}

module.exports = { createUploadGuard };

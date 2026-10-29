// 書き込み操作(POSTなど)が、このサイト自身の画面から来たものかを確かめる(CSRF対策)。
// 他のサイトに置かれた罠のページから、ログイン中のブラウザ経由で送られた操作を断る。
// ブラウザは POST に Sec-Fetch-Site / Origin を付けるので、それを見る。
// どちらも付かないもの（curl・サーバー間通信など）は、ブラウザ経由の罠ではないので通す

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

function isSameOriginRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host;
    } catch (e) {
      return false;
    }
  }
  return true;
}

function sameOriginGuard(req, res, next) {
  if (SAFE_METHODS.includes(req.method) || isSameOriginRequest(req)) return next();
  return res.status(403).render('error', {
    message: '不正なリクエストです。ポータルの画面から操作してください',
    user: req.session && req.session.user,
  });
}

module.exports = { sameOriginGuard, isSameOriginRequest };

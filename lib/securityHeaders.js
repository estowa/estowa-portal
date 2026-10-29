// 全ページに付けるセキュリティ関連のヘッダー。
// 画面内のスクリプトを制限するCSP（script-src）は、各ページのインラインスクリプトが動かなくなるため入れていない。
// 入れているのは、他サイトへの埋め込み(クリックジャッキング)・<base>や外部への送信先のすり替え・プラグイン読み込みを防ぐ部分だけ

const SIX_MONTHS = 15552000;

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // 通話で使うマイクだけを許可する
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', `max-age=${SIX_MONTHS}`);
  next();
}

module.exports = { securityHeaders };

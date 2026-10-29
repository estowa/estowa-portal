// public/uploads 以下のファイルを返すときのヘッダー。
// ここはポータルと同じオリジンなので、HTML・SVGなどをそのまま開かせると、中のスクリプトが
// ログイン中の人の権限で動いてしまう。そこで、画像とPDF以外は「保存」させ（画面に表示しない）、
// 種類の推測もさせない

const path = require('path');

const INLINE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];

function setUploadHeaders(res, filePath, uploadsRoot) {
  const rel = path.relative(uploadsRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!INLINE_EXT.includes(path.extname(filePath).toLowerCase())) {
    res.setHeader('Content-Disposition', 'attachment');
  }
}

module.exports = { setUploadHeaders, INLINE_EXT };

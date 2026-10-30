// お知らせ本文のURLをリンクにする。本文は先にHTMLエスケープするので、タグは入れられない。
// リンクは別タブで開く。URLは半角英数字と記号の範囲だけ(後ろの日本語は含めない)。

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

function linkify(text) {
  return escapeHtml(text || '').replace(URL_RE, (url) => {
    // 文末の句読点・閉じかっこは、リンクに含めない
    const m = url.match(/[.,;:!?)\]]+$/);
    const trail = m ? m[0] : '';
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="body-link">${clean}</a>${trail}`;
  });
}

// 本文に含まれるURLを、出てきた順に重複なしで返す(リンクの一覧表示用)
function extractUrls(text) {
  const urls = [];
  (String(text || '').match(URL_RE) || []).forEach((url) => {
    const m = url.match(/[.,;:!?)\]]+$/);
    const clean = m ? url.slice(0, -m[0].length) : url;
    if (!urls.includes(clean)) urls.push(clean);
  });
  return urls;
}

module.exports = { linkify, escapeHtml, extractUrls };

// サイト保守の画面で使う、小さな整形関数。

const RANK = { urgent: 0, warn: 1, unknown: 2, ok: 3 };
const levelRank = (level) => (RANK[level] === undefined ? 9 : RANK[level]);

function hostLabel(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch (e) {
    return url;
  }
}

function expiryText(part, dateStr) {
  if (!dateStr || part.days === null) return '—';
  if (part.days < 0) return '期限切れ';
  return `あと${part.days}日`;
}

function staleText(part, dateStr) {
  if (!dateStr) return '記録なし';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${part.days}日前）`;
}

const partClass = (part) => (part.level === 'urgent' ? 'mt-urgent' : part.level === 'warn' ? 'mt-warn-text' : '');
const isExpiring = (st) => ['ssl', 'domain'].some((k) => ['warn', 'urgent'].includes(st.parts[k].level));
const clientTypeLabel = (t) => (t === 'own' ? '自社' : '受託');

module.exports = { levelRank, hostLabel, expiryText, staleText, partClass, isExpiring, clientTypeLabel };

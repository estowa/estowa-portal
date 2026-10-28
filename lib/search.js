// 全体検索: タスク・お知らせ・ナレッジ・アイディア・外注先を、タイトルと本文から探す。
// 空白で区切った語は「すべて含む」(AND)で絞る。ログイン済みの人が各画面で見られる範囲と同じ。

const LIMIT_PER_KIND = 20;
const SNIPPET_RADIUS = 40;

// LIKEの特殊文字(% _ \)を、そのままの文字として探すためにエスケープする
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => '\\' + c);
}

function splitTerms(q) {
  return String(q || '')
    .split(/[\s　]+/)
    .filter(Boolean)
    .slice(0, 5);
}

// 本文のうち、最初に語が見つかった前後だけを切り出す
function makeSnippet(text, terms) {
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const lower = plain.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return plain.slice(0, SNIPPET_RADIUS * 2) + (plain.length > SNIPPET_RADIUS * 2 ? '…' : '');
  const start = Math.max(0, pos - SNIPPET_RADIUS);
  const end = Math.min(plain.length, pos + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}

function runKind(db, { table, titleCol, bodyCol, extraCols, order }, terms) {
  const where = terms
    .map(() => `(${titleCol} LIKE ? ESCAPE '\\' OR COALESCE(${bodyCol}, '') LIKE ? ESCAPE '\\')`)
    .join(' AND ');
  const params = terms.flatMap((t) => {
    const like = `%${escapeLike(t)}%`;
    return [like, like];
  });
  return db
    .prepare(
      `SELECT id, ${titleCol} AS title, ${bodyCol} AS body ${extraCols} FROM ${table}
       WHERE ${where} ORDER BY ${order} LIMIT ${LIMIT_PER_KIND}`
    )
    .all(...params);
}

const KINDS = [
  { key: 'tasks', label: 'タスク', table: 'tasks', titleCol: 'title', bodyCol: 'description', extraCols: ', status, board', order: 'id DESC', href: (r) => `/tasks/${r.id}` },
  { key: 'announcements', label: 'お知らせ', table: 'announcements', titleCol: 'title', bodyCol: 'body', extraCols: '', order: 'id DESC', href: (r) => `/announcements/${r.id}` },
  { key: 'knowledge', label: 'ナレッジ', table: 'knowledge_articles', titleCol: 'title', bodyCol: 'body', extraCols: ', category', order: 'updated_at DESC', href: (r) => `/knowledge/${r.id}` },
  { key: 'ideas', label: 'アイディア', table: 'ideas', titleCol: 'title', bodyCol: 'body', extraCols: ', category', order: 'updated_at DESC', href: (r) => `/ideas/${r.id}` },
  // 外注先は、社名と、一覧に出ている用途・備考・URLが対象（連絡先は、一覧に出ていないので対象外）。リンクは一覧の該当の行
  { key: 'vendors', label: '外注先', table: 'vendors', titleCol: 'name', bodyCol: "COALESCE(notes, '') || ' ' || COALESCE(remarks, '') || ' ' || COALESCE(url, '')", extraCols: ', category', order: 'id DESC', href: (r) => `/vendors#vendor-${r.id}` },
];

function searchAll(db, q) {
  const terms = splitTerms(q);
  if (terms.length === 0) return { terms, groups: [] };

  const groups = KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    items: runKind(db, k, terms).map((r) => ({
      id: r.id,
      title: r.title,
      snippet: makeSnippet(r.body, terms),
      href: k.href(r),
      category: r.category || '',
      board: r.board || '',
    })),
  }));
  return { terms, groups };
}

module.exports = { searchAll, splitTerms, escapeLike, makeSnippet, LIMIT_PER_KIND };

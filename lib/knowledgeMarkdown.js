// ナレッジ記事の本文(Markdown)をHTMLにする。
// 通常のMarkdown(見出し・太字・リスト・表・リンク)に加えて、4種類の「枠」が使える:
//   :::重要
//   本文
//   :::
// 出力は必ずsanitizeを通す。許可するのは、決まった部品と、枠用のclassだけ。

const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

// 枠の名前 → CSSのclass
const CALLOUTS = {
  重要: 'important',
  注意: 'caution',
  ポイント: 'point',
  メモ: 'memo',
};

const CALLOUT_RE = /^:::(重要|注意|ポイント|メモ)[ \t]*\r?\n([\s\S]*?)\r?\n:::[ \t]*$/gm;
const MIN_HEADINGS_FOR_TOC = 3;

function expandCallouts(md) {
  return String(md || '').replace(CALLOUT_RE, (_m, name, inner) => {
    // 枠の中身もMarkdownとして解釈させるため、前後に空行を入れる
    return `<div class="callout callout-${CALLOUTS[name]}">\n<div class="callout-title">${name}</div>\n\n${inner}\n\n</div>`;
  });
}

const ALLOWED_CLASSES = ['callout', 'callout-important', 'callout-caution', 'callout-point', 'callout-memo', 'callout-title'];

function clean(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'img']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt'],
      a: ['href', 'name', 'target', 'rel'],
      div: ['class'],
    },
    allowedClasses: { div: ALLOWED_CLASSES },
    transformTags: {
      // 外部リンクは別タブで開く
      a: (tagName, attribs) => {
        const href = attribs.href || '';
        if (/^https?:\/\//i.test(href)) {
          return { tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } };
        }
        return { tagName, attribs };
      },
    },
  });
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// h2・h3に目印(id)を付け、目次用の一覧を作る
function addHeadingIds(html) {
  const toc = [];
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const id = `sec-${toc.length + 1}`;
    toc.push({ level: Number(level), id, text: stripTags(inner).trim() });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, toc };
}

// 戻り値: { html, toc } (tocは見出しが3つ以上のときだけ中身が入る)
function renderKnowledgeMarkdown(md) {
  // breaks: Enterを1回押した改行も、そのまま改行として表示する
  const html = clean(marked.parse(expandCallouts(md), { breaks: true }));
  const { html: withIds, toc } = addHeadingIds(html);
  return { html: withIds, toc: toc.length >= MIN_HEADINGS_FOR_TOC ? toc : [] };
}

module.exports = { renderKnowledgeMarkdown, expandCallouts, CALLOUTS };

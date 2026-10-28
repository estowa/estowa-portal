const test = require('node:test');
const assert = require('node:assert');
const { renderKnowledgeMarkdown } = require('../lib/knowledgeMarkdown');

const render = (md) => renderKnowledgeMarkdown(md).html;

test('4種類の枠が、背景つきの部品になる', () => {
  [['重要', 'important'], ['注意', 'caution'], ['ポイント', 'point'], ['メモ', 'memo']].forEach(([name, cls]) => {
    const html = render(`:::${name}\n内容です\n:::`);
    assert.match(html, new RegExp(`<div class="callout callout-${cls}">`));
    assert.match(html, new RegExp(`<div class="callout-title">${name}</div>`));
    assert.match(html, /内容です/);
  });
});

test('枠の中でも、太字・箇条書きが使える', () => {
  const html = render(':::重要\n**大事**な点\n\n- 一つ目\n- 二つ目\n:::');
  assert.match(html, /<strong>大事<\/strong>/);
  assert.match(html, /<li>一つ目<\/li>/);
});

test('表が表になる', () => {
  const html = render('| 担当 | 作業 |\n| --- | --- |\n| 経理 | 請求書 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>担当<\/th>/);
  assert.match(html, /<td>請求書<\/td>/);
});

test('見出し・番号リスト・リンクが使える。外部リンクは別タブ', () => {
  const html = render('## 手順\n\n1. 一つ目\n2. 二つ目\n\n[資料](https://example.com/a)');
  assert.match(html, /<h2 id="sec-1">手順<\/h2>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">資料<\/a>/);
});

test('危険なHTMLや、許可していないclassは通さない', () => {
  const html = render('<script>alert(1)</script>\n\n<div class="evil" onclick="x()">a</div>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('onclick') && !html.includes('onerror'));
  assert.ok(!html.includes('class="evil"'));
  assert.ok(!html.includes('javascript:'));
});

test('枠の記法でない:::は、そのまま文字になる', () => {
  assert.ok(!render(':::未定義\nあ\n:::').includes('callout'));
});

test('見出しが3つ以上のときだけ、目次の材料ができる', () => {
  assert.strictEqual(renderKnowledgeMarkdown('## a\n\n## b').toc.length, 0);
  const r = renderKnowledgeMarkdown('## a\n\n### b\n\n## c');
  assert.deepStrictEqual(r.toc.map((t) => [t.level, t.id, t.text]), [[2, 'sec-1', 'a'], [3, 'sec-2', 'b'], [2, 'sec-3', 'c']]);
});

test('既存の書き方（コード・引用）も壊れない／空の本文は空', () => {
  assert.match(render('`code`\n\n> 引用'), /<code>code<\/code>[\s\S]*<blockquote>/);
  assert.strictEqual(render(''), '');
  assert.strictEqual(render(null), '');
});

test('Enterを1回押した改行も、改行として表示される', () => {
  assert.match(render('一行目\n二行目'), /一行目<br ?\/?>\s*二行目/);
});

test('改行を保つ設定でも、枠・表・リストは崩れない', () => {
  const html = render(':::重要\n一行目\n二行目\n:::\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- x\n- y');
  assert.match(html, /callout-important/);
  assert.match(html, /一行目<br ?\/?>\s*二行目/);
  assert.match(html, /<table>/);
  assert.match(html, /<li>x<\/li>/);
});

test('表示する文字のないリンク [](URL) は、URLを表示する文字にする', () => {
  const { html } = renderKnowledgeMarkdown('[](https://estowa.jp/)');
  assert.match(html, /<a [^>]*href="https:\/\/estowa\.jp\/"[^>]*>https:\/\/estowa\.jp\/<\/a>/);
  assert.match(renderKnowledgeMarkdown('[自社サイト](https://estowa.jp/)').html, />自社サイト<\/a>/);
});

test('番号リストは、1. 2. 3. と続けて書ける（2. 以降も番号つきの一覧になる）', () => {
  const { html } = renderKnowledgeMarkdown('1. 見る\n2. 選ぶ\n3. 決める');
  assert.match(html, /<ol>/);
  assert.strictEqual((html.match(/<li>/g) || []).length, 3);
});

const test = require('node:test');
const assert = require('node:assert');
const { linkify } = require('../lib/linkify');

test('URLは、別タブで開くリンクになる', () => {
  const html = linkify('資料はこちら https://example.com/a?b=1 です');
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1" target="_blank" rel="noopener noreferrer"/);
  assert.ok(html.endsWith(' です'));
});

test('URLの後ろの日本語や句読点は、リンクに含めない', () => {
  assert.match(linkify('https://example.com/にアクセス'), /href="https:\/\/example\.com\/"/);
  const html = linkify('(https://example.com/x).');
  assert.match(html, /href="https:\/\/example\.com\/x"/);
});

test('HTMLタグや危険な文字は、リンクにも文字にもならない', () => {
  const html = linkify('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>') && !html.includes('<img'));
  assert.ok(!linkify('javascript:alert(1)').includes('<a '));
  const q = linkify('https://example.com/?a="><b>');
  assert.ok(!q.includes('<b>'));
});

test('URLがない本文や空の本文はそのまま', () => {
  assert.strictEqual(linkify('こんにちは'), 'こんにちは');
  assert.strictEqual(linkify(null), '');
});

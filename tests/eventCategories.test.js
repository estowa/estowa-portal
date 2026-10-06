const test = require('node:test');
const assert = require('node:assert');
const { EVENT_CATEGORY_DEFS, normalizeCategory, categoryClass } = require('../lib/eventCategories');

test('定義済みの種類はそのまま返る', () => {
  EVENT_CATEGORY_DEFS.forEach((d) => assert.strictEqual(normalizeCategory(d.key), d.key));
});

test('未設定・不正な種類は「セール・販促」（従来の見た目）になる', () => {
  [undefined, null, '', 'hack', '<script>'].forEach((v) => assert.strictEqual(normalizeCategory(v), 'sale'));
});

test('種類ごとに別の色クラスが付く', () => {
  const classes = EVENT_CATEGORY_DEFS.map((d) => categoryClass(d.key));
  assert.strictEqual(new Set(classes).size, EVENT_CATEGORY_DEFS.length);
  assert.strictEqual(categoryClass(null), 'cat-sale');
});

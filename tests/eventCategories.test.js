const test = require('node:test');
const assert = require('node:assert');
const { EVENT_CATEGORY_DEFS, normalizeCategory, categoryClass } = require('../lib/eventCategories');

test('種類は、楽天・Yahoo!・カウシェ・メルカリ・Qoo10・ギフトモール・メルカリShopsの順で並ぶ', () => {
  const labels = EVENT_CATEGORY_DEFS.filter((d) => d.key !== 'none').map((d) => d.label);
  assert.deepStrictEqual(labels, ['楽天', 'Yahoo!', 'カウシェ', 'メルカリ', 'Qoo10', 'ギフトモール', 'メルカリShops']);
});

test('定義済みの種類はそのまま返る', () => {
  EVENT_CATEGORY_DEFS.forEach((d) => assert.strictEqual(normalizeCategory(d.key), d.key));
});

test('未設定・不正な値・旧い種類は「指定なし」になる', () => {
  [undefined, null, '', 'hack', '<script>', 'sale', 'shoot', 'due', 'internal', 'other'].forEach((v) =>
    assert.strictEqual(normalizeCategory(v), 'none'));
});

test('種類ごとに別の色クラスが付く', () => {
  const classes = EVENT_CATEGORY_DEFS.map((d) => categoryClass(d.key));
  assert.strictEqual(new Set(classes).size, EVENT_CATEGORY_DEFS.length);
  assert.strictEqual(categoryClass(null), 'cat-none');
});

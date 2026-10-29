const test = require('node:test');
const assert = require('node:assert');
const { CATEGORY_DEFS, colorForCategory } = require('../lib/ideaCategories');
const knowledge = require('../lib/knowledgeCategories');

test('アイディアのカテゴリはビジネス・ツール・メモの3つ', () => {
  assert.deepStrictEqual(CATEGORY_DEFS.map(([n]) => n), ['ビジネス', 'ツール', 'メモ']);
  assert.notStrictEqual(colorForCategory('ビジネス'), colorForCategory('ツール'));
  assert.strictEqual(colorForCategory('その他'), colorForCategory('メモ'));
});

test('ナレッジのカテゴリは「採用・研修」でなく「カスタマーサポート」', () => {
  assert.ok(knowledge.CATEGORIES.includes('カスタマーサポート'));
  assert.ok(!knowledge.CATEGORIES.includes('採用・研修'));
});

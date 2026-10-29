// アイディアのカテゴリ定義(表示順・色分け)
const CATEGORY_DEFS = [
  ['ビジネス', '#4aa8d8'],
  ['ツール', '#e1a75b'],
  ['メモ', '#9aa0ae'],
];

const CATEGORY_COLORS = Object.fromEntries(CATEGORY_DEFS);

function colorForCategory(category) {
  return CATEGORY_COLORS[category] || '#9aa0ae';
}

module.exports = { CATEGORY_DEFS, colorForCategory };

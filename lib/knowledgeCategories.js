// ナレッジ共有のカテゴリ定義(表示順・色分け)
const CATEGORY_DEFS = [
  ['業務マニュアル', '#4aa8d8'],
  ['デザイン制作', '#e15b8f'],
  ['EC運営', '#7bbf6a'],
  ['広告運用', '#e1a75b'],
  ['SNS運用', '#a15be1'],
  ['経理・総務', '#4ac2b3'],
  ['ツール活用', '#d8654a'],
  ['社内ルール', '#6a7bd8'],
  ['採用・研修', '#bfa15b'],
  ['その他', '#9aa0ae'],
];

const CATEGORIES = CATEGORY_DEFS.map(([name]) => name);
const CATEGORY_COLORS = Object.fromEntries(CATEGORY_DEFS);

function colorForCategory(category) {
  return CATEGORY_COLORS[category] || '#9aa0ae';
}

module.exports = { CATEGORY_DEFS, CATEGORIES, colorForCategory };

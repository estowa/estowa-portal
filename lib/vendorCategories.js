// 外注先リストのカテゴリ定義(表示順・色分け)
const CATEGORY_DEFS = [
  ['印刷', '#e1a75b'],
  ['特殊用紙', '#a15be1'],
  ['ステッカー・ラベル', '#e15b8f'],
  ['グッズ関連', '#7bbf6a'],
  ['アパレルプリント', '#4aa8d8'],
  ['サイン・ディスプレイ', '#3fb8b0'],
  ['県内業者', '#d9695f'],
  ['商品仕入先', '#5b7be1'],
  ['商品開発', '#c9a227'],
  ['その他', '#9aa0ae'],
];

const CATEGORIES = CATEGORY_DEFS.map(([name]) => name);
const CATEGORY_COLORS = Object.fromEntries(CATEGORY_DEFS);

function colorForCategory(category) {
  return CATEGORY_COLORS[category] || '#9aa0ae';
}

module.exports = { CATEGORY_DEFS, CATEGORIES, colorForCategory };

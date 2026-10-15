// イベントカレンダーの種類定義(表示順・色分け)＝出店しているモール
// key はDBに保存する値、cssClass は style.css の .event-chip.cat-* に対応する
const EVENT_CATEGORY_DEFS = [
  { key: 'rakuten', label: '楽天', cssClass: 'cat-rakuten' },
  { key: 'yahoo', label: 'Yahoo!', cssClass: 'cat-yahoo' },
  { key: 'cowcow', label: 'カウシェ', cssClass: 'cat-cowcow' },
  { key: 'mercari', label: 'メルカリ', cssClass: 'cat-mercari' },
  { key: 'qoo10', label: 'Qoo10', cssClass: 'cat-qoo10' },
  { key: 'giftmall', label: 'ギフトモール', cssClass: 'cat-giftmall' },
  { key: 'mercari_shops', label: 'メルカリShops', cssClass: 'cat-mercari-shops' },
  // 旧い種類(セール・販促など)で登録済みのイベントや、未設定のイベントはここに入る
  { key: 'none', label: '指定なし', cssClass: 'cat-none' },
];

const DEFAULT_KEY = 'none';
const KEYS = EVENT_CATEGORY_DEFS.map((d) => d.key);

// 未設定・不正な値・旧い種類は「指定なし」として扱う
function normalizeCategory(key) {
  return KEYS.includes(key) ? key : DEFAULT_KEY;
}

function categoryClass(key) {
  return EVENT_CATEGORY_DEFS.find((d) => d.key === normalizeCategory(key)).cssClass;
}

module.exports = { EVENT_CATEGORY_DEFS, normalizeCategory, categoryClass };

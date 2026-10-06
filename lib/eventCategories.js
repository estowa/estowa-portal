// イベントカレンダーの種類定義(表示順・色分け)
// key はDBに保存する値、cssClass は style.css の .event-chip.cat-* に対応する
const EVENT_CATEGORY_DEFS = [
  { key: 'sale', label: 'セール・販促', cssClass: 'cat-sale' },
  { key: 'shoot', label: '撮影・制作', cssClass: 'cat-shoot' },
  { key: 'due', label: '納期', cssClass: 'cat-due' },
  { key: 'internal', label: '社内', cssClass: 'cat-internal' },
  { key: 'other', label: 'その他', cssClass: 'cat-other' },
];

const DEFAULT_KEY = 'sale';
const KEYS = EVENT_CATEGORY_DEFS.map((d) => d.key);

// 未設定・不正な値は「セール・販促」(従来の見た目)として扱う
function normalizeCategory(key) {
  return KEYS.includes(key) ? key : DEFAULT_KEY;
}

function categoryClass(key) {
  return EVENT_CATEGORY_DEFS.find((d) => d.key === normalizeCategory(key)).cssClass;
}

module.exports = { EVENT_CATEGORY_DEFS, normalizeCategory, categoryClass };

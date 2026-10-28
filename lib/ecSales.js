const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');

const MALL_ORDER = ['楽天', 'ヤフー', 'カウシェ', 'メルカリ', 'Qoo10', 'ギフトモール'];

// 店舗名に含まれる文字からモール名を決める（先に見つかったものを採用）
const MALL_KEYWORDS = [
  ['楽天', '楽天'],
  ['Yahoo', 'ヤフー'],
  ['ヤフー', 'ヤフー'],
  ['カウシェ', 'カウシェ'],
  ['メルカリ', 'メルカリ'],
  ['Qoo10', 'Qoo10'],
  ['ギフトモール', 'ギフトモール'],
];

// 店舗名で判定できないときの予備（ROBOTIN出力の店舗ID）
const STORE_ID_TO_MALL = {
  296: '楽天',
  1070: 'ヤフー',
  4646736: 'Qoo10',
  7588758: 'カウシェ',
  15056676: 'メルカリ',
  8669150: 'ギフトモール',
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// CSVのバイト列を文字列にする（UTF-8として読めなければShift_JIS）
function decodeCsvBuffer(buffer) {
  const utf8Text = buffer.toString('utf-8');
  if (utf8Text.includes('�')) return iconv.decode(buffer, 'cp932');
  return utf8Text;
}

function readRecords(buffer) {
  return parse(decodeCsvBuffer(buffer), {
    columns: (header) => header.map((h) => String(h).trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });
}

function toAmount(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).replace(/[,¥円\s]/g, '');
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// 表記ゆれを、画面で使うモール名にそろえる（過去分CSV用）
function normalizeMall(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const hit = MALL_KEYWORDS.find(([kw]) => s.toLowerCase().includes(kw.toLowerCase()));
  return hit ? hit[1] : s;
}

function mallFromStore(storeName, storeId) {
  const name = String(storeName || '').trim();
  if (name) {
    const hit = MALL_KEYWORDS.find(([kw]) => name.toLowerCase().includes(kw.toLowerCase()));
    if (hit) return hit[1];
  }
  const id = parseInt(storeId, 10);
  if (STORE_ID_TO_MALL[id]) return STORE_ID_TO_MALL[id];
  return name || '';
}

// 数量。空・数字でないときは1個として扱う
function toQuantity(raw) {
  const n = toAmount(raw);
  return n !== null && n >= 0 ? n : 1;
}

// 受注日時（2026-10-27 08:29:17 など）から YYYY-MM を取る。読めなければ ''
function orderMonthOf(raw) {
  const m = String(raw || '').trim().replace(/\//g, '-').match(/^(\d{4})-(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

// 売上CSV（新仕様）。個人情報の列は名前で選んで読むので、あっても読み込まない
function parseOrderCsv(buffer) {
  const records = readRecords(buffer);
  const rows = [];
  let skipped = 0;
  records.forEach((r) => {
    // 1つの注文に複数の商品行があるため、明細ID（行の番号）があれば受注番号と組み合わせてキーにする
    const baseNo = String(r['受注番号'] || '').trim();
    const lineId = String(r['明細ID'] || '').trim();
    const orderNo = baseNo && lineId ? `${baseNo}#${lineId}` : baseNo;
    const mall = mallFromStore(r['店舗名'], r['店舗ID']);
    const amount = toAmount(r['請求金額']);
    if (!orderNo || !mall || amount === null) {
      skipped += 1;
      return;
    }
    rows.push({
      orderNo,
      mall,
      productCode: String(r['商品コード'] || '').trim(),
      amount,
      quantity: toQuantity(r['数量']),
      orderMonth: orderMonthOf(r['受注日時']),
    });
  });
  return { rows, skipped };
}

// 商品コード一覧（商品番号, 商品名）
function parseProductCsv(buffer) {
  const records = readRecords(buffer);
  const map = new Map();
  let skipped = 0;
  records.forEach((r) => {
    const code = String(r['商品番号'] || '').trim();
    const name = String(r['商品名'] || '').trim();
    if (!code || !name) {
      skipped += 1;
      return;
    }
    map.set(code, name);
  });
  return { rows: [...map].map(([code, name]) => ({ code, name })), skipped };
}

// 過去分のモール別月次売上（月, モール, 税込売上）
function parseMonthlyCsv(buffer) {
  const records = readRecords(buffer);
  const map = new Map();
  let skipped = 0;
  records.forEach((r) => {
    const month = String(r['月'] || '').trim().replace(/\//g, '-').replace(/^(\d{4})-(\d)$/, '$1-0$2');
    const mall = normalizeMall(r['モール']);
    const amount = toAmount(r['税込売上']);
    if (!MONTH_RE.test(month) || !mall || amount === null) {
      skipped += 1;
      return;
    }
    map.set(`${month}\t${mall}`, { month, mall, amount });
  });
  return { rows: [...map.values()], skipped };
}

// ファイル名の「10月発送分」「2026年10月」などから { year, month } を推測する。
// 年がなければ、今月以前になる直近の年を使う
function guessShipMonth(fileName, now = new Date()) {
  const name = String(fileName || '');
  let m = name.match(/(\d{4})\s*[年\-_.]\s*(\d{1,2})\s*月?/);
  if (m) return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
  m = name.match(/(\d{1,2})\s*月/);
  if (m) {
    const month = parseInt(m[1], 10);
    if (month < 1 || month > 12) return null;
    const cur = now.getFullYear() * 12 + now.getMonth();
    let year = now.getFullYear();
    if (year * 12 + (month - 1) > cur) year -= 1;
    return { year, month };
  }
  return null;
}

// ファイル全体の発送月を、受注日の「いちばん多い月」で決める（同数なら新しい月）。
// 発送月でダウンロードしたCSVには、前月末の注文も少し混ざるため、行ごとではなく全体で1つに決める
function detectShipMonthFromOrders(rows) {
  const counts = new Map();
  rows.forEach((r) => {
    if (r.orderMonth) counts.set(r.orderMonth, (counts.get(r.orderMonth) || 0) + 1);
  });
  let best = null;
  counts.forEach((n, ym) => {
    if (!best || n > best.n || (n === best.n && ym > best.ym)) best = { ym, n };
  });
  return best ? best.ym : null;
}

function hasMonthlyData(db, ym) {
  return !!db.prepare('SELECT 1 FROM ec_monthly_mall WHERE month = ? LIMIT 1').get(ym);
}

function monthStr(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function importOrders(db, rows, shipMonth, importedBy) {
  const exists = db.prepare('SELECT 1 FROM ec_order_items WHERE order_no = ?');
  const upsert = db.prepare(
    `INSERT INTO ec_order_items (order_no, ship_month, mall, product_code, amount, quantity, imported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_no) DO UPDATE SET
       ship_month = excluded.ship_month, mall = excluded.mall, product_code = excluded.product_code,
       amount = excluded.amount, quantity = excluded.quantity, imported_by = excluded.imported_by, imported_at = datetime('now')`
  );
  let inserted = 0;
  let updated = 0;
  db.transaction(() => {
    rows.forEach((r) => {
      if (exists.get(r.orderNo)) updated += 1; else inserted += 1;
      upsert.run(r.orderNo, shipMonth, r.mall, r.productCode, r.amount, r.quantity === undefined ? 1 : r.quantity, importedBy || null);
    });
  })();
  return { inserted, updated };
}

// 商品コード一覧は、アップのたびに全部入れ替える
function replaceProducts(db, rows) {
  const ins = db.prepare('INSERT INTO ec_products (code, name) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM ec_products').run();
    rows.forEach((r) => ins.run(r.code, r.name));
  })();
  return rows.length;
}

function upsertMonthly(db, rows) {
  const up = db.prepare(
    `INSERT INTO ec_monthly_mall (month, mall, amount) VALUES (?, ?, ?)
     ON CONFLICT(month, mall) DO UPDATE SET amount = excluded.amount, imported_at = datetime('now')`
  );
  db.transaction(() => rows.forEach((r) => up.run(r.month, r.mall, r.amount)))();
  return rows.length;
}

// 月のモール別売上。注文明細がある月は明細から、なければ過去分(月次)から。
// 戻り値: { source: 'orders'|'monthly'|'none', malls: { モール: { amount, count } }, total, count }
function mallTotalsForMonth(db, ym) {
  const items = db
    .prepare('SELECT mall, SUM(amount) AS amount, COUNT(*) AS count FROM ec_order_items WHERE ship_month = ? GROUP BY mall')
    .all(ym);
  if (items.length > 0) {
    return summarize('orders', items);
  }
  const monthly = db
    .prepare('SELECT mall, amount FROM ec_monthly_mall WHERE month = ?')
    .all(ym)
    .map((r) => ({ mall: r.mall, amount: r.amount, count: null }));
  if (monthly.length > 0) return summarize('monthly', monthly);
  return { source: 'none', malls: {}, total: 0, count: null };
}

function summarize(source, list) {
  const malls = {};
  let total = 0;
  let count = 0;
  let countKnown = true;
  list.forEach((r) => {
    malls[r.mall] = { amount: r.amount, count: r.count };
    total += r.amount;
    if (r.count === null) countKnown = false; else count += r.count;
  });
  return { source, malls, total, count: countKnown ? count : null };
}

// 商品コード別の売上（注文明細のある月のみ）
function productTotalsForMonth(db, ym) {
  return db
    .prepare(
      `SELECT i.product_code AS code, p.name AS name, SUM(i.amount) AS amount, COUNT(*) AS count, SUM(i.quantity) AS qty
       FROM ec_order_items i LEFT JOIN ec_products p ON p.code = i.product_code
       WHERE i.ship_month = ?
       GROUP BY i.product_code
       ORDER BY amount DESC, count DESC, code ASC`
    )
    .all(ym)
    .map((r) => ({ ...r, registered: r.name !== null, name: r.name !== null ? r.name : '' }));
}

// 商品コードごとの、モール別の件数・売上（注文明細のある月）。{ code: [{ mall, count, amount }] }
function productMallBreakdown(db, ym) {
  const out = {};
  db.prepare(
    `SELECT product_code AS code, mall, COUNT(*) AS count, SUM(quantity) AS qty, SUM(amount) AS amount
     FROM ec_order_items WHERE ship_month = ? GROUP BY product_code, mall
     ORDER BY amount DESC, count DESC`
  )
    .all(ym)
    .forEach((r) => {
      (out[r.code] = out[r.code] || []).push({ mall: r.mall, count: r.count, qty: r.qty, amount: r.amount });
    });
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 広告の入力を検査して整える。足りなければ null
function normalizeAd(input) {
  const mall = String(input.mall || '').trim();
  const start = String(input.start_date || '').trim();
  let end = String(input.end_date || '').trim();
  const title = String(input.title || '').trim();
  if (!mall || !title || !DATE_RE.test(start)) return null;
  if (!DATE_RE.test(end) || end < start) end = start;
  return {
    mall,
    start_date: start,
    end_date: end,
    title,
    content: String(input.content || '').trim(),
    price: String(input.price || '').trim(),
  };
}

function addAd(db, ad, userId) {
  return db
    .prepare('INSERT INTO ec_ads (mall, start_date, end_date, title, content, price, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ad.mall, ad.start_date, ad.end_date, ad.title, ad.content, ad.price, userId || null).lastInsertRowid;
}

function updateAd(db, id, ad, userId) {
  return db
    .prepare(
      `UPDATE ec_ads SET mall = ?, start_date = ?, end_date = ?, title = ?, content = ?, price = ?,
       updated_by = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(ad.mall, ad.start_date, ad.end_date, ad.title, ad.content, ad.price, userId || null, id).changes;
}

function deleteAd(db, id) {
  return db.prepare('DELETE FROM ec_ads WHERE id = ?').run(id).changes;
}

// 指定月と期間が重なる広告（モールの並び→開始日順）
function adsForMonth(db, ym) {
  const rows = db
    .prepare('SELECT * FROM ec_ads WHERE start_date <= ? AND end_date >= ? ORDER BY start_date, id')
    .all(`${ym}-31`, `${ym}-01`);
  const rank = (m) => {
    const i = MALL_ORDER.indexOf(m);
    return i < 0 ? MALL_ORDER.length : i;
  };
  return rows.sort((a, b) => rank(a.mall) - rank(b.mall) || (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id));
}

// 昨対比(%)。比較側が0以下ならnull
function changePercent(current, base) {
  if (!base || base <= 0) return null;
  return Math.round(((current - base) / base) * 1000) / 10;
}

// 指定月からさかのぼって n か月分の月(YYYY-MM)を古い順に返す
function lastMonths(year, month, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const idx = year * 12 + (month - 1) - i;
    out.push(monthStr(Math.floor(idx / 12), (idx % 12) + 1));
  }
  return out;
}

module.exports = {
  MALL_ORDER,
  MONTH_RE,
  decodeCsvBuffer,
  normalizeMall,
  mallFromStore,
  parseOrderCsv,
  parseProductCsv,
  parseMonthlyCsv,
  guessShipMonth,
  detectShipMonthFromOrders,
  hasMonthlyData,
  monthStr,
  importOrders,
  replaceProducts,
  upsertMonthly,
  mallTotalsForMonth,
  productTotalsForMonth,
  productMallBreakdown,
  normalizeAd,
  addAd,
  updateAd,
  deleteAd,
  adsForMonth,
  changePercent,
  lastMonths,
};

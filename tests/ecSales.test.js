const test = require('node:test');
const assert = require('node:assert');
const iconv = require('iconv-lite');
const Database = require('better-sqlite3');
const { ensureEcSchema } = require('../lib/ecSchema');
const ec = require('../lib/ecSales');

function makeDb() {
  const db = new Database(':memory:');
  ensureEcSchema(db);
  return db;
}
// 実データは使わず、ダミーの注文だけで作る（Shift_JIS）
const sjis = (text) => iconv.encode(text, 'cp932');

const ORDER_HEADER = 'コントロールカラム,受注番号,受注日時,店舗名,商品コード,商品名,配送先氏名,配送先郵便番号,配送先住所,配送先電話番号,注文者氏名,注文者メールアドレス,請求金額,支払方法,ステータスコード,取引ID,受ID,店舗ID';

test('モール名は店舗名の文字から決まり、店舗IDは予備', () => {
  assert.strictEqual(ec.mallFromStore('みんなのメール【楽天市場店】', ''), '楽天');
  assert.strictEqual(ec.mallFromStore('みんなのメール【Yahoo!店】', ''), 'ヤフー');
  assert.strictEqual(ec.mallFromStore('カウシェ', ''), 'カウシェ');
  assert.strictEqual(ec.mallFromStore('みんなのメール【メルカリShops店】', ''), 'メルカリ');
  assert.strictEqual(ec.mallFromStore('不明な店', '296'), '楽天');
  assert.strictEqual(ec.mallFromStore('不明な店', ''), '不明な店');
});

test('売上CSV(Shift_JIS)を読む: 個人情報の列は無視し、0円も取り込む', () => {
  const csv = [
    ORDER_HEADER,
    'U,A-001,2026-10-27 08:29:17,みんなのメール【楽天市場店】,10020200610-2,チーズ,,,,,,,1980,カード,2,1,2,296',
    'U,A-002,2026-10-27 01:33:21,みんなのメール【楽天市場店】,10020200616,りんご,,,,,,,0,ポイント全額,2,1,2,296',
    'U,A-003,2026-10-26 10:28:00,カウシェ,ss-1004,ぴんど,,,,,,,"1,776",カード,2,1,2,7588758',
    'U,,2026-10-26 10:28:00,カウシェ,ss-1004,受注番号なし,,,,,,,800,カード,2,1,2,7588758',
  ].join('\n');
  const { rows, skipped } = ec.parseOrderCsv(sjis(csv));
  assert.strictEqual(skipped, 1);
  assert.deepStrictEqual(rows, [
    { orderNo: 'A-001', mall: '楽天', productCode: '10020200610-2', amount: 1980, quantity: 1, orderMonth: '2026-10' },
    { orderNo: 'A-002', mall: '楽天', productCode: '10020200616', amount: 0, quantity: 1, orderMonth: '2026-10' },
    { orderNo: 'A-003', mall: 'カウシェ', productCode: 'ss-1004', amount: 1776, quantity: 1, orderMonth: '2026-10' },
  ]);
  assert.strictEqual(JSON.stringify(rows).includes('配送先'), false);
});

test('同じ受注番号を再アップしても二重計上しない(上書き)', () => {
  const db = makeDb();
  const rows = [
    { orderNo: 'A-001', mall: '楽天', productCode: 'p1', amount: 1000 },
    { orderNo: 'A-002', mall: 'ヤフー', productCode: 'p2', amount: 500 },
  ];
  assert.deepStrictEqual(ec.importOrders(db, rows, '2026-10', 'admin'), { inserted: 2, updated: 0 });
  assert.deepStrictEqual(ec.importOrders(db, rows, '2026-10', 'admin'), { inserted: 0, updated: 2 });
  const t = ec.mallTotalsForMonth(db, '2026-10');
  assert.strictEqual(t.total, 1500);
  assert.strictEqual(t.count, 2);
  // 金額が直った再アップは新しい値になる
  ec.importOrders(db, [{ orderNo: 'A-001', mall: '楽天', productCode: 'p1', amount: 1200 }], '2026-10');
  assert.strictEqual(ec.mallTotalsForMonth(db, '2026-10').malls['楽天'].amount, 1200);
});

test('別の月で再アップすると、その注文は新しい月に移る', () => {
  const db = makeDb();
  const r = [{ orderNo: 'A-001', mall: '楽天', productCode: 'p1', amount: 1000 }];
  ec.importOrders(db, r, '2026-10');
  ec.importOrders(db, r, '2026-11');
  assert.strictEqual(ec.mallTotalsForMonth(db, '2026-10').source, 'none');
  assert.strictEqual(ec.mallTotalsForMonth(db, '2026-11').total, 1000);
});

test('商品コード一覧は全部入れ替わり、商品別は商品名で出る(未登録も分かる)', () => {
  const db = makeDb();
  ec.replaceProducts(db, [{ code: 'p1', name: 'チーズ' }, { code: 'old', name: '旧商品' }]);
  ec.replaceProducts(db, [{ code: 'p1', name: 'チーズ' }, { code: 'p2', name: 'りんご' }]);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM ec_products').get().n, 2);
  ec.importOrders(db, [
    { orderNo: '1', mall: '楽天', productCode: 'p1', amount: 1000 },
    { orderNo: '2', mall: 'ヤフー', productCode: 'p1', amount: 0 },
    { orderNo: '3', mall: '楽天', productCode: 'p2', amount: 3000 },
    { orderNo: '4', mall: '楽天', productCode: 'zzz', amount: 10 },
  ], '2026-10');
  const rows = ec.productTotalsForMonth(db, '2026-10');
  assert.deepStrictEqual(rows.map((r) => [r.code, r.name, r.amount, r.count, r.registered]), [
    ['p2', 'りんご', 3000, 1, true],
    ['p1', 'チーズ', 1000, 2, true],
    ['zzz', '', 10, 1, false],
  ]);
});

test('商品コード一覧CSV(Shift_JIS)を読む', () => {
  const { rows } = ec.parseProductCsv(sjis('コントロールカラム,商品番号,商品名\nu,p1,チーズ\nu,p2,りんご\nu,,名前だけ'));
  assert.deepStrictEqual(rows, [{ code: 'p1', name: 'チーズ' }, { code: 'p2', name: 'りんご' }]);
});

test('過去分CSV: 表記ゆれをそろえ、同じ月・モールは上書き', () => {
  const csv = '月,モール,税込売上\n2021-10,楽天,1000\n2021-10,Yahoo,200\n2021-10,メルカリShops,30\n2021/11,楽天,5\n2021-13,楽天,1\n2021-10,楽天,1500\n2021-10,楽天,abc';
  const { rows, skipped } = ec.parseMonthlyCsv(Buffer.from(csv, 'utf-8'));
  assert.strictEqual(skipped, 2);
  const db = makeDb();
  ec.upsertMonthly(db, rows);
  const t = ec.mallTotalsForMonth(db, '2021-10');
  assert.strictEqual(t.source, 'monthly');
  assert.deepStrictEqual(Object.keys(t.malls).sort(), ['ヤフー', 'メルカリ', '楽天'].sort());
  assert.strictEqual(t.malls['楽天'].amount, 1500);
  assert.strictEqual(t.total, 1730);
  assert.strictEqual(ec.mallTotalsForMonth(db, '2021-11').malls['楽天'].amount, 5);
});

test('同じ月に明細と過去分がある場合は明細を使う(二重にしない)', () => {
  const db = makeDb();
  ec.upsertMonthly(db, [{ month: '2026-10', mall: '楽天', amount: 99999 }]);
  ec.importOrders(db, [{ orderNo: '1', mall: '楽天', productCode: 'p', amount: 100 }], '2026-10');
  const t = ec.mallTotalsForMonth(db, '2026-10');
  assert.strictEqual(t.source, 'orders');
  assert.strictEqual(t.total, 100);
});

test('ファイル名から発送月を推測する', () => {
  const now = new Date(2026, 9, 28); // 2026-10-28
  assert.deepStrictEqual(ec.guessShipMonth('10月発送分.csv', now), { year: 2026, month: 10 });
  assert.deepStrictEqual(ec.guessShipMonth('12月発送分.csv', now), { year: 2025, month: 12 });
  assert.deepStrictEqual(ec.guessShipMonth('2026年9月発送分.csv', now), { year: 2026, month: 9 });
  assert.strictEqual(ec.guessShipMonth('売上.csv', now), null);
});

test('昨対比と、さかのぼる月の一覧', () => {
  assert.strictEqual(ec.changePercent(120, 100), 20);
  assert.strictEqual(ec.changePercent(80, 100), -20);
  assert.strictEqual(ec.changePercent(100, 0), null);
  assert.deepStrictEqual(ec.lastMonths(2026, 2, 3), ['2025-12', '2026-01', '2026-02']);
});

test('発送月は受注日のいちばん多い月で、ファイル全体で1つに決まる', () => {
  const csv = [
    ORDER_HEADER,
    'U,A-1,2026-10-31 23:00:00,みんなのメール【楽天市場店】,p1,x,,,,,,,100,カード,2,1,2,296',
    'U,A-2,2026-11-01 08:00:00,みんなのメール【楽天市場店】,p1,x,,,,,,,100,カード,2,1,2,296',
    'U,A-3,2026-11-02 08:00:00,みんなのメール【楽天市場店】,p1,x,,,,,,,100,カード,2,1,2,296',
  ].join('\n');
  const { rows } = ec.parseOrderCsv(sjis(csv));
  assert.deepStrictEqual(rows.map((r) => r.orderMonth), ['2026-10', '2026-11', '2026-11']);
  assert.strictEqual(ec.detectShipMonthFromOrders(rows), '2026-11');
  assert.strictEqual(ec.detectShipMonthFromOrders([{ orderMonth: '2026-10' }, { orderMonth: '2026-11' }]), '2026-11');
  assert.strictEqual(ec.detectShipMonthFromOrders([{ orderMonth: '' }]), null);
});

test('過去分(月次)のある月かどうかが分かる', () => {
  const db = makeDb();
  ec.upsertMonthly(db, [{ month: '2026-10', mall: '楽天', amount: 1 }]);
  assert.strictEqual(ec.hasMonthlyData(db, '2026-10'), true);
  assert.strictEqual(ec.hasMonthlyData(db, '2026-11'), false);
});

test('商品ごとの、モール別の件数と売上', () => {
  const db = makeDb();
  ec.importOrders(db, [
    { orderNo: '1', mall: '楽天', productCode: 'p1', amount: 1000 },
    { orderNo: '2', mall: '楽天', productCode: 'p1', amount: 500 },
    { orderNo: '3', mall: 'ヤフー', productCode: 'p1', amount: 0 },
    { orderNo: '4', mall: 'ヤフー', productCode: 'p2', amount: 300 },
  ], '2026-11');
  const b = ec.productMallBreakdown(db, '2026-11');
  assert.deepStrictEqual(b.p1, [
    { mall: '楽天', count: 2, qty: 2, amount: 1500 },
    { mall: 'ヤフー', count: 1, qty: 1, amount: 0 },
  ]);
  assert.deepStrictEqual(b.p2, [{ mall: 'ヤフー', count: 1, qty: 1, amount: 300 }]);
});

test('広告: 必須項目の検査、追加・編集・削除、月と重なるものだけ表示', () => {
  const db = makeDb();
  assert.strictEqual(ec.normalizeAd({ mall: '楽天', title: '', start_date: '2026-11-01' }), null);
  assert.strictEqual(ec.normalizeAd({ mall: '楽天', title: 'a', start_date: 'x' }), null);
  const ad = ec.normalizeAd({ mall: '楽天', title: ' クーポン ', start_date: '2026-10-28', end_date: '2026-11-05', price: '20%OFF' });
  assert.strictEqual(ad.title, 'クーポン');
  const id = ec.addAd(db, ad, 'admin');
  ec.addAd(db, ec.normalizeAd({ mall: 'ヤフー', title: '単日', start_date: '2026-11-10', end_date: '2026-11-01' }), 'admin');
  ec.addAd(db, ec.normalizeAd({ mall: 'ヤフー', title: '12月だけ', start_date: '2026-12-01' }), 'admin');
  assert.deepStrictEqual(ec.adsForMonth(db, '2026-11').map((a) => a.title), ['クーポン', '単日']);
  assert.deepStrictEqual(ec.adsForMonth(db, '2026-10').map((a) => a.title), ['クーポン']);
  assert.strictEqual(ec.adsForMonth(db, '2026-11')[1].end_date, '2026-11-10');
  ec.updateAd(db, id, { ...ad, title: '更新後' }, 'admin');
  assert.strictEqual(ec.adsForMonth(db, '2026-10')[0].title, '更新後');
  ec.deleteAd(db, id);
  assert.strictEqual(ec.adsForMonth(db, '2026-10').length, 0);
});

test('数量は個数として集計し、1注文に複数の商品行があっても取りこぼさない', () => {
  const header = 'コントロールカラム,受注番号,受注日時,店舗名,商品コード,商品名,数量,請求金額,支払方法,ステータスコード,明細ID,受注ID,店舗ID';
  const csv = [
    header,
    'U,A-1,2026-11-01 08:00:00,みんなのメール【楽天市場店】,p1,x,3,3000,カード,2,501,1,296',
    'U,A-1,2026-11-01 08:00:00,みんなのメール【楽天市場店】,p2,y,1,500,カード,2,502,1,296',
    'U,A-2,2026-11-02 08:00:00,みんなのメール【Yahoo!店】,p1,x,,0,ポイント,2,503,2,1070',
  ].join('\n');
  const { rows } = ec.parseOrderCsv(sjis(csv));
  assert.deepStrictEqual(rows.map((r) => [r.orderNo, r.quantity]), [['A-1#501', 3], ['A-1#502', 1], ['A-2#503', 1]]);
  const db = makeDb();
  ec.importOrders(db, rows, '2026-11');
  ec.importOrders(db, rows, '2026-11'); // 再アップしても増えない
  const t = ec.mallTotalsForMonth(db, '2026-11');
  assert.strictEqual(t.count, 3);
  assert.strictEqual(t.total, 3500);
  const p1 = ec.productTotalsForMonth(db, '2026-11').find((r) => r.code === 'p1');
  assert.strictEqual(p1.qty, 4);
  assert.deepStrictEqual(ec.productMallBreakdown(db, '2026-11').p1.map((b) => [b.mall, b.qty]), [['楽天', 3], ['ヤフー', 1]]);
});

test('数量の列がない古いDBにも列が追加される', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE ec_order_items (order_no TEXT PRIMARY KEY, ship_month TEXT NOT NULL, mall TEXT NOT NULL, product_code TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, imported_by TEXT, imported_at TEXT NOT NULL DEFAULT (datetime('now')))");
  db.prepare("INSERT INTO ec_order_items (order_no, ship_month, mall, amount) VALUES ('1', '2026-10', '楽天', 100)").run();
  ensureEcSchema(db);
  assert.strictEqual(db.prepare('SELECT quantity FROM ec_order_items').get().quantity, 1);
});

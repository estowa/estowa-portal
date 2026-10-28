const express = require('express');
const multer = require('multer');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { eventsByDayForMonth } = require('../lib/events');
const { nowJstYearMonth } = require('../lib/jst');
const ec = require('../lib/ecSales');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const MAX_COMPARE_YEARS = 5;

// ブラウザによってはファイル名がlatin1で届くので、日本語に直す
function fileNameOf(file) {
  return Buffer.from(file.originalname, 'latin1').toString('utf8');
}

function redirectWith(res, params) {
  const q = new URLSearchParams(params).toString();
  res.redirect(`/sales?${q}`);
}

router.get('/sales', requireLogin, (req, res) => {
  const now = nowJstYearMonth();
  const year = parseInt(req.query.year, 10) || now.year;
  const month = Math.min(12, Math.max(1, parseInt(req.query.month, 10) || now.month));
  const monthStr = ec.monthStr(year, month);
  const compareYears = Math.min(MAX_COMPARE_YEARS, Math.max(1, parseInt(req.query.cmp, 10) || 1));
  const baseYear = year - compareYears;
  const baseStr = ec.monthStr(baseYear, month);

  let prevMonth = month - 1, prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  let nextMonth = month + 1, nextYear = year;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  const cur = ec.mallTotalsForMonth(db, monthStr);
  const base = ec.mallTotalsForMonth(db, baseStr);

  // モール別（当月と比較年の月）
  const mallNames = [...ec.MALL_ORDER];
  [...Object.keys(cur.malls), ...Object.keys(base.malls)].forEach((m) => {
    if (!mallNames.includes(m)) mallNames.push(m);
  });
  const mallRows = mallNames
    .map((mall, i) => {
      const c = cur.malls[mall];
      const b = base.malls[mall];
      return {
        mall,
        colorSlot: (i % 8) + 1,
        amount: c ? c.amount : 0,
        count: c ? c.count : null,
        baseAmount: b ? b.amount : 0,
        hasCurrent: !!c,
        hasBase: !!b,
        changePct: c && b ? ec.changePercent(c.amount, b.amount) : null,
      };
    })
    .filter((r) => r.hasCurrent || r.hasBase);
  const maxMallAmount = Math.max(1, ...mallRows.map((r) => Math.max(r.amount, r.baseAmount)));

  // 商品別（注文明細のある月だけ）。比較年に明細があれば昨対も出す
  let productRows = [];
  let unregistered = [];
  if (cur.source === 'orders') {
    const baseProducts = new Map();
    if (base.source === 'orders') {
      ec.productTotalsForMonth(db, baseStr).forEach((p) => baseProducts.set(p.code, p.amount));
    }
    productRows = ec.productTotalsForMonth(db, monthStr).map((p) => ({
      ...p,
      share: cur.total > 0 ? Math.round((p.amount / cur.total) * 1000) / 10 : null,
      baseAmount: baseProducts.has(p.code) ? baseProducts.get(p.code) : null,
      changePct: baseProducts.has(p.code) ? ec.changePercent(p.amount, baseProducts.get(p.code)) : null,
    }));
    unregistered = productRows.filter((p) => !p.registered).map((p) => p.code || '(コードなし)');
  }
  const productCount = db.prepare('SELECT COUNT(*) AS n FROM ec_products').get().n;

  // 月別推移（直近12か月と、比較年の同じ月）
  const trend = ec.lastMonths(year, month, 12).map((ym) => {
    const [y, m] = ym.split('-');
    const baseYm = ec.monthStr(parseInt(y, 10) - compareYears, parseInt(m, 10));
    const t = ec.mallTotalsForMonth(db, ym);
    const b = ec.mallTotalsForMonth(db, baseYm);
    return {
      ym,
      total: t.total,
      hasData: t.source !== 'none',
      baseTotal: b.total,
      hasBase: b.source !== 'none',
    };
  });
  const maxTrendTotal = Math.max(1, ...trend.map((t) => Math.max(t.total, t.baseTotal)));

  const { eventsByDay, lastDay: calLastDay, firstWeekday: calFirstWeekday } = eventsByDayForMonth(year, month);

  res.render('sales/index', {
    year,
    month,
    monthStr,
    baseYear,
    baseStr,
    compareYears,
    maxCompareYears: MAX_COMPARE_YEARS,
    prevYear,
    prevMonth,
    nextYear,
    nextMonth,
    cur,
    base,
    changePct: cur.source !== 'none' && base.source !== 'none' ? ec.changePercent(cur.total, base.total) : null,
    mallRows,
    maxMallAmount,
    productRows,
    unregistered,
    productCount,
    trend,
    maxTrendTotal,
    eventsByDay,
    calLastDay,
    calFirstWeekday,
    thisYear: now.year,
    thisMonth: now.month,
    notice: req.query.notice || null,
    error: req.query.importError || null,
  });
});

// 売上CSV（新仕様）の取り込み。発送月は画面で指定（空ならファイル名から推測）
router.post('/sales/import', requireLogin, upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.redirect('/sales');
  let parsed;
  try {
    parsed = ec.parseOrderCsv(req.file.buffer);
  } catch (e) {
    return redirectWith(res, { importError: 'CSVの読み込みに失敗しました' });
  }
  if (parsed.rows.length === 0) {
    return redirectWith(res, { importError: '取り込める行がありませんでした（受注番号・店舗名・請求金額の列を確認してください）' });
  }
  // 発送月: 画面で指定があればそれ、なければファイル名（「11月発送分」など）、なければ受注日のいちばん多い月
  let year = parseInt(req.body.ship_year, 10);
  let month = parseInt(req.body.ship_month, 10);
  let basis = '指定';
  if (!year || !month) {
    const guess = ec.guessShipMonth(fileNameOf(req.file));
    if (guess) {
      ({ year, month } = guess);
      basis = 'ファイル名';
    } else {
      const ym = ec.detectShipMonthFromOrders(parsed.rows);
      if (!ym) return redirectWith(res, { importError: '発送月が分かりません。年と月を入れてください' });
      [year, month] = ym.split('-').map((n) => parseInt(n, 10));
      basis = '受注日';
    }
  }
  if (month < 1 || month > 12 || year < 2000 || year > 2100) {
    return redirectWith(res, { importError: '発送月が正しくありません' });
  }
  const r = ec.importOrders(db, parsed.rows, ec.monthStr(year, month), req.session.user.user_id);
  const skip = parsed.skipped > 0 ? `、${parsed.skipped}件は形式不正のためスキップ` : '';
  const warn = ec.hasMonthlyData(db, ec.monthStr(year, month))
    ? ' ※この月は過去分（月次）のデータもあります。明細が優先され、過去分は使われません。意図しない月なら発送月を指定して取り込み直してください'
    : '';
  redirectWith(res, {
    year,
    month,
    notice: `${year}年${month}月発送分（${basis}で判定）: 新規${r.inserted}件、上書き${r.updated}件を取り込みました${skip}${warn}`,
  });
});

// 商品コード一覧（全部入れ替え）
router.post('/sales/products/import', requireLogin, upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.redirect('/sales');
  let parsed;
  try {
    parsed = ec.parseProductCsv(req.file.buffer);
  } catch (e) {
    return redirectWith(res, { importError: 'CSVの読み込みに失敗しました' });
  }
  if (parsed.rows.length === 0) {
    return redirectWith(res, { importError: '取り込める行がありませんでした（商品番号・商品名の列を確認してください）' });
  }
  const n = ec.replaceProducts(db, parsed.rows);
  const skip = parsed.skipped > 0 ? `（${parsed.skipped}件は形式不正のためスキップ）` : '';
  redirectWith(res, { notice: `商品コード一覧を入れ替えました（${n}件）${skip}` });
});

// 過去分のモール別月次売上
router.post('/sales/monthly/import', requireLogin, upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.redirect('/sales');
  let parsed;
  try {
    parsed = ec.parseMonthlyCsv(req.file.buffer);
  } catch (e) {
    return redirectWith(res, { importError: 'CSVの読み込みに失敗しました' });
  }
  if (parsed.rows.length === 0) {
    return redirectWith(res, { importError: '取り込める行がありませんでした（月・モール・税込売上の列を確認してください）' });
  }
  const n = ec.upsertMonthly(db, parsed.rows);
  const skip = parsed.skipped > 0 ? `（${parsed.skipped}件は形式不正のためスキップ）` : '';
  redirectWith(res, { notice: `過去分のモール別売上を取り込みました（${n}件）${skip}` });
});

module.exports = router;

const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { eventsByDayForMonth } = require('../lib/events');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const MALL_ORDER = ['楽天', 'Yahoo!ショッピング', 'カウシェ', 'Qoo10', 'メルカリShops'];

function normalizeDate(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/\//g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function monthLabel(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

router.get('/sales', requireLogin, (req, res) => {
  const today = new Date();
  const year = parseInt(req.query.year, 10) || today.getFullYear();
  const month = parseInt(req.query.month, 10) || today.getMonth() + 1;
  const monthStr = monthLabel(year, month);

  // 前月
  let prevMonth = month - 1, prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  const prevMonthStr = monthLabel(prevYear, prevMonth);

  let nextMonth = month + 1, nextYear = year;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  const currentTotal = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM sales_orders WHERE strftime('%Y-%m', order_date) = ?")
    .get(monthStr);
  const prevTotal = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS total FROM sales_orders WHERE strftime('%Y-%m', order_date) = ?")
    .get(prevMonthStr);

  const changePct = prevTotal.total > 0
    ? Math.round(((currentTotal.total - prevTotal.total) / prevTotal.total) * 1000) / 10
    : null;

  // モール別内訳（当月）
  const mallRows = db
    .prepare("SELECT mall, COALESCE(SUM(amount),0) AS total FROM sales_orders WHERE strftime('%Y-%m', order_date) = ? GROUP BY mall")
    .all(monthStr);
  const mallTotals = {};
  mallRows.forEach((r) => { mallTotals[r.mall] = r.total; });
  const maxMallTotal = Math.max(1, ...Object.values(mallTotals));

  const mallBreakdown = MALL_ORDER.map((mall, i) => ({
    mall,
    total: mallTotals[mall] || 0,
    colorSlot: i + 1,
  })).filter((m) => m.total > 0 || mallTotals[m.mall] !== undefined);
  // 未知のモール名（CSVに新しいモールがあった場合）も追加
  Object.keys(mallTotals).forEach((mall) => {
    if (!MALL_ORDER.includes(mall)) {
      mallBreakdown.push({ mall, total: mallTotals[mall], colorSlot: (mallBreakdown.length % 8) + 1 });
    }
  });

  // 月別推移（過去6か月）
  const trend = db
    .prepare(
      `SELECT strftime('%Y-%m', order_date) AS ym, COALESCE(SUM(amount),0) AS total
       FROM sales_orders
       GROUP BY ym
       ORDER BY ym DESC
       LIMIT 6`
    )
    .all()
    .reverse();
  const maxTrendTotal = Math.max(1, ...trend.map((t) => t.total));

  // イベントカレンダー(各モールのセール期間などを記録。同じ年月ナビゲーションを共用)
  const { eventsByDay, lastDay: calLastDay, firstWeekday: calFirstWeekday } = eventsByDayForMonth(year, month);

  res.render('sales/index', {
    year,
    month,
    monthStr,
    prevYear,
    prevMonth,
    nextYear,
    nextMonth,
    currentTotal: currentTotal.total,
    currentCount: currentTotal.cnt,
    changePct,
    mallBreakdown,
    maxMallTotal,
    trend,
    maxTrendTotal,
    eventsByDay,
    calLastDay,
    calFirstWeekday,
    importResult: req.query.imported !== undefined
      ? { imported: parseInt(req.query.imported, 10) || 0, skipped: parseInt(req.query.skipped, 10) || 0 }
      : null,
    error: req.query.importError || null,
  });
});

router.post('/sales/import', requireLogin, upload.single('csvfile'), (req, res) => {
  if (!req.file) {
    return res.redirect('/sales');
  }

  const content = req.file.buffer.toString('utf-8');
  let records;
  try {
    records = parse(content, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (e) {
    return res.redirect('/sales?importError=CSVの読み込みに失敗しました');
  }

  let imported = 0;
  let skipped = 0;

  const insert = db.prepare(
    `INSERT INTO sales_orders (order_date, customer_name, mall, product_name, shipping_address, amount, imported_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertMany = db.transaction((rows) => {
    rows.forEach((row) => {
      const orderDate = normalizeDate(row['受注日']);
      const mall = (row['モール'] || '').trim();
      const amount = parseInt(String(row['金額'] || '0').replace(/[^\d-]/g, ''), 10) || 0;

      if (!orderDate || !mall) {
        skipped += 1;
        return;
      }

      insert.run(
        orderDate,
        row['氏名'] || '',
        mall,
        row['商品名'] || '',
        row['送付先'] || '',
        amount,
        req.session.user.user_id
      );
      imported += 1;
    });
  });

  insertMany(records);

  res.redirect(`/sales?imported=${imported}&skipped=${skipped}`);
});

module.exports = router;

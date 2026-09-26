// イベントカレンダー（EC売上ページ下部）: 各モールのセール期間などを直接書き込むためのCRUD
// 追加・編集・削除はEC売上ページ上でのみ行う想定(ホーム画面は表示のみ)
const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

function redirectToSales(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  if (y && m) {
    return `/sales?year=${y}&month=${m}#events`;
  }
  return '/sales#events';
}

router.post('/sales/events', requireLogin, (req, res) => {
  const { title, start_date, end_date, redirect_year, redirect_month } = req.body;
  const dest = redirectToSales(redirect_year, redirect_month);

  if (!title || !start_date) {
    return res.redirect(dest);
  }
  const endDate = end_date && end_date >= start_date ? end_date : start_date;

  db.prepare(
    'INSERT INTO events (title, start_date, end_date, created_by) VALUES (?, ?, ?, ?)'
  ).run(title.trim(), start_date, endDate, req.session.user.user_id);

  res.redirect(dest);
});

router.post('/sales/events/:id', requireLogin, (req, res) => {
  const { title, start_date, end_date, redirect_year, redirect_month } = req.body;
  const dest = redirectToSales(redirect_year, redirect_month);

  const existing = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!existing || !title || !start_date) {
    return res.redirect(dest);
  }
  const endDate = end_date && end_date >= start_date ? end_date : start_date;

  db.prepare(
    "UPDATE events SET title = ?, start_date = ?, end_date = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title.trim(), start_date, endDate, req.session.user.user_id, req.params.id);

  res.redirect(dest);
});

router.post('/sales/events/:id/delete', requireLogin, (req, res) => {
  const { redirect_year, redirect_month } = req.body;
  const dest = redirectToSales(redirect_year, redirect_month);

  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);

  res.redirect(dest);
});

module.exports = router;

const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/vendors', requireLogin, (req, res) => {
  const categoryFilter = req.query.category || '';

  const vendors = categoryFilter
    ? db.prepare('SELECT * FROM vendors WHERE category = ? ORDER BY category, name').all(categoryFilter)
    : db.prepare('SELECT * FROM vendors ORDER BY category, name').all();

  const categories = db
    .prepare("SELECT DISTINCT category FROM vendors WHERE category IS NOT NULL AND category != '' ORDER BY category")
    .all()
    .map((r) => r.category);

  res.render('vendors/index', { vendors, categories, categoryFilter, error: null });
});

router.post('/vendors', requireLogin, (req, res) => {
  const { category, name, contact_info, notes } = req.body;
  if (!name) return res.redirect('/vendors');

  db.prepare(
    'INSERT INTO vendors (category, name, contact_info, notes, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(category || '', name, contact_info || '', notes || '', req.session.user.user_id);

  res.redirect('/vendors');
});

router.post('/vendors/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
  res.redirect('/vendors');
});

module.exports = router;

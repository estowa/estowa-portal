const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { searchAll } = require('../lib/search');

const router = express.Router();

router.get('/search', requireLogin, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const { groups } = searchAll(db, q);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  res.render('search', { q, groups, total, searchQuery: q });
});

module.exports = router;

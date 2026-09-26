const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/sheet-links', requireLogin, (req, res) => {
  const links = db.prepare('SELECT * FROM sheet_links ORDER BY created_at DESC').all();
  res.render('sheet_links/index', { links });
});

router.post('/sheet-links', requireLogin, (req, res) => {
  const { title, url } = req.body;
  if (!title || !url) return res.redirect('/sheet-links');

  db.prepare('INSERT INTO sheet_links (title, url, created_by) VALUES (?, ?, ?)').run(
    title,
    url,
    req.session.user.user_id
  );
  res.redirect('/sheet-links');
});

router.post('/sheet-links/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM sheet_links WHERE id = ?').run(req.params.id);
  res.redirect('/sheet-links');
});

module.exports = router;

const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/sheet-links', requireLogin, (req, res) => {
  const tagFilter = req.query.tag || '';

  const allLinks = db.prepare('SELECT * FROM sheet_links ORDER BY created_at DESC').all();

  const allTags = new Set();
  allLinks.forEach((l) => {
    (l.tags || '').split(',').map((t) => t.trim()).filter(Boolean).forEach((t) => allTags.add(t));
  });

  const links = tagFilter
    ? allLinks.filter((l) => (l.tags || '').split(',').map((t) => t.trim()).includes(tagFilter))
    : allLinks;

  res.render('sheet_links/index', { links, tags: Array.from(allTags).sort(), tagFilter });
});

router.post('/sheet-links', requireLogin, (req, res) => {
  const { title, url, tags } = req.body;
  if (!title || !url) return res.redirect('/sheet-links');

  db.prepare('INSERT INTO sheet_links (title, url, tags, created_by) VALUES (?, ?, ?, ?)').run(
    title,
    url,
    tags || '',
    req.session.user.user_id
  );
  res.redirect('/sheet-links');
});

router.post('/sheet-links/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM sheet_links WHERE id = ?').run(req.params.id);
  res.redirect('/sheet-links');
});

module.exports = router;

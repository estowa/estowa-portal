const express = require('express');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

function renderMarkdown(md) {
  const rawHtml = marked.parse(md || '');
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'img']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt'],
      a: ['href', 'name', 'target', 'rel'],
    },
  });
}

// 一覧・検索
router.get('/knowledge', requireLogin, (req, res) => {
  const q = (req.query.q || '').trim();
  const categoryFilter = req.query.category || '';

  let articles = db
    .prepare(
      `SELECT knowledge_articles.*, users.display_name AS author_name
       FROM knowledge_articles
       LEFT JOIN users ON users.user_id = knowledge_articles.created_by
       ORDER BY knowledge_articles.updated_at DESC`
    )
    .all();

  if (categoryFilter) {
    articles = articles.filter((a) => a.category === categoryFilter);
  }
  if (q) {
    const lower = q.toLowerCase();
    articles = articles.filter(
      (a) => a.title.toLowerCase().includes(lower) || (a.body || '').toLowerCase().includes(lower)
    );
  }

  const categories = db
    .prepare("SELECT DISTINCT category FROM knowledge_articles WHERE category IS NOT NULL AND category != '' ORDER BY category")
    .all()
    .map((r) => r.category);

  res.render('knowledge/index', { articles, categories, categoryFilter, q });
});

// 新規作成フォーム
router.get('/knowledge/new', requireLogin, (req, res) => {
  res.render('knowledge/form', { article: null, error: null });
});

// 新規作成
router.post('/knowledge', requireLogin, (req, res) => {
  const { title, category, body } = req.body;
  if (!title) {
    return res.render('knowledge/form', { article: req.body, error: 'タイトルを入力してください' });
  }
  const result = db
    .prepare('INSERT INTO knowledge_articles (category, title, body, created_by) VALUES (?, ?, ?, ?)')
    .run(category || '', title, body || '', req.session.user.user_id);
  res.redirect('/knowledge/' + result.lastInsertRowid);
});

// 詳細表示
router.get('/knowledge/:id', requireLogin, (req, res) => {
  const article = db
    .prepare(
      `SELECT knowledge_articles.*, users.display_name AS author_name
       FROM knowledge_articles
       LEFT JOIN users ON users.user_id = knowledge_articles.created_by
       WHERE knowledge_articles.id = ?`
    )
    .get(req.params.id);
  if (!article) {
    return res.status(404).render('error', { message: '記事が見つかりません', user: req.session.user });
  }
  res.render('knowledge/show', { article, bodyHtml: renderMarkdown(article.body) });
});

// 編集フォーム
router.get('/knowledge/:id/edit', requireLogin, (req, res) => {
  const article = db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(req.params.id);
  if (!article) {
    return res.status(404).render('error', { message: '記事が見つかりません', user: req.session.user });
  }
  res.render('knowledge/form', { article, error: null });
});

// 更新
router.post('/knowledge/:id', requireLogin, (req, res) => {
  const { title, category, body } = req.body;
  if (!title) {
    return res.render('knowledge/form', { article: { id: req.params.id, ...req.body }, error: 'タイトルを入力してください' });
  }
  db.prepare(
    "UPDATE knowledge_articles SET title = ?, category = ?, body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, category || '', body || '', req.params.id);
  res.redirect('/knowledge/' + req.params.id);
});

// 削除
router.post('/knowledge/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(req.params.id);
  res.redirect('/knowledge');
});

module.exports = router;

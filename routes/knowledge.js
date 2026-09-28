const fs = require('fs');
const path = require('path');
const express = require('express');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { createUploader } = require('../lib/uploads');
const { CATEGORY_DEFS, colorForCategory } = require('../lib/knowledgeCategories');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'knowledge');
const { runUpload } = createUploader(UPLOAD_DIR, { maxFiles: 10, maxFileSize: 15 * 1024 * 1024 });

function attachmentsFor(articleId) {
  return db
    .prepare('SELECT * FROM knowledge_attachments WHERE article_id = ? ORDER BY uploaded_at ASC')
    .all(articleId);
}

function insertAttachments(articleId, files, uploadedBy) {
  if (!files || files.length === 0) return;
  const insert = db.prepare(
    'INSERT INTO knowledge_attachments (article_id, filename, original_name, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?)'
  );
  files.forEach((f) => {
    insert.run(articleId, f.filename, f.originalname, f.mimetype, uploadedBy);
  });
}

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

  res.render('knowledge/index', { articles, categories, categoryFilter, q, colorForCategory });
});

// 新規作成フォーム
router.get('/knowledge/new', requireLogin, (req, res) => {
  res.render('knowledge/form', { article: null, attachments: [], categoryDefs: CATEGORY_DEFS, error: null, uploadError: null });
});

// 新規作成
router.post('/knowledge', requireLogin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    const { title, category, body } = req.body;
    if (!title) {
      return res.render('knowledge/form', {
        article: req.body,
        attachments: [],
        categoryDefs: CATEGORY_DEFS,
        error: 'タイトルを入力してください',
        uploadError: uploadError || null,
      });
    }
    const result = db
      .prepare('INSERT INTO knowledge_articles (category, title, body, created_by) VALUES (?, ?, ?, ?)')
      .run(category || '', title, body || '', req.session.user.user_id);

    insertAttachments(result.lastInsertRowid, req.files, req.session.user.user_id);

    res.redirect('/knowledge/' + result.lastInsertRowid);
  });
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
  article.attachments = attachmentsFor(article.id);
  res.render('knowledge/show', { article, bodyHtml: renderMarkdown(article.body), colorForCategory });
});

// 編集フォーム
router.get('/knowledge/:id/edit', requireLogin, (req, res) => {
  const article = db.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(req.params.id);
  if (!article) {
    return res.status(404).render('error', { message: '記事が見つかりません', user: req.session.user });
  }
  res.render('knowledge/form', {
    article,
    attachments: attachmentsFor(article.id),
    categoryDefs: CATEGORY_DEFS,
    error: null,
    uploadError: null,
  });
});

// 更新
router.post('/knowledge/:id', requireLogin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    const { title, category, body } = req.body;
    if (!title) {
      return res.render('knowledge/form', {
        article: { id: req.params.id, ...req.body },
        attachments: attachmentsFor(req.params.id),
        categoryDefs: CATEGORY_DEFS,
        error: 'タイトルを入力してください',
        uploadError: uploadError || null,
      });
    }
    db.prepare(
      "UPDATE knowledge_articles SET title = ?, category = ?, body = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title, category || '', body || '', req.params.id);

    insertAttachments(req.params.id, req.files, req.session.user.user_id);

    res.redirect('/knowledge/' + req.params.id + '/edit');
  });
});

// 添付ファイルの削除
router.post('/knowledge/:id/attachments/:attId/delete', requireLogin, (req, res) => {
  const att = db
    .prepare('SELECT * FROM knowledge_attachments WHERE id = ? AND article_id = ?')
    .get(req.params.attId, req.params.id);
  if (att) {
    fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {});
    db.prepare('DELETE FROM knowledge_attachments WHERE id = ?').run(att.id);
  }
  res.redirect('/knowledge/' + req.params.id + '/edit');
});

// 削除
router.post('/knowledge/:id/delete', requireLogin, (req, res) => {
  const attachments = attachmentsFor(req.params.id);
  attachments.forEach((att) => fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {}));
  db.prepare('DELETE FROM knowledge_attachments WHERE article_id = ?').run(req.params.id);
  db.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(req.params.id);
  res.redirect('/knowledge');
});

module.exports = router;

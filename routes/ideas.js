const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { createUploader } = require('../lib/uploads');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'ideas');
const { runUpload } = createUploader(UPLOAD_DIR, { maxFiles: 10, maxFileSize: 15 * 1024 * 1024 });

// アイディア一覧のスライドインパネルからのfetchリクエストかどうか
// (この場合、ヘッダー・フッターを含まない断片HTML、またはJSONを返す)
function isFetch(req) {
  return req.headers['x-requested-with'] === 'fetch';
}

function attachmentsFor(ideaId) {
  return db
    .prepare('SELECT * FROM idea_attachments WHERE idea_id = ? ORDER BY uploaded_at ASC')
    .all(ideaId);
}

function insertAttachments(ideaId, files, uploadedBy) {
  if (!files || files.length === 0) return;
  const insert = db.prepare(
    'INSERT INTO idea_attachments (idea_id, filename, original_name, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?)'
  );
  files.forEach((f) => {
    insert.run(ideaId, f.filename, f.originalname, f.mimetype, uploadedBy);
  });
}

function existingCategories() {
  return db
    .prepare("SELECT DISTINCT category FROM ideas WHERE category IS NOT NULL AND category != '' ORDER BY category")
    .all()
    .map((r) => r.category);
}

// 一覧
router.get('/ideas', requireLogin, (req, res) => {
  const categoryFilter = req.query.category || '';

  let ideas = db
    .prepare(
      `SELECT ideas.*, users.display_name AS author_name
       FROM ideas
       LEFT JOIN users ON users.user_id = ideas.created_by
       ORDER BY ideas.created_at DESC`
    )
    .all();

  if (categoryFilter) {
    ideas = ideas.filter((i) => i.category === categoryFilter);
  }

  const categories = existingCategories();

  const payload = { ideas, categories, categoryFilter };
  res.render(isFetch(req) ? 'ideas/_list_content' : 'ideas/index', payload);
});

// 新規登録フォーム(スライドインパネル)
router.get('/ideas/new', requireLogin, (req, res) => {
  const payload = { idea: null, attachments: [], categories: existingCategories(), error: null, uploadError: null };
  res.render(isFetch(req) ? 'ideas/_form_content' : 'ideas/new', payload);
});

// 新規登録
router.post('/ideas', requireLogin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    const { title, category, body } = req.body;
    if (uploadError || !title) {
      const payload = {
        idea: req.body,
        attachments: [],
        categories: existingCategories(),
        error: !title ? 'タイトルを入力してください' : null,
        uploadError: uploadError || null,
      };
      const status = 400;
      if (isFetch(req)) return res.status(status).render('ideas/_form_content', payload);
      return res.status(status).render('ideas/new', payload);
    }

    const result = db
      .prepare('INSERT INTO ideas (category, title, body, created_by) VALUES (?, ?, ?, ?)')
      .run(category || '', title, body || '', req.session.user.user_id);

    insertAttachments(result.lastInsertRowid, req.files, req.session.user.user_id);

    if (isFetch(req)) return res.json({ redirect: '/ideas' });
    res.redirect('/ideas');
  });
});

// 編集フォーム(スライドインパネル)
router.get('/ideas/:id', requireLogin, (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) {
    return res.status(404).render('error', { message: 'アイディアが見つかりません', user: req.session.user });
  }
  const payload = {
    idea,
    attachments: attachmentsFor(idea.id),
    categories: existingCategories(),
    error: null,
    uploadError: null,
  };
  res.render(isFetch(req) ? 'ideas/_form_content' : 'ideas/edit', payload);
});

// 更新
router.post('/ideas/:id', requireLogin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
    if (!idea) {
      return res.status(404).render('error', { message: 'アイディアが見つかりません', user: req.session.user });
    }

    const { title, category, body } = req.body;
    if (uploadError || !title) {
      const payload = {
        idea: { ...idea, ...req.body },
        attachments: attachmentsFor(idea.id),
        categories: existingCategories(),
        error: !title ? 'タイトルを入力してください' : null,
        uploadError: uploadError || null,
      };
      const status = 400;
      if (isFetch(req)) return res.status(status).render('ideas/_form_content', payload);
      return res.status(status).render('ideas/edit', payload);
    }

    db.prepare(
      "UPDATE ideas SET title = ?, category = ?, body = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title, category || '', body || '', req.params.id);

    insertAttachments(req.params.id, req.files, req.session.user.user_id);

    if (isFetch(req)) return res.json({ redirect: '/ideas/' + req.params.id });
    res.redirect('/ideas/' + req.params.id);
  });
});

// 添付ファイルの削除
router.post('/ideas/:id/attachments/:attId/delete', requireLogin, (req, res) => {
  const att = db
    .prepare('SELECT * FROM idea_attachments WHERE id = ? AND idea_id = ?')
    .get(req.params.attId, req.params.id);
  if (att) {
    fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {});
    db.prepare('DELETE FROM idea_attachments WHERE id = ?').run(att.id);
  }
  if (isFetch(req)) return res.json({ redirect: '/ideas/' + req.params.id });
  res.redirect('/ideas/' + req.params.id);
});

// 削除
router.post('/ideas/:id/delete', requireLogin, (req, res) => {
  const attachments = attachmentsFor(req.params.id);
  attachments.forEach((att) => fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {}));
  db.prepare('DELETE FROM idea_attachments WHERE idea_id = ?').run(req.params.id);
  db.prepare('DELETE FROM ideas WHERE id = ?').run(req.params.id);
  if (isFetch(req)) return res.json({ redirect: '/ideas' });
  res.redirect('/ideas');
});

module.exports = router;

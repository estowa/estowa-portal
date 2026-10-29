const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { createUploader } = require('../lib/uploads');
const { CATEGORY_DEFS, colorForCategory } = require('../lib/ideaCategories');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'ideas');
const { runUpload } = createUploader(UPLOAD_DIR, { maxFiles: 10, maxFileSize: 15 * 1024 * 1024 });

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

// 決められた3つ以外(古いデータや不正な値)は、メモにする
function validCategory(category) {
  return CATEGORY_DEFS.some(([name]) => name === category) ? category : 'メモ';
}

function formPayload(extra) {
  return { idea: null, attachments: [], categoryDefs: CATEGORY_DEFS, error: null, uploadError: null, ...extra };
}

// 一覧・検索
router.get('/ideas', requireLogin, (req, res) => {
  const q = (req.query.q || '').trim();
  const categoryFilter = req.query.category || '';

  let ideas = db
    .prepare(
      `SELECT ideas.*, users.display_name AS author_name
       FROM ideas
       LEFT JOIN users ON users.user_id = ideas.created_by
       ORDER BY ideas.updated_at DESC`
    )
    .all();

  if (categoryFilter) {
    ideas = ideas.filter((i) => i.category === categoryFilter);
  }
  if (q) {
    const lower = q.toLowerCase();
    ideas = ideas.filter(
      (i) => i.title.toLowerCase().includes(lower) || (i.body || '').toLowerCase().includes(lower)
    );
  }

  res.render('ideas/index', {
    ideas,
    categories: CATEGORY_DEFS.map(([name]) => name),
    categoryFilter,
    q,
    colorForCategory,
  });
});

// 新規登録フォーム
router.get('/ideas/new', requireLogin, (req, res) => {
  res.render('ideas/form', formPayload());
});

// 新規登録
router.post('/ideas', requireLogin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    const { title, category, body } = req.body;
    if (uploadError || !title) {
      return res.status(400).render(
        'ideas/form',
        formPayload({
          idea: req.body,
          error: !title ? 'タイトルを入力してください' : null,
          uploadError: uploadError || null,
        })
      );
    }

    const result = db
      .prepare('INSERT INTO ideas (category, title, body, created_by) VALUES (?, ?, ?, ?)')
      .run(validCategory(category), title, body || '', req.session.user.user_id);

    insertAttachments(result.lastInsertRowid, req.files, req.session.user.user_id);

    res.redirect('/ideas');
  });
});

// 編集フォーム
router.get('/ideas/:id', requireLogin, (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) {
    return res.status(404).render('error', { message: 'アイディアが見つかりません', user: req.session.user });
  }
  res.render('ideas/form', formPayload({ idea, attachments: attachmentsFor(idea.id) }));
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
      return res.status(400).render(
        'ideas/form',
        formPayload({
          idea: { ...idea, ...req.body },
          attachments: attachmentsFor(idea.id),
          error: !title ? 'タイトルを入力してください' : null,
          uploadError: uploadError || null,
        })
      );
    }

    db.prepare(
      "UPDATE ideas SET title = ?, category = ?, body = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(title, validCategory(category), body || '', req.params.id);

    insertAttachments(req.params.id, req.files, req.session.user.user_id);

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
  res.redirect('/ideas/' + req.params.id);
});

// 削除
router.post('/ideas/:id/delete', requireLogin, (req, res) => {
  const attachments = attachmentsFor(req.params.id);
  attachments.forEach((att) => fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {}));
  db.prepare('DELETE FROM idea_attachments WHERE idea_id = ?').run(req.params.id);
  db.prepare('DELETE FROM ideas WHERE id = ?').run(req.params.id);
  res.redirect('/ideas');
});

module.exports = router;

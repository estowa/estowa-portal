const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db/connection');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { avatarFor } = require('../lib/avatar');
const { createUploader } = require('../lib/uploads');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'announcements');
const { runUpload } = createUploader(UPLOAD_DIR, { maxFiles: 10, maxFileSize: 15 * 1024 * 1024 });

const ANNOUNCEMENT_SELECT = `SELECT announcements.*, users.display_name AS author_name,
    users.avatar_emoji AS author_avatar_emoji, users.avatar_color AS author_avatar_color,
    users.avatar_image AS author_avatar_image
   FROM announcements
   LEFT JOIN users ON users.user_id = announcements.created_by
   ORDER BY announcements.created_at DESC`;

// 一覧用: ログイン中のユーザーがそのお知らせを既読かどうかも一緒に取得する
const ANNOUNCEMENT_SELECT_WITH_READ = `SELECT announcements.*, users.display_name AS author_name,
    users.avatar_emoji AS author_avatar_emoji, users.avatar_color AS author_avatar_color,
    users.avatar_image AS author_avatar_image,
    EXISTS(
      SELECT 1 FROM announcement_reads
      WHERE announcement_reads.announcement_id = announcements.id AND announcement_reads.user_id = ?
    ) AS is_read
   FROM announcements
   LEFT JOIN users ON users.user_id = announcements.created_by
   ORDER BY announcements.created_at DESC`;

function withAuthorAvatar(rows) {
  return rows.map((a) => ({
    ...a,
    authorAvatar: avatarFor({
      user_id: a.created_by,
      display_name: a.author_name,
      avatar_emoji: a.author_avatar_emoji,
      avatar_color: a.author_avatar_color,
      avatar_image: a.author_avatar_image,
    }),
  }));
}

function attachmentsFor(announcementId) {
  return db
    .prepare('SELECT * FROM announcement_attachments WHERE announcement_id = ? ORDER BY uploaded_at ASC')
    .all(announcementId);
}

function insertAttachments(announcementId, files, uploadedBy) {
  if (!files || files.length === 0) return;
  const insert = db.prepare(
    'INSERT INTO announcement_attachments (announcement_id, filename, original_name, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?)'
  );
  files.forEach((f) => {
    insert.run(announcementId, f.filename, f.originalname, f.mimetype, uploadedBy);
  });
}

function listUsers() {
  return db.prepare('SELECT user_id, display_name FROM users ORDER BY display_name').all();
}

// お知らせ一覧（タイトルのみ表示。既読状態も一緒に取得する）
router.get('/announcements', requireLogin, (req, res) => {
  const announcements = withAuthorAvatar(
    db.prepare(ANNOUNCEMENT_SELECT_WITH_READ).all(req.session.user.user_id)
  );
  res.render('announcements/index', { announcements, error: null });
});

// お知らせ新規投稿画面(専用ページ)
// ※ /announcements/:id より前に置く必要がある(そうしないと "new" がidとして解釈されてしまう)
router.get('/announcements/new', requireLogin, requireAdmin, (req, res) => {
  res.render('announcements/new', { error: req.query.error || null });
});

// お知らせ詳細（開いたタイミングで既読にする）
router.get('/announcements/:id', requireLogin, (req, res) => {
  const rows = withAuthorAvatar(
    db.prepare(ANNOUNCEMENT_SELECT.replace('ORDER BY', 'WHERE announcements.id = ? ORDER BY')).all(req.params.id)
  );
  const announcement = rows[0];
  if (!announcement) return res.status(404).render('error', { message: 'お知らせが見つかりません', user: req.session.user });

  announcement.attachments = attachmentsFor(announcement.id);

  db.prepare('INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)').run(
    announcement.id,
    req.session.user.user_id
  );

  res.render('announcements/show', { announcement });
});

// お知らせ投稿（管理者のみ・添付ファイルも同時に受け付ける）
router.post('/announcements', requireLogin, requireAdmin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    if (uploadError) {
      return res.redirect('/announcements/new?error=' + encodeURIComponent(uploadError));
    }

    const { title, body } = req.body;
    if (!title) {
      return res.redirect('/announcements/new?error=' + encodeURIComponent('タイトルを入力してください'));
    }

    const result = db
      .prepare('INSERT INTO announcements (title, body, created_by) VALUES (?, ?, ?)')
      .run(title, body || '', req.session.user.user_id);

    insertAttachments(result.lastInsertRowid, req.files, req.session.user.user_id);

    res.redirect('/announcements');
  });
});

// お知らせ編集画面（管理者のみ・投稿者の変更もここで行う）
router.get('/announcements/:id/edit', requireLogin, requireAdmin, (req, res) => {
  const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
  if (!announcement) return res.status(404).render('error', { message: 'お知らせが見つかりません', user: req.session.user });

  res.render('announcements/edit', {
    announcement,
    attachments: attachmentsFor(announcement.id),
    users: listUsers(),
    error: null,
    uploadError: req.query.uploadError || null,
  });
});

// お知らせ更新（タイトル・本文・投稿者・添付ファイル追加）
router.post('/announcements/:id', requireLogin, requireAdmin, (req, res) => {
  runUpload(req, res, (uploadError) => {
    const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
    if (!announcement) return res.status(404).render('error', { message: 'お知らせが見つかりません', user: req.session.user });

    if (uploadError) {
      return res.redirect('/announcements/' + req.params.id + '/edit?uploadError=' + encodeURIComponent(uploadError));
    }

    const { title, body, created_by } = req.body;
    if (!title) {
      return res.render('announcements/edit', {
        announcement,
        attachments: attachmentsFor(announcement.id),
        users: listUsers(),
        error: 'タイトルを入力してください',
        uploadError: null,
      });
    }

    const author = created_by || announcement.created_by;
    db.prepare('UPDATE announcements SET title = ?, body = ?, created_by = ? WHERE id = ?').run(
      title,
      body || '',
      author,
      req.params.id
    );

    insertAttachments(req.params.id, req.files, req.session.user.user_id);

    res.redirect('/announcements/' + req.params.id + '/edit');
  });
});

// お知らせ添付ファイルの削除（管理者のみ）
router.post('/announcements/:id/attachments/:attId/delete', requireLogin, requireAdmin, (req, res) => {
  const att = db
    .prepare('SELECT * FROM announcement_attachments WHERE id = ? AND announcement_id = ?')
    .get(req.params.attId, req.params.id);
  if (att) {
    fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {});
    db.prepare('DELETE FROM announcement_attachments WHERE id = ?').run(att.id);
  }
  res.redirect('/announcements/' + req.params.id + '/edit');
});

// お知らせ削除（管理者のみ・添付ファイルも合わせて削除）
router.post('/announcements/:id/delete', requireLogin, requireAdmin, (req, res) => {
  const attachments = attachmentsFor(req.params.id);
  attachments.forEach((att) => fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {}));
  db.prepare('DELETE FROM announcement_attachments WHERE announcement_id = ?').run(req.params.id);
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.redirect('/announcements');
});

module.exports = router;

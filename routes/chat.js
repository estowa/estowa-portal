const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { getRemoteUser, peersOf } = require('../lib/chatRules');
const store = require('../lib/chatStore');
const chatBus = require('../lib/chatBus');
const { createUploader } = require('../lib/uploads');

const router = express.Router();

// 添付の置き場は lib/chatFiles.js（公開フォルダ public/ の外。ダウンロードは部屋のメンバーだけに許す）
const { CHAT_FILES_DIR } = require('../lib/chatFiles');
const uploader = createUploader(CHAT_FILES_DIR, { maxFiles: store.MAX_FILES, maxFileSize: store.MAX_FILE_SIZE });

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function buildIceServers(env) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (env.TURN_URL) {
    servers.push({ urls: env.TURN_URL, username: env.TURN_USER || '', credential: env.TURN_PASS || '' });
  }
  return servers;
}

function buildChatState(database, userId, env) {
  const remote = getRemoteUser(database);
  const me = database.prepare('SELECT user_id, display_name FROM users WHERE user_id = ?').get(userId);
  const { groups, dms } = store.listForUser(database, userId);
  return {
    me: { user_id: me.user_id, display_name: me.display_name, isRemote: !!remote && remote.user_id === userId },
    remoteConfigured: !!remote,
    groups,
    dms,
    // 通話の相手（在宅の人 ↔ 社内の各人）。チャットとは別
    voicePeers: peersOf(database, userId).map((p) => ({ user_id: p.user_id, display_name: p.display_name })),
    iceServers: buildIceServers(env),
  };
}

const ERROR_STATUS = {
  forbidden: 403,
  empty: 400, too_long: 400, too_many_files: 400,
  name_required: 400, name_too_long: 400, members_required: 400, unknown_member: 400,
};
function fail(res, e) {
  const code = ERROR_STATUS[e.message] ? e.message : 'error';
  if (code === 'error') console.error('[chat]', e);
  res.status(ERROR_STATUS[code] || 500).json({ error: code });
}

function roomIdOf(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) ? id : 0;
}

router.get('/chat/state', requireLogin, (req, res) => {
  res.json(buildChatState(db, req.session.user.user_id, process.env));
});

// 1対1の部屋を開く（なければ作る）
router.post('/chat/dm/:userId', requireLogin, (req, res) => {
  try {
    const room = store.getOrCreateDm(db, req.session.user.user_id, req.params.userId);
    res.json({ room_id: room.id });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/chat/groups', requireLogin, (req, res) => {
  try {
    const me = req.session.user.user_id;
    const room = store.createGroup(db, me, req.body.name, req.body.members);
    chatBus.notifyRooms(store.memberIds(db, room.id));
    res.json({ room_id: room.id });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/chat/rooms/:id/members', requireLogin, (req, res) => {
  try {
    const roomId = roomIdOf(req);
    store.addMembers(db, roomId, req.session.user.user_id, req.body.members);
    chatBus.notifyRooms(store.memberIds(db, roomId));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/chat/rooms/:id/rename', requireLogin, (req, res) => {
  try {
    const roomId = roomIdOf(req);
    store.renameGroup(db, roomId, req.session.user.user_id, req.body.name);
    chatBus.notifyRooms(store.memberIds(db, roomId));
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/chat/rooms/:id/leave', requireLogin, (req, res) => {
  try {
    const roomId = roomIdOf(req);
    const me = req.session.user.user_id;
    const before = store.memberIds(db, roomId);
    store.leaveGroup(db, roomId, me);
    chatBus.notifyRooms(before);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/chat/rooms/:id/messages', requireLogin, (req, res) => {
  const roomId = roomIdOf(req);
  if (!store.isMember(db, roomId, req.session.user.user_id)) return res.status(403).json({ error: 'forbidden' });
  res.json({ messages: store.listMessages(db, roomId) });
});

// 添付つきの送信。保存に失敗したら、アップロードされたファイルも消す
router.post('/chat/rooms/:id/messages', requireLogin, (req, res) => {
  uploader.runUpload(req, res, (uploadError) => {
    if (uploadError) return res.status(400).json({ error: 'upload', message: uploadError });
    const files = (req.files || []).map((f) => ({ originalName: f.originalname, storedName: f.filename, size: f.size }));
    try {
      const message = store.saveMessage(db, roomIdOf(req), req.session.user.user_id, req.body.body, files);
      chatBus.publish(message);
      res.json({ message });
    } catch (e) {
      files.forEach((f) => fs.unlink(path.join(CHAT_FILES_DIR, f.storedName), () => {}));
      fail(res, e);
    }
  });
});

// 自分が送ったメッセージの取り消し。本文と添付の実体を消し、部屋の全員の画面に知らせる
router.post('/chat/messages/:id/delete', requireLogin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { message, storedNames } = store.deleteMessage(db, Number.isInteger(id) ? id : 0, req.session.user.user_id);
    storedNames.forEach((name) => fs.unlink(path.join(CHAT_FILES_DIR, path.basename(name)), () => {}));
    chatBus.publishDeleted(message.room_id, message.id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// 添付のダウンロード。画像（png/jpg/gif/webp）とPDFは、そのまま開いて見られる。それ以外は保存させる。
// ?download=1 を付けると、画像・PDFも保存（ダウンロード）になる
router.get('/chat/files/:id', requireLogin, (req, res) => {
  const file = store.getFileForUser(db, Number(req.params.id), req.session.user.user_id);
  if (!file) return res.status(404).send('見つかりません');
  const ext = path.extname(file.original_name).toLowerCase();
  const viewType = file.is_image && IMAGE_TYPES[ext] ? IMAGE_TYPES[ext] : ext === '.pdf' ? 'application/pdf' : null;
  const inline = !!viewType && req.query.download !== '1';
  const headers = {
    'Content-Type': inline ? viewType : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  };
  // 画像は何も実行させない設定にする。PDFはブラウザの表示機能が動かなくなるため、この設定は付けない（nosniffでHTMLとして解釈されるのは防ぐ）
  if (!inline || viewType !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  res.set(headers);
  res.sendFile(path.join(CHAT_FILES_DIR, path.basename(file.stored_name)), (err) => {
    if (err && !res.headersSent) res.status(404).send('見つかりません');
  });
});

module.exports = router;
module.exports.buildChatState = buildChatState;

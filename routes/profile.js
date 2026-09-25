const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { avatarFor, COLOR_OPTIONS, EMOJI_OPTIONS } = require('../lib/avatar');

const router = express.Router();

const AVATAR_UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      const safeExt = /^[a-zA-Z0-9.]*$/.test(ext) ? ext : '';
      cb(null, `${req.session.user.user_id}-${Date.now()}${safeExt}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype));
  },
});

function renderProfile(res, userId, extra) {
  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
  const avatar = avatarFor(user);

  // このリクエスト内で更新した内容を、サイドバーのアイコン(currentUser由来)にも反映する
  // (res.localsはミドルウェアで更新前のユーザー情報を元に設定済みのため)
  if (res.locals.currentUser && res.locals.currentUser.user_id === userId) {
    res.locals.currentUser = { ...res.locals.currentUser, ...user };
    res.locals.currentUserAvatar = avatar;
  }

  res.render('profile/icon', {
    profileUser: user,
    avatar,
    colorOptions: COLOR_OPTIONS,
    emojiOptions: EMOJI_OPTIONS,
    success: null,
    uploadError: null,
    ...extra,
  });
}

// アップロード済みの古いアイコン画像をディスクから削除する
function deleteOldAvatarImage(userId) {
  const user = db.prepare('SELECT avatar_image FROM users WHERE user_id = ?').get(userId);
  if (user && user.avatar_image) {
    const filename = user.avatar_image.split('/').pop();
    fs.unlink(path.join(AVATAR_UPLOAD_DIR, filename), () => {});
  }
}

// 自分のアイコン設定画面
router.get('/profile', requireLogin, (req, res) => {
  renderProfile(res, req.session.user.user_id);
});

// 自分のアイコン(絵文字・色)を更新、画像が添付されていれば画像も更新
router.post('/profile/icon', requireLogin, (req, res) => {
  upload.single('avatar_image')(req, res, (uploadErr) => {
    const userId = req.session.user.user_id;

    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? '画像サイズが大きすぎます(5MBまで)' : '画像のアップロードに失敗しました';
      return renderProfile(res, userId, { uploadError: message });
    }

    const { avatar_emoji, avatar_color } = req.body;
    const emoji = EMOJI_OPTIONS.includes(avatar_emoji) ? avatar_emoji : null;
    const color = COLOR_OPTIONS.includes(avatar_color) ? avatar_color : null;

    if (req.file) {
      deleteOldAvatarImage(userId);
      const imagePath = `/uploads/avatars/${req.file.filename}`;
      db.prepare('UPDATE users SET avatar_emoji = ?, avatar_color = ?, avatar_image = ? WHERE user_id = ?').run(
        emoji,
        color,
        imagePath,
        userId
      );
    } else {
      db.prepare('UPDATE users SET avatar_emoji = ?, avatar_color = ? WHERE user_id = ?').run(emoji, color, userId);
    }

    renderProfile(res, userId, { success: 'アイコンを更新しました' });
  });
});

// アップロードしたアイコン画像を削除し、絵文字表示に戻す
router.post('/profile/icon/remove-image', requireLogin, (req, res) => {
  const userId = req.session.user.user_id;
  deleteOldAvatarImage(userId);
  db.prepare('UPDATE users SET avatar_image = NULL WHERE user_id = ?').run(userId);
  renderProfile(res, userId, { success: '画像アイコンを削除しました' });
});

module.exports = router;

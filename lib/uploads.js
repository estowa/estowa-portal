// 添付ファイルアップロードの共通設定
// タスクの添付・お知らせの添付など、複数の機能で使い回す

const fs = require('fs');
const path = require('path');
const multer = require('multer');

// 実行ファイルなど危険な拡張子のみ拒否し、それ以外の画像・PDF・Office文書・
// 圧縮ファイルなどは幅広く添付できるようにする(Asanaのような添付イメージ)
const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.com', '.php', '.js', '.jar', '.app'];

// uploadDir配下に保存するmulterインスタンスと、日本語エラーメッセージ付きの
// 実行ヘルパー(runUpload)をまとめて作る
function createUploader(uploadDir, { maxFiles = 10, maxFileSize = 15 * 1024 * 1024 } = {}) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadDir),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).slice(0, 10);
        const safeExt = /^[a-zA-Z0-9.]*$/.test(ext) ? ext : '';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
      },
    }),
    limits: { fileSize: maxFileSize, files: maxFiles },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (BLOCKED_EXT.includes(ext)) {
        return cb(null, false);
      }
      cb(null, true);
    },
  });

  function runUpload(req, res, callback) {
    upload.array('files', maxFiles)(req, res, (err) => {
      if (err) {
        let message = 'アップロードに失敗しました';
        if (err.code === 'LIMIT_FILE_SIZE') message = `ファイルサイズが大きすぎます(1ファイル${Math.floor(maxFileSize / 1024 / 1024)}MBまで)`;
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') message = `一度にアップロードできるファイル数を超えています(最大${maxFiles}件)`;
        return callback(message);
      }
      callback(null);
    });
  }

  return { upload, runUpload, uploadDir };
}

module.exports = { createUploader, BLOCKED_EXT };

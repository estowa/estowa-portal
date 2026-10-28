const crypto = require('crypto');
const express = require('express');
const { applyBackupReport } = require('../lib/maintenanceBackupReport');

// PCのバックアップ取得の結果を受け取る口。ログインではなく、専用トークン（.env の BACKUP_REPORT_TOKEN）で認証する。
// ブラウザからは使わない。トークンが未設定のときは、受け付けない
function sameToken(given, expected) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(given), h(expected));
}

function createBackupApiRouter(db, { getToken = () => process.env.BACKUP_REPORT_TOKEN } = {}) {
  const router = express.Router();
  router.use(express.json({ limit: '100kb' }));

  router.post('/backup-report', (req, res) => {
    const expected = getToken();
    if (!expected) return res.status(503).json({ error: 'disabled' });
    const m = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!m || !sameToken(m[1], expected)) return res.status(401).json({ error: 'unauthorized' });
    try {
      res.json({ ok: true, ...applyBackupReport(db, req.body) });
    } catch (e) {
      if (e.message === 'bad_request' || e.message === 'too_many') return res.status(400).json({ error: e.message });
      console.error('[backup-report]', e.message);
      res.status(500).json({ error: 'error' });
    }
  });

  // 形式の壊れたJSON・大きすぎる本文も、JSONで返す
  router.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request' });
    next(err);
  });
  return router;
}

module.exports = { createBackupApiRouter };

// 通知の設定ページ、端末の登録・解除・テスト送信、種類ごとのオン・オフ
const express = require('express');
const db = require('../db/connection');
const push = require('../lib/push');
const badge = require('../lib/badge');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// fetch(JSON) から呼ぶAPI用のログイン確認。未ログインは、ログイン画面への移動ではなく 401 を返す
function requireLoginJson(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'ログインしてください' });
}

const json = express.json({ limit: '10kb' });

router.get('/notifications', requireLogin, (req, res) => {
  res.render('notifications', {
    push: {
      configured: push.isConfigured() && !push.isDisabled(),
      publicKey: push.publicKey(),
      kinds: push.KINDS,
      prefs: push.getPrefs(db, req.session.user.user_id),
    },
    saved: req.query.saved === '1',
  });
});

// アイコンの赤い数字（未読の合計）。アプリに戻ったときに取り直す
router.get('/badge', requireLoginJson, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ count: badge.unreadTotalSafe(db, req.session.user.user_id) || 0 });
});

router.post('/push/subscribe', requireLoginJson, json, (req, res) => {
  if (!push.isConfigured()) return res.status(503).json({ error: '通知の鍵が設定されていません' });
  const sub = req.body && req.body.subscription;
  if (!push.validateSubscription(sub)) return res.status(400).json({ error: '登録情報が正しくありません' });
  push.saveSubscription(db, req.session.user.user_id, sub);
  res.json({ ok: true });
});

router.post('/push/unsubscribe', requireLoginJson, json, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: '登録情報が正しくありません' });
  push.removeSubscription(db, req.session.user.user_id, endpoint);
  res.json({ ok: true });
});

// この端末が、今のユーザーとして登録済みか（ブラウザ側の状態表示用）
router.post('/push/status', requireLoginJson, json, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  res.json({
    subscribed: typeof endpoint === 'string' && push.hasSubscription(db, req.session.user.user_id, endpoint),
    devices: push.countSubscriptions(db, req.session.user.user_id),
  });
});

// 自分の全端末にテスト通知を送る
router.post('/push/test', requireLoginJson, async (req, res) => {
  if (!push.isConfigured() || push.isDisabled()) return res.status(503).json({ error: '通知が使えない設定になっています' });
  const sent = await push.sendToUser(db, req.session.user.user_id, {
    title: 'テスト通知',
    body: '通知が届いています。',
    url: '/notifications',
    tag: 'test',
  });
  res.json({ sent });
});

// 種類ごとのオン・オフ（フォーム）
router.post('/notifications', requireLogin, (req, res) => {
  const body = req.body || {};
  push.setPrefs(db, req.session.user.user_id, Object.fromEntries(push.KIND_KEYS.map((k) => [k, body[k] === 'on'])));
  res.redirect('/notifications?saved=1');
});

module.exports = router;

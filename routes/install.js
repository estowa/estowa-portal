// ホーム画面への追加の案内ページ
const express = require('express');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/install', requireLogin, (req, res) => {
  res.render('install');
});

module.exports = router;

const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { CATEGORY_DEFS, CATEGORIES, colorForCategory } = require('../lib/vendorCategories');

const router = express.Router();

// カテゴリ別にグルーピングする。定義済みカテゴリを常に表示順に並べ、
// 想定外のカテゴリ(未設定・過去データなど)は「その他」としてまとめる
function groupVendors(vendors) {
  const groups = CATEGORIES.map((name) => ({ name, color: colorForCategory(name), vendors: [] }));
  const others = { name: 'その他', color: colorForCategory(null), vendors: [] };

  vendors.forEach((v) => {
    const group = groups.find((g) => g.name === v.category);
    if (group) {
      group.vendors.push(v);
    } else {
      others.vendors.push(v);
    }
  });

  if (others.vendors.length > 0) groups.push(others);
  return groups;
}

// 外注先リスト（カテゴリごとにグルーピング表示）
router.get('/vendors', requireLogin, (req, res) => {
  const vendors = db.prepare('SELECT * FROM vendors ORDER BY name').all();
  const groups = groupVendors(vendors);
  res.render('vendors/index', { groups, error: null });
});

// 新規登録画面(専用ページ)
router.get('/vendors/new', requireLogin, (req, res) => {
  const presetCategory = req.query.category || '';
  res.render('vendors/new', { categoryDefs: CATEGORY_DEFS, presetCategory, error: null });
});

// 新規登録
router.post('/vendors', requireLogin, (req, res) => {
  const { category, name, url, notes } = req.body;
  if (!name) {
    return res.render('vendors/new', {
      categoryDefs: CATEGORY_DEFS,
      presetCategory: category || '',
      error: '外注先名を入力してください',
    });
  }

  const safeCategory = CATEGORIES.includes(category) ? category : '';

  db.prepare(
    'INSERT INTO vendors (category, name, url, notes, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(safeCategory, name, url || '', notes || '', req.session.user.user_id);

  res.redirect('/vendors');
});

router.post('/vendors/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
  res.redirect('/vendors');
});

module.exports = router;

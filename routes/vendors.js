const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { CATEGORY_DEFS, CATEGORIES, colorForCategory } = require('../lib/vendorCategories');

const router = express.Router();

// カテゴリ別にグルーピングする。定義済みカテゴリ(「その他」含む)を常に表示順に並べ、
// 想定外のカテゴリ(未設定・過去データなど)も「その他」に含める
function groupVendors(vendors) {
  const groups = CATEGORIES.map((name) => ({ name, color: colorForCategory(name), vendors: [] }));
  const fallback = groups.find((g) => g.name === 'その他');

  vendors.forEach((v) => {
    const group = groups.find((g) => g.name === v.category) || fallback;
    group.vendors.push(v);
  });

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
  const { category, name, url, notes, remarks } = req.body;
  if (!name) {
    return res.render('vendors/new', {
      categoryDefs: CATEGORY_DEFS,
      presetCategory: category || '',
      error: '外注先名を入力してください',
    });
  }

  const safeCategory = CATEGORIES.includes(category) ? category : 'その他';

  db.prepare(
    'INSERT INTO vendors (category, name, url, notes, remarks, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(safeCategory, name, url || '', notes || '', remarks || '', req.session.user.user_id);

  res.redirect('/vendors');
});

// 編集画面
router.get('/vendors/:id/edit', requireLogin, (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) return res.status(404).render('error', { message: '外注先が見つかりません', user: req.session.user });

  res.render('vendors/edit', { vendor, categoryDefs: CATEGORY_DEFS, error: null });
});

// 更新
router.post('/vendors/:id', requireLogin, (req, res) => {
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!vendor) return res.status(404).render('error', { message: '外注先が見つかりません', user: req.session.user });

  const { category, name, url, notes, remarks } = req.body;
  if (!name) {
    return res.render('vendors/edit', {
      vendor: { ...vendor, category, name, url, notes, remarks },
      categoryDefs: CATEGORY_DEFS,
      error: '外注先名を入力してください',
    });
  }

  const safeCategory = CATEGORIES.includes(category) ? category : 'その他';

  db.prepare('UPDATE vendors SET category = ?, name = ?, url = ?, notes = ?, remarks = ? WHERE id = ?').run(
    safeCategory,
    name,
    url || '',
    notes || '',
    remarks || '',
    req.params.id
  );

  res.redirect('/vendors');
});

router.post('/vendors/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM vendors WHERE id = ?').run(req.params.id);
  res.redirect('/vendors');
});

module.exports = router;

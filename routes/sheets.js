const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { evaluateSheet, colIndexToLetter } = require('../lib/formula');

const router = express.Router();

const DEFAULT_ROWS = 10;
const DEFAULT_COLS = 6;

function emptyGrid(rows, cols) {
  const cells = [];
  for (let r = 0; r < rows; r++) cells.push(new Array(cols).fill(''));
  return { rows, cols, cells };
}

function loadGrid(row) {
  try {
    const parsed = JSON.parse(row.data);
    if (parsed && parsed.cells) return parsed;
  } catch (e) {
    // フォールスルーしてデフォルトを返す
  }
  return emptyGrid(DEFAULT_ROWS, DEFAULT_COLS);
}

router.get('/sheets', requireLogin, (req, res) => {
  const sheets = db.prepare('SELECT id, name, updated_at FROM spreadsheets ORDER BY updated_at DESC').all();
  res.render('sheets/index', { sheets });
});

router.post('/sheets', requireLogin, (req, res) => {
  const name = (req.body.name || '無題のシート').trim() || '無題のシート';
  const grid = emptyGrid(DEFAULT_ROWS, DEFAULT_COLS);
  const result = db
    .prepare('INSERT INTO spreadsheets (name, data, created_by) VALUES (?, ?, ?)')
    .run(name, JSON.stringify(grid), req.session.user.user_id);
  res.redirect('/sheets/' + result.lastInsertRowid);
});

router.get('/sheets/:id', requireLogin, (req, res) => {
  const sheet = db.prepare('SELECT * FROM spreadsheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.status(404).render('error', { message: 'シートが見つかりません', user: req.session.user });

  const grid = loadGrid(sheet);
  const computed = evaluateSheet(grid);
  const colLabels = Array.from({ length: grid.cols }, (_, i) => colIndexToLetter(i));

  res.render('sheets/show', { sheet, grid, computed, colLabels });
});

// セル内容の一括保存
router.post('/sheets/:id', requireLogin, (req, res) => {
  const sheet = db.prepare('SELECT * FROM spreadsheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.status(404).render('error', { message: 'シートが見つかりません', user: req.session.user });

  const grid = loadGrid(sheet);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const key = `cell_${r}_${c}`;
      if (req.body[key] !== undefined) {
        grid.cells[r][c] = req.body[key];
      }
    }
  }

  db.prepare("UPDATE spreadsheets SET data = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(grid),
    req.params.id
  );
  res.redirect('/sheets/' + req.params.id);
});

router.post('/sheets/:id/add-row', requireLogin, (req, res) => {
  const sheet = db.prepare('SELECT * FROM spreadsheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.redirect('/sheets');
  const grid = loadGrid(sheet);
  grid.cells.push(new Array(grid.cols).fill(''));
  grid.rows += 1;
  db.prepare("UPDATE spreadsheets SET data = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(grid),
    req.params.id
  );
  res.redirect('/sheets/' + req.params.id);
});

router.post('/sheets/:id/add-col', requireLogin, (req, res) => {
  const sheet = db.prepare('SELECT * FROM spreadsheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.redirect('/sheets');
  const grid = loadGrid(sheet);
  grid.cells.forEach((row) => row.push(''));
  grid.cols += 1;
  db.prepare("UPDATE spreadsheets SET data = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(grid),
    req.params.id
  );
  res.redirect('/sheets/' + req.params.id);
});

router.post('/sheets/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM spreadsheets WHERE id = ?').run(req.params.id);
  res.redirect('/sheets');
});

module.exports = router;

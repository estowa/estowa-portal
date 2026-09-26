const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { evaluateSheet, colIndexToLetter } = require('../lib/formula');

const router = express.Router();

// エクセルインポート用(ディスクに保存せずメモリ上で読み込む)
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

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

// エクセル(.xlsx)としてダウンロード。数式セルは数式のまま(値はキャッシュとして併記)出力する
router.get('/sheets/:id/export', requireLogin, (req, res) => {
  const sheet = db.prepare('SELECT * FROM spreadsheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.status(404).render('error', { message: 'シートが見つかりません', user: req.session.user });

  const grid = loadGrid(sheet);
  const computed = evaluateSheet(grid);

  const ws = {};
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const raw = grid.cells[r][c] || '';
      if (raw === '') continue;
      const addr = XLSX.utils.encode_cell({ r, c });

      if (typeof raw === 'string' && raw.startsWith('=')) {
        const val = computed[r][c];
        const isNum = typeof val === 'number' && !isNaN(val);
        ws[addr] = { t: isNum ? 'n' : 's', f: raw.slice(1), v: isNum ? val : String(val) };
      } else {
        const num = parseFloat(raw);
        const isNum = raw !== '' && !isNaN(num) && String(num) === String(raw).trim();
        ws[addr] = isNum ? { t: 'n', v: num } : { t: 's', v: String(raw) };
      }
    }
  }
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(grid.rows - 1, 0), c: Math.max(grid.cols - 1, 0) },
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '粗利表');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent(`${sheet.name}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="sheet.xlsx"; filename*=UTF-8''${filename}`);
  res.send(buffer);
});

// エクセル(.xlsx)をインポートして現在のシート内容を置き換える(数式はそのまま数式として取り込む)
router.post('/sheets/:id/import', requireLogin, (req, res) => {
  const sheet = db.prepare('SELECT * FROM spreadsheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.status(404).render('error', { message: 'シートが見つかりません', user: req.session.user });

  importUpload.single('excel_file')(req, res, (err) => {
    if (err || !req.file) {
      return res.redirect('/sheets/' + req.params.id);
    }

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    } catch (e) {
      return res.redirect('/sheets/' + req.params.id);
    }

    const firstSheetName = workbook.SheetNames[0];
    const ws = workbook.Sheets[firstSheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    const rows = Math.max(range.e.r + 1, DEFAULT_ROWS);
    const cols = Math.max(range.e.c + 1, DEFAULT_COLS);

    const cells = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < cols; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) {
          line.push('');
        } else if (cell.f) {
          line.push('=' + cell.f);
        } else if (cell.v === undefined || cell.v === null) {
          line.push('');
        } else {
          line.push(String(cell.v));
        }
      }
      cells.push(line);
    }

    const grid = { rows, cols, cells };
    db.prepare("UPDATE spreadsheets SET data = ?, updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(grid),
      req.params.id
    );
    res.redirect('/sheets/' + req.params.id);
  });
});

router.post('/sheets/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM spreadsheets WHERE id = ?').run(req.params.id);
  res.redirect('/sheets');
});

module.exports = router;

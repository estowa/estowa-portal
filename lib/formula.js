const { Parser } = require('hot-formula-parser');

// 行・列番号からA1形式のセル参照を組み立てる（例: row=0, col=0 -> "A1"）
function colIndexToLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// グリッド全体を計算し、表示用の値だけを持つ配列を返す
// grid: { rows: number, cols: number, cells: string[][] } (rawな入力値。"="で始まれば数式)
function evaluateSheet(grid) {
  const rows = grid.rows;
  const cols = grid.cols;
  const raw = grid.cells;
  const computed = [];
  const evaluating = new Set();

  function getValue(r, c) {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return '';
    const value = (raw[r] && raw[r][c]) || '';
    if (typeof value !== 'string' || !value.startsWith('=')) {
      // 数値に変換できればそのまま数値扱い
      const num = parseFloat(value);
      return value !== '' && !isNaN(num) && String(num) === value.trim() ? num : value;
    }

    const key = `${r},${c}`;
    if (evaluating.has(key)) return '#REF!';
    evaluating.add(key);

    const parser = new Parser();
    parser.on('callCellValue', (cellCoord, done) => {
      done(getValue(cellCoord.row.index, cellCoord.column.index));
    });
    parser.on('callRangeValue', (startCoord, endCoord, done) => {
      const arr = [];
      for (let rr = startCoord.row.index; rr <= endCoord.row.index; rr++) {
        const line = [];
        for (let cc = startCoord.column.index; cc <= endCoord.column.index; cc++) {
          line.push(getValue(rr, cc));
        }
        arr.push(line);
      }
      done(arr);
    });

    const result = parser.parse(value.slice(1));
    evaluating.delete(key);
    if (result.error) return '#ERR';
    return result.result;
  }

  for (let r = 0; r < rows; r++) {
    const line = [];
    for (let c = 0; c < cols; c++) {
      line.push(getValue(r, c));
    }
    computed.push(line);
  }
  return computed;
}

module.exports = { evaluateSheet, colIndexToLetter };

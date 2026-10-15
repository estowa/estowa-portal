const test = require('node:test');
const assert = require('node:assert');
const { formatJst, toJstParts } = require('../lib/jst');

test('UTCの保存値は、日本時間（+9時間）で表示される', () => {
  assert.strictEqual(formatJst('2026-10-15 01:04:27'), '2026-10-15 10:04');
});

test('日付をまたぐときも正しく繰り上がる', () => {
  assert.strictEqual(formatJst('2026-10-15 15:30:00'), '2026-10-16 00:30');
  assert.deepStrictEqual(toJstParts('2026-12-31 20:00:00'), { dateStr: '2027-01-01', timeStr: '05:00' });
});

test('空の値は空文字になる', () => {
  assert.strictEqual(formatJst(null), '');
  assert.strictEqual(formatJst(''), '');
});

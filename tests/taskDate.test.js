const test = require('node:test');
const assert = require('node:assert');
const { formatWhen } = require('../lib/taskDate');

const TODAY = '2026-10-29';

test('当日は「今日 時間」、翌日は「明日 時間」', () => {
  assert.strictEqual(formatWhen('2026-10-29', '10:00', TODAY), '今日 10:00');
  assert.strictEqual(formatWhen('2026-10-30', '18:00', TODAY), '明日 18:00');
});

test('それ以外は日付と時間', () => {
  assert.strictEqual(formatWhen('2026-11-05', '09:30', TODAY), '2026-11-05 09:30');
  assert.strictEqual(formatWhen('2026-10-28', '09:30', TODAY), '2026-10-28 09:30');
  assert.strictEqual(formatWhen('2026-10-31', '09:30', TODAY), '2026-10-31 09:30');
});

test('時間がなければ日付だけ（今日・明日も）', () => {
  assert.strictEqual(formatWhen('2026-10-29', '', TODAY), '今日');
  assert.strictEqual(formatWhen('2026-10-30', null, TODAY), '明日');
  assert.strictEqual(formatWhen('2026-11-05', null, TODAY), '2026-11-05');
});

test('日付がなければ空（非表示）', () => {
  assert.strictEqual(formatWhen(null, '10:00', TODAY), '');
  assert.strictEqual(formatWhen('', '', TODAY), '');
});

test('月末・年末またぎでも翌日を判定する', () => {
  assert.strictEqual(formatWhen('2026-11-01', '08:00', '2026-10-31'), '明日 08:00');
  assert.strictEqual(formatWhen('2027-01-01', null, '2026-12-31'), '明日');
});

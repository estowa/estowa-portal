const test = require('node:test');
const assert = require('node:assert');
const { dueState } = require('../lib/taskDue');

const NOW = '2026-10-29T12:00';

test('過ぎた締切は overdue', () => {
  assert.strictEqual(dueState('2026-10-29T11:59', 'todo', NOW), 'overdue');
  assert.strictEqual(dueState('2026-10-01T09:00', 'doing', NOW), 'overdue');
});

test('24時間以内は soon（ちょうど24時間後も含む）', () => {
  assert.strictEqual(dueState('2026-10-29T12:00', 'todo', NOW), 'soon');
  assert.strictEqual(dueState('2026-10-30T00:00', 'todo', NOW), 'soon');
  assert.strictEqual(dueState('2026-10-30T12:00', 'todo', NOW), 'soon');
});

test('24時間より先は通常', () => {
  assert.strictEqual(dueState('2026-10-30T12:01', 'todo', NOW), '');
  assert.strictEqual(dueState('2026-11-05T18:00', 'todo', NOW), '');
});

test('月またぎでも24時間で判定する', () => {
  assert.strictEqual(dueState('2026-11-01T01:00', 'todo', '2026-10-31T23:00'), 'soon');
});

test('完了済み・締切なしは色なし', () => {
  assert.strictEqual(dueState('2026-10-01T09:00', 'done', NOW), '');
  assert.strictEqual(dueState('2026-10-29T13:00', 'done', NOW), '');
  assert.strictEqual(dueState(null, 'todo', NOW), '');
  assert.strictEqual(dueState('', 'todo', NOW), '');
});

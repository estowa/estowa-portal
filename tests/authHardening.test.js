const test = require('node:test');
const assert = require('node:assert');
const { createLoginThrottle, WINDOW_MS, MAX_FAILS_PER_USER } = require('../lib/loginThrottle');
const { applyFreshUser } = require('../lib/sessionUser');

function clock() {
  let t = 1000000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('失敗が上限に達するとログインを止める', () => {
  const c = clock();
  const th = createLoginThrottle({ now: c.now });
  for (let i = 0; i < MAX_FAILS_PER_USER - 1; i++) th.recordFailure('taro', '1.1.1.1');
  assert.strictEqual(th.isBlocked('taro', '1.1.1.1'), false);
  th.recordFailure('taro', '1.1.1.1');
  assert.strictEqual(th.isBlocked('taro', '1.1.1.1'), true);
});

test('別のIDには影響しない（接続元が同じでも、IDごとの上限が先に効く）', () => {
  const th = createLoginThrottle({ now: clock().now });
  for (let i = 0; i < MAX_FAILS_PER_USER; i++) th.recordFailure('taro', '1.1.1.1');
  assert.strictEqual(th.isBlocked('hanako', '2.2.2.2'), false);
  assert.strictEqual(th.isBlocked('hanako', '1.1.1.1'), false);
});

test('IDの大文字小文字・前後の空白は同じIDとして数える', () => {
  const th = createLoginThrottle({ now: clock().now });
  for (let i = 0; i < MAX_FAILS_PER_USER; i++) th.recordFailure(i % 2 ? ' Taro ' : 'taro', '1.1.1.1');
  assert.strictEqual(th.isBlocked('TARO', '9.9.9.9'), true);
});

test('15分たつと、また試せる', () => {
  const c = clock();
  const th = createLoginThrottle({ now: c.now });
  for (let i = 0; i < MAX_FAILS_PER_USER; i++) th.recordFailure('taro', '1.1.1.1');
  c.advance(WINDOW_MS + 1);
  assert.strictEqual(th.isBlocked('taro', '1.1.1.1'), false);
});

test('ログインできたら、そのIDの失敗は忘れる', () => {
  const th = createLoginThrottle({ now: clock().now });
  for (let i = 0; i < MAX_FAILS_PER_USER - 1; i++) th.recordFailure('taro', '1.1.1.1');
  th.recordSuccess('taro');
  th.recordFailure('taro', '1.1.1.1');
  assert.strictEqual(th.isBlocked('taro', '1.1.1.1'), false);
});

test('接続元だけの失敗が多くても、上限（緩め）に達するまでは止めない', () => {
  const th = createLoginThrottle({ now: clock().now });
  for (let i = 0; i < 30; i++) th.recordFailure('user' + i, '3.3.3.3');
  assert.strictEqual(th.isBlocked('newuser', '3.3.3.3'), false);
  for (let i = 30; i < 50; i++) th.recordFailure('user' + i, '3.3.3.3');
  assert.strictEqual(th.isBlocked('newuser', '3.3.3.3'), true);
});

const row = { id: 1, user_id: 'a', display_name: 'A', role: 'member' };

test('権限が下げられたら、セッションの権限も下げる', () => {
  const s = { user: { id: 1, user_id: 'a', display_name: 'A', role: 'admin' } };
  assert.strictEqual(applyFreshUser(s, row), true);
  assert.strictEqual(s.user.role, 'member');
});

test('ユーザーが削除されていたら、ログイン情報を消す', () => {
  const s = { user: { id: 1, user_id: 'a', display_name: 'A', role: 'admin' } };
  assert.strictEqual(applyFreshUser(s, undefined), false);
  assert.strictEqual(s.user, undefined);
});

test('表示名の変更も反映し、変わりがなければセッションを書き換えない', () => {
  const same = { id: 1, user_id: 'a', display_name: 'A', role: 'member' };
  const s = { user: same };
  applyFreshUser(s, row);
  assert.strictEqual(s.user, same);
  applyFreshUser(s, { ...row, display_name: 'B' });
  assert.strictEqual(s.user.display_name, 'B');
});

test('ログインしていないセッションは何もしない', () => {
  assert.strictEqual(applyFreshUser({}, row), false);
});

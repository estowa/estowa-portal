const test = require('node:test');
const assert = require('node:assert');
const { securityHeaders } = require('../lib/securityHeaders');

function run(secure) {
  const h = {};
  let nexted = false;
  securityHeaders({ secure }, { setHeader: (k, v) => { h[k] = v; } }, () => { nexted = true; });
  return { h, nexted };
}

test('全ページに基本のヘッダーを付けて次へ進む', () => {
  const { h, nexted } = run(false);
  assert.strictEqual(nexted, true);
  assert.strictEqual(h['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(h['X-Frame-Options'], 'SAMEORIGIN');
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'self'/);
  assert.match(h['Content-Security-Policy'], /object-src 'none'/);
  assert.strictEqual(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('マイクは自分のサイトだけ許可し、カメラなどは止める', () => {
  const { h } = run(false);
  assert.match(h['Permissions-Policy'], /microphone=\(self\)/);
  assert.match(h['Permissions-Policy'], /camera=\(\)/);
});

test('画面内のスクリプトを制限するCSP（script-src）は入れない', () => {
  assert.doesNotMatch(run(false).h['Content-Security-Policy'], /script-src|default-src/);
});

test('HSTSは、HTTPSのときだけ付ける', () => {
  assert.strictEqual(run(false).h['Strict-Transport-Security'], undefined);
  assert.match(run(true).h['Strict-Transport-Security'], /^max-age=\d+$/);
});

const test = require('node:test');
const assert = require('node:assert');
const { resolveSessionSecret, DEV_SECRET } = require('../lib/sessionSecret');

test('SESSION_SECRET があればそれを使う', () => {
  assert.strictEqual(resolveSessionSecret({ SESSION_SECRET: 'abc', APP_BASE_URL: 'https://portal.estowa.com' }), 'abc');
});

test('ローカル開発（httpsでない）で未設定なら、開発用の値で動く', () => {
  assert.strictEqual(resolveSessionSecret({}), DEV_SECRET);
  assert.strictEqual(resolveSessionSecret({ APP_BASE_URL: 'http://localhost:3000' }), DEV_SECRET);
});

test('本番（https）で未設定なら、起動を止める', () => {
  assert.throws(() => resolveSessionSecret({ APP_BASE_URL: 'https://portal.estowa.com' }), /SESSION_SECRET/);
});

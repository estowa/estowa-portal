const test = require('node:test');
const assert = require('node:assert');
const { isAllowedOrigin } = require('../lib/chatSocket');

test('同じサイトからの接続は許可する', () => {
  assert.strictEqual(isAllowedOrigin('http://localhost:3000', 'localhost:3000'), true);
  assert.strictEqual(isAllowedOrigin('https://portal.example.jp', 'portal.example.jp'), true);
});

test('別のサイトからの接続は拒否する（なりすまし接続の防止）', () => {
  assert.strictEqual(isAllowedOrigin('https://evil.example.com', 'portal.example.jp'), false);
  assert.strictEqual(isAllowedOrigin('http://localhost:3001', 'localhost:3000'), false);
  assert.strictEqual(isAllowedOrigin('not a url', 'localhost:3000'), false);
});

test('Originがない接続（ブラウザ以外）は許可する。ブラウザは必ずOriginを付ける', () => {
  assert.strictEqual(isAllowedOrigin(undefined, 'localhost:3000'), true);
});

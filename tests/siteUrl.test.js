const test = require('node:test');
const assert = require('node:assert');
const { normalizeSiteUrl } = require('../lib/siteUrl');

test('https:// がなくても補い、ホストは小文字、末尾は / にそろう', () => {
  assert.strictEqual(normalizeSiteUrl('example.com'), 'https://example.com/');
  assert.strictEqual(normalizeSiteUrl('  HTTPS://Example.COM  '), 'https://example.com/');
});

test('パスは残し、query・hashは捨てる。ポートは残す', () => {
  assert.strictEqual(normalizeSiteUrl('https://cityhall-koumei.com/site'), 'https://cityhall-koumei.com/site/');
  assert.strictEqual(normalizeSiteUrl('http://example.com/Path/?a=1#top'), 'http://example.com/Path/');
  assert.strictEqual(normalizeSiteUrl('example.com:8443/x'), 'https://example.com:8443/x/');
});

test('IDやパスワード付きのURLは断る（認証情報を保存しない）', () => {
  assert.throws(() => normalizeSiteUrl('https://user:pass@example.com/'), /パスワード/);
  assert.throws(() => normalizeSiteUrl('https://user@example.com/'), /パスワード/);
});

test('http・https以外、空、ドットのないホスト、壊れた形は断る', () => {
  ['', '   ', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'localhost', 'http://', 'https://exa mple.com'].forEach(
    (v) => assert.throws(() => normalizeSiteUrl(v), Error, `断るはず: ${JSON.stringify(v)}`)
  );
});

test('全角スペースが混じっても、前後は取り除く', () => {
  assert.strictEqual(normalizeSiteUrl('　example.com　'), 'https://example.com/');
});

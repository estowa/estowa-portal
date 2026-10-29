const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { sameOriginGuard, isSameOriginRequest } = require('../lib/sameOrigin');
const { setUploadHeaders } = require('../lib/uploadHeaders');
const { BLOCKED_EXT } = require('../lib/uploads');

function req(method, headers) {
  return { method, headers: { host: 'portal.estowa.com', ...headers }, session: {} };
}

function run(r) {
  let nexted = false;
  let status = null;
  const res = {
    status(s) { status = s; return this; },
    render() {},
  };
  sameOriginGuard(r, res, () => { nexted = true; });
  return { nexted, status };
}

test('GETは常に通る', () => {
  assert.strictEqual(run(req('GET', { origin: 'https://evil.example' })).nexted, true);
});

test('自分のサイトからのPOSTは通る（Sec-Fetch-Site）', () => {
  assert.strictEqual(run(req('POST', { 'sec-fetch-site': 'same-origin' })).nexted, true);
});

test('他のサイトからのPOSTは断る（Sec-Fetch-Site）', () => {
  const r = run(req('POST', { 'sec-fetch-site': 'cross-site' }));
  assert.strictEqual(r.nexted, false);
  assert.strictEqual(r.status, 403);
});

test('サブドメイン(same-site)からのPOSTも断る', () => {
  assert.strictEqual(run(req('POST', { 'sec-fetch-site': 'same-site' })).nexted, false);
});

test('Originが自分のサイトならPOSTは通る', () => {
  assert.strictEqual(run(req('POST', { origin: 'https://portal.estowa.com' })).nexted, true);
});

test('Originが他のサイトならPOSTは断る', () => {
  assert.strictEqual(run(req('POST', { origin: 'https://evil.example' })).nexted, false);
  assert.strictEqual(run(req('POST', { origin: 'null' })).nexted, false);
});

test('OriginもSec-Fetch-Siteもないもの(curlなど)は通る', () => {
  assert.strictEqual(isSameOriginRequest(req('POST', {})), true);
});

test('Sec-Fetch-Siteがあれば、Originより優先する', () => {
  assert.strictEqual(run(req('POST', { 'sec-fetch-site': 'cross-site', origin: 'https://portal.estowa.com' })).nexted, false);
});

test('添付の拒否リストにHTML・SVG系が入っている', () => {
  for (const ext of ['.html', '.htm', '.svg', '.xhtml', '.xml']) assert.ok(BLOCKED_EXT.includes(ext), ext);
});

const ROOT = path.join(__dirname, '..', 'public', 'uploads');

function headersFor(file) {
  const h = {};
  setUploadHeaders({ setHeader: (k, v) => { h[k] = v; } }, path.join(ROOT, file), ROOT);
  return h;
}

test('uploads内のHTMLは保存扱い（画面に表示しない）で、種類の推測もさせない', () => {
  const h = headersFor('avatars/x.html');
  assert.strictEqual(h['Content-Disposition'], 'attachment');
  assert.strictEqual(h['X-Content-Type-Options'], 'nosniff');
});

test('uploads内の拡張子なし・SVGも保存扱い', () => {
  assert.strictEqual(headersFor('tasks/abc')['Content-Disposition'], 'attachment');
  assert.strictEqual(headersFor('tasks/a.SVG')['Content-Disposition'], 'attachment');
});

test('uploads内の画像・PDFはそのまま表示できる', () => {
  for (const f of ['avatars/a.png', 'tasks/b.JPG', 'tasks/c.pdf']) {
    const h = headersFor(f);
    assert.strictEqual(h['Content-Disposition'], undefined, f);
    assert.strictEqual(h['X-Content-Type-Options'], 'nosniff', f);
    assert.strictEqual(h['Cache-Control'], 'private', f);
  }
});

test('uploads以外のファイルには何も付けない', () => {
  const h = {};
  setUploadHeaders({ setHeader: (k, v) => { h[k] = v; } }, path.join(__dirname, '..', 'public', 'js', 'chat.js'), ROOT);
  assert.deepStrictEqual(h, {});
});

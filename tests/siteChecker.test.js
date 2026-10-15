const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  isBlockedAddress, certExpiryToDate, requestOnce, checkSite, registrableDomain, fetchDomainExpiry,
} = require('../lib/siteChecker');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

test('内部・予約アドレスは止める（IPv4・IPv6・IPv4射影・メタデータ用）', () => {
  ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '0:0:0:0:0:0:0:1', 'abc', ''].forEach((a) => assert.strictEqual(isBlockedAddress(a), true, `止めるはず: ${a}`));
});

test('公開アドレスは止めない（境界の隣も）', () => {
  ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '1.1.1.1', '2606:4700:4700::1111'].forEach(
    (a) => assert.strictEqual(isBlockedAddress(a), false, `通すはず: ${a}`)
  );
});

test('標準では、127.0.0.1・localhost・IP直指定の内部アドレスへ接続しない', async () => {
  const { server, url } = await serve((req, res) => res.end('ok'));
  try {
    for (const u of [url, url.replace('127.0.0.1', 'localhost'), 'http://169.254.169.254/latest/', 'http://[::1]:80/']) {
      const r = await checkSite(u, { timeoutMs: 2000 });
      assert.strictEqual(r.ok, false, u);
      assert.strictEqual(r.error, 'blocked', u);
    }
  } finally { server.close(); }
});

test('公開サイトが内部アドレスへ転送しても、転送先には接続しない', async () => {
  const fakePublicHop = (u, o) => (u.startsWith('https://public.example/')
    ? Promise.resolve({ status: 302, location: 'http://169.254.169.254/latest/meta-data', ms: 1, sslExpires: null })
    : requestOnce(u, o));
  const r = await checkSite('https://public.example/', { requestFn: fakePublicHop });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'blocked');
});

test('200は成功。ステータスと応答時間が入る', async () => {
  const { server, url } = await serve((req, res) => { res.statusCode = 200; res.end('hello'); });
  try {
    const r = await checkSite(url, { allowPrivate: true });
    assert.deepStrictEqual([r.ok, r.http_status, r.error], [true, 200, null]);
    assert.ok(r.response_ms >= 0);
  } finally { server.close(); }
});

test('500・404は失敗（ステータスは記録する）', async () => {
  const { server, url } = await serve((req, res) => { res.statusCode = req.url === '/x' ? 404 : 500; res.end(); });
  try {
    const a = await checkSite(url, { allowPrivate: true });
    assert.deepStrictEqual([a.ok, a.http_status], [false, 500]);
    const b = await checkSite(url + 'x', { allowPrivate: true });
    assert.deepStrictEqual([b.ok, b.http_status], [false, 404]);
  } finally { server.close(); }
});

test('転送（302）は、たどって最終結果を返す。転送が多すぎると失敗', async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === '/') { res.statusCode = 302; res.setHeader('Location', '/final'); return res.end(); }
    if (req.url === '/loop') { res.statusCode = 302; res.setHeader('Location', '/loop'); return res.end(); }
    res.statusCode = 200; res.end('done');
  });
  try {
    const ok = await checkSite(url, { allowPrivate: true });
    assert.deepStrictEqual([ok.ok, ok.http_status], [true, 200]);
    const loop = await checkSite(url + 'loop', { allowPrivate: true });
    assert.deepStrictEqual([loop.ok, loop.error], [false, 'too_many_redirects']);
  } finally { server.close(); }
});

test('応答が遅すぎると timeout。閉じているポートは connect', async () => {
  const { server, url } = await serve((req, res) => setTimeout(() => res.end('late'), 1500));
  try {
    const t = await checkSite(url, { allowPrivate: true, timeoutMs: 200 });
    assert.deepStrictEqual([t.ok, t.error], [false, 'timeout']);
  } finally { server.close(); }
  const c = await checkSite(url, { allowPrivate: true, timeoutMs: 2000 });
  assert.deepStrictEqual([c.ok, c.error], [false, 'connect']);
});

test('http・https以外への転送は止める', async () => {
  const hop = () => Promise.resolve({ status: 302, location: 'ftp://example.com/x', ms: 1, sslExpires: null });
  const r = await checkSite('https://public.example/', { requestFn: hop });
  assert.deepStrictEqual([r.ok, r.error], [false, 'blocked']);
});

test('証明書の期限は YYYY-MM-DD(UTC)にする。壊れた値は null', () => {
  assert.strictEqual(certExpiryToDate('Dec 31 23:59:59 2026 GMT'), '2026-12-31');
  assert.strictEqual(certExpiryToDate('nonsense'), null);
  assert.strictEqual(certExpiryToDate(undefined), null);
});

test('ドメイン名の切り出し: 通常は末尾2つ、co.jp などは3つ', () => {
  assert.strictEqual(registrableDomain('housing.nao-asobiba.com'), 'nao-asobiba.com');
  assert.strictEqual(registrableDomain('estowa.jp'), 'estowa.jp');
  assert.strictEqual(registrableDomain('www.example.co.jp'), 'example.co.jp');
  assert.strictEqual(registrableDomain('example.or.jp'), 'example.or.jp');
});

test('ドメイン期限（RDAP）: expiration の日付を取る。失敗・形式違いは null', async () => {
  const good = async () => ({ ok: true, json: async () => ({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-31T14:59:59Z' }] }) });
  assert.strictEqual(await fetchDomainExpiry('www.example.com', { fetchFn: good }), '2027-03-31');
  assert.strictEqual(await fetchDomainExpiry('example.com', { fetchFn: async () => ({ ok: false }) }), null);
  assert.strictEqual(await fetchDomainExpiry('example.com', { fetchFn: async () => { throw new Error('net'); } }), null);
  assert.strictEqual(await fetchDomainExpiry('example.com', { fetchFn: async () => ({ ok: true, json: async () => ({}) }) }), null);
  let called = 0;
  await fetchDomainExpiry('bad host!.com', { fetchFn: async () => { called += 1; return { ok: false }; } });
  assert.strictEqual(called, 0);
});

// ---- ドメイン期限の取得方法（com/net=Verisign直接、jp=JPRSのWHOIS、それ以外=rdap.org）----
const { parseJprsExpiry, DOMAIN_LOOKUP_SKIP } = require('../lib/siteChecker');

const rdapBody = (date) => ({ ok: true, json: async () => ({ events: [{ eventAction: 'expiration', eventDate: date }] }) });

test('.com・.net は、断られやすい中継（rdap.org）を通さず、登録元（Verisign）へ直接問い合わせる', async () => {
  const urls = [];
  const fetchFn = async (u) => { urls.push(u); return rdapBody('2027-03-19T00:09:20Z'); };
  assert.strictEqual(await fetchDomainExpiry('www.ikarigaseki.com', { fetchFn }), '2027-03-19');
  assert.strictEqual(await fetchDomainExpiry('araya-auto.net', { fetchFn }), '2027-03-19');
  assert.deepStrictEqual(urls, [
    'https://rdap.verisign.com/com/v1/domain/ikarigaseki.com',
    'https://rdap.verisign.com/net/v1/domain/araya-auto.net',
  ]);
});

test('その他の末尾（例: .org）は、これまでどおり rdap.org を使う', async () => {
  const urls = [];
  await fetchDomainExpiry('example.org', { fetchFn: async (u) => { urls.push(u); return rdapBody('2027-01-01T00:00:00Z'); } });
  assert.deepStrictEqual(urls, ['https://rdap.org/domain/example.org']);
});

test('JPRSのWHOISの表示から、有効期限を日付にする（英語・日本語の表記とも）。ない・壊れた値は null', () => {
  assert.strictEqual(parseJprsExpiry('[Domain Name]                   ESTOWA.JP\n[Expires on]                    2026/12/31\n'), '2026-12-31');
  assert.strictEqual(parseJprsExpiry('[有効期限]                      2027/04/30\n'), '2027-04-30');
  assert.strictEqual(parseJprsExpiry('No match!!'), null);
  assert.strictEqual(parseJprsExpiry('[Expires on]   2026/13/45'), null);
  assert.strictEqual(parseJprsExpiry(''), null);
  assert.strictEqual(parseJprsExpiry(undefined), null);
});

test('.jp は、JPRSのWHOISへ問い合わせ（HTTPは使わない）。co.jp などは3つ目まで。失敗は null', async () => {
  const asked = [];
  const whoisFn = async (host, q) => { asked.push([host, q]); return '[Expires on]    2026/12/31\n'; };
  let fetched = 0;
  const fetchFn = async () => { fetched += 1; return { ok: false }; };
  assert.strictEqual(await fetchDomainExpiry('www.estowa.jp', { whoisFn, fetchFn }), '2026-12-31');
  assert.strictEqual(await fetchDomainExpiry('shop.example.co.jp', { whoisFn, fetchFn }), '2026-12-31');
  assert.deepStrictEqual(asked, [['whois.jprs.jp', 'estowa.jp/e'], ['whois.jprs.jp', 'example.co.jp/e']]);
  assert.strictEqual(fetched, 0);
  assert.strictEqual(await fetchDomainExpiry('estowa.jp', { whoisFn: async () => { throw new Error('net'); } }), null);
});

test('他社が運営する共有ドメイン（guidebook.jp など）は、お客様のドメイン期限ではないので、問い合わせない', async () => {
  let called = 0;
  const fn = async () => { called += 1; return ''; };
  assert.ok(DOMAIN_LOOKUP_SKIP.has('guidebook.jp'));
  assert.strictEqual(await fetchDomainExpiry('hirakawa-company.guidebook.jp', { whoisFn: fn, fetchFn: fn }), null);
  assert.strictEqual(called, 0);
});

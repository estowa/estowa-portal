// サイトを「外から」確認する。ログインはしない。認証情報は持たない・送らない。
// 内部アドレス（自分のサーバー内・社内ネットワーク・クラウドの管理用アドレス）には接続しない。

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const USER_AGENT = 'estowa-portal-check';

// ---- 内部アドレスの判定 ----
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

function isBlockedAddress(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return blocked.check(a, 'ipv4');
  if (net.isIPv6(a)) return blocked.check(a, 'ipv6');
  return true; // 不明な形式は、止める
}

// 名前の解決結果に、内部アドレスが1つでもあれば、接続しない（DNSを使ったすり替え対策）
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.some((x) => isBlockedAddress(x.address))) {
      return callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function certExpiryToDate(validTo) {
  const d = new Date(validTo);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// 1回分のアクセス。本文は読まずに捨てる。
function requestOnce(urlStr, { timeoutMs = 10000, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(Object.assign(new Error('unsupported protocol'), { code: 'EBLOCKED' }));
    }
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(bare) && isBlockedAddress(bare)) {
      return reject(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const options = {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      agent: false,
      ...(allowPrivate ? {} : { lookup: safeLookup }),
    };
    let finished = false;
    let timer = null;
    const done = (fn, value) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(u, options, (res) => {
      let sslExpires = null;
      if (u.protocol === 'https:' && res.socket && typeof res.socket.getPeerCertificate === 'function') {
        const cert = res.socket.getPeerCertificate();
        sslExpires = certExpiryToDate(cert && cert.valid_to);
      }
      const result = { status: res.statusCode, location: res.headers.location, ms: Date.now() - started, sslExpires };
      res.destroy();
      done(resolve, result);
    });
    timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

function classifyError(e) {
  const code = e && e.code;
  if (code === 'EBLOCKED') return 'blocked';
  if (code === 'ETIMEDOUT' || (e && /timeout/i.test(e.message))) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return 'dns';
  if (/CERT|SSL|TLS|HOSTNAME|ERR_TLS/i.test(String(code)) || /certificate|tls|ssl/i.test((e && e.message) || '')) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return 'connect';
  return 'other';
}

async function checkSite(url, opts = {}) {
  const { timeoutMs = 10000, maxRedirects = 5, allowPrivate = false, requestFn = requestOnce } = opts;
  const started = Date.now();
  const originalHost = new URL(url).hostname;
  let current = url;
  let sslExpires = null;
  const fail = (error, status = null) => ({
    ok: false, http_status: status, response_ms: Date.now() - started, ssl_expires: sslExpires, error,
  });
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const r = await requestFn(current, { timeoutMs, allowPrivate });
      if (r.sslExpires && new URL(current).hostname === originalHost) sslExpires = r.sslExpires;
      if (r.status >= 300 && r.status < 400 && r.location) {
        const next = new URL(r.location, current);
        // 転送先が http・https 以外なら、止める（requestFn の実装に頼らず、ここでも確認する）
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return fail('blocked');
        current = next.toString();
        continue;
      }
      return {
        ok: r.status >= 200 && r.status < 400,
        http_status: r.status,
        response_ms: Date.now() - started,
        ssl_expires: sslExpires,
        error: null,
      };
    }
    return fail('too_many_redirects');
  } catch (e) {
    return fail(classifyError(e));
  }
}

// ---- ドメイン期限（公開の登録情報 RDAP）----
const JP_SECOND_LEVEL = new Set(['co', 'or', 'ne', 'ac', 'go', 'ed', 'gr', 'lg', 'ad']);

function registrableDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  return labels.slice(tld === 'jp' && JP_SECOND_LEVEL.has(second) ? -3 : -2).join('.');
}

// 他社が運営する共有ドメイン。サブドメインを貸しているだけなので、お客様のドメイン期限ではない
const DOMAIN_LOOKUP_SKIP = new Set(['guidebook.jp']);

// .com・.net は、登録元（Verisign）へ直接。中継（rdap.org）は、短時間に続けると「多すぎる」と断られる
const DIRECT_RDAP = { com: 'https://rdap.verisign.com/com/v1/domain/', net: 'https://rdap.verisign.com/net/v1/domain/' };

// JPRSのWHOISの表示から、有効期限（[Expires on] か [有効期限]）を YYYY-MM-DD にする
function parseJprsExpiry(text) {
  const m = String(text || '').match(/\[(?:Expires on|有効期限)\]\s+(\d{4})\/(\d{2})\/(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

// WHOIS（43番ポートの問い合わせ）。表示は小さいので、受け取る量に上限を付ける
function whoisQuery(host, query, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(43, host);
    let data = '';
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('data', (c) => { data += c; if (data.length > 65536) socket.destroy(); });
    socket.on('end', () => resolve(data));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
    socket.write(query + '\r\n');
  });
}

async function fetchDomainExpiry(hostname, { fetchFn = fetch, whoisFn = whoisQuery, timeoutMs = 10000 } = {}) {
  const domain = registrableDomain(hostname);
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes('.')) return null;
  if (DOMAIN_LOOKUP_SKIP.has(domain)) return null;
  const tld = domain.split('.').pop();

  // .jp は、RDAPが公開されていないため、JPRSのWHOIS（英語表記）で期限を取る
  if (tld === 'jp') {
    try {
      return parseJprsExpiry(await whoisFn('whois.jprs.jp', `${domain}/e`, timeoutMs));
    } catch (e) {
      return null;
    }
  }

  try {
    const res = await fetchFn(`${DIRECT_RDAP[tld] || 'https://rdap.org/domain/'}${domain}`, {
      headers: { Accept: 'application/rdap+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ev = ((data && data.events) || []).find((e) => e.eventAction === 'expiration');
    return ev && ev.eventDate ? String(ev.eventDate).slice(0, 10) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  isBlockedAddress, certExpiryToDate, requestOnce, checkSite, registrableDomain, fetchDomainExpiry,
  parseJprsExpiry, DOMAIN_LOOKUP_SKIP,
};

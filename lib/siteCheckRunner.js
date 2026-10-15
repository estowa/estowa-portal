// 登録されたサイトを順に確認して、結果を保存する。定期実行もここ。

const store = require('./maintenanceStore');
const { checkSite, fetchDomainExpiry, registrableDomain } = require('./siteChecker');

const DOMAIN_RECHECK_MS = 20 * 3600 * 1000; // 取れているドメイン期限の、再取得の間隔
const DOMAIN_RETRY_MS = 3600 * 1000; // 取れていないとき（失敗・未取得）の、再取得の間隔
const DOMAIN_DELAY_MS = 300; // ドメイン期限の問い合わせの間隔（相手に断られないよう、間を空ける）
const SIX_HOURS_MS = 6 * 3600 * 1000;

function needsDomainCheck(site, now) {
  if (!site.domain_checked_at) return true;
  const last = Date.parse(String(site.domain_checked_at).replace(' ', 'T') + 'Z');
  if (Number.isNaN(last)) return true;
  return now - last >= (site.domain_expires_auto ? DOMAIN_RECHECK_MS : DOMAIN_RETRY_MS);
}

async function runChecks(db, opts = {}) {
  const {
    siteIds = null, checkFn = checkSite, domainFn = fetchDomainExpiry, now = Date.now(), concurrency = 3,
    domainDelayMs = DOMAIN_DELAY_MS,
  } = opts;
  const sites = store.listSites(db).filter((s) => !siteIds || siteIds.includes(s.id));
  let next = 0;
  const needDomain = [];

  async function worker() {
    while (next < sites.length) {
      const site = sites[next];
      next += 1;
      try {
        store.recordCheck(db, site.id, await checkFn(site.url));
        if (needsDomainCheck(site, now)) needDomain.push(site);
      } catch (e) {
        // 1サイトの失敗で、全体を止めない（ログにはサイト名だけ出す）
        console.error(`[サイト確認] ${site.name} の確認に失敗しました: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sites.length) }, worker));

  // ドメイン期限は、1件ずつ順に問い合わせる。同じドメイン（別サブドメイン）は、1回だけ
  const byDomain = new Map();
  for (const site of needDomain) {
    try {
      const host = new URL(site.url).hostname;
      const key = registrableDomain(host);
      if (!byDomain.has(key)) {
        if (byDomain.size > 0 && domainDelayMs > 0) await new Promise((r) => setTimeout(r, domainDelayMs));
        byDomain.set(key, await domainFn(host));
      }
      store.setDomainAuto(db, site.id, byDomain.get(key), new Date(now).toISOString());
    } catch (e) {
      console.error(`[サイト確認] ${site.name} のドメイン期限の確認に失敗しました: ${e.message}`);
    }
  }
  return sites.length;
}

function startScheduler(db, { intervalMs = SIX_HOURS_MS, firstDelayMs = 60 * 1000, run = runChecks } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run(db);
    } catch (e) {
      console.error('[サイト確認] 定期確認に失敗しました:', e.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { DOMAIN_RECHECK_MS, runChecks, startScheduler };

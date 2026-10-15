// 登録されたサイトを順に確認して、結果を保存する。定期実行もここ。

const store = require('./maintenanceStore');
const { checkSite, fetchDomainExpiry } = require('./siteChecker');

const DOMAIN_RECHECK_MS = 20 * 3600 * 1000;
const SIX_HOURS_MS = 6 * 3600 * 1000;

function needsDomainCheck(site, now) {
  if (!site.domain_checked_at) return true;
  const last = Date.parse(String(site.domain_checked_at).replace(' ', 'T') + 'Z');
  return Number.isNaN(last) || now - last >= DOMAIN_RECHECK_MS;
}

async function runChecks(db, opts = {}) {
  const {
    siteIds = null, checkFn = checkSite, domainFn = fetchDomainExpiry, now = Date.now(), concurrency = 3,
  } = opts;
  const sites = store.listSites(db).filter((s) => !siteIds || siteIds.includes(s.id));
  let next = 0;

  async function worker() {
    while (next < sites.length) {
      const site = sites[next];
      next += 1;
      try {
        store.recordCheck(db, site.id, await checkFn(site.url));
        if (needsDomainCheck(site, now)) {
          const expires = await domainFn(new URL(site.url).hostname);
          store.setDomainAuto(db, site.id, expires, new Date(now).toISOString());
        }
      } catch (e) {
        // 1サイトの失敗で、全体を止めない（ログにはサイト名だけ出す）
        console.error(`[サイト確認] ${site.name} の確認に失敗しました: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sites.length) }, worker));
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

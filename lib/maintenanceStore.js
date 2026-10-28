// サイト保守のDB読み書き。dbは引数で受け取る（テストでは :memory: を使う）。
// 外部キーの連動削除は有効になっていないため、子の行は deleteSite で明示的に消す。

const { normalizeSiteUrl } = require('./siteUrl');
const { judgeSite } = require('./maintenanceStatus');

const LOG_KINDS = ['点検', '更新', 'バックアップ', '対応', 'その他'];
const HISTORY_LIMIT = 200;
const STALE_CHECK_MS = 24 * 3600 * 1000;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const utcMs = (sqlite) => Date.parse(String(sqlite).replace(' ', 'T') + 'Z');

function cleanSiteFields(f) {
  const name = String(f.name || '').trim();
  if (!name || name.length > 100) throw new Error('名前は1〜100文字で入力してください');
  const url = normalizeSiteUrl(f.url);
  const server_name = String(f.server_name || '').trim().slice(0, 50);
  const client_type = f.client_type === undefined || f.client_type === '' ? 'client' : f.client_type;
  if (client_type !== 'own' && client_type !== 'client') throw new Error('種別は「自社」か「受託」を選んでください');
  const manual = String(f.domain_expires_manual || '').trim();
  if (manual && !isDate(manual)) throw new Error('ドメイン期限は、日付（年-月-日）で入力してください');
  const memo = String(f.memo || '').trim();
  if (memo.length > 500) throw new Error('メモは500文字以内にしてください');
  return {
    name, url, server_name, client_type,
    is_wordpress: f.is_wordpress === false || f.is_wordpress === 0 || f.is_wordpress === '0' ? 0 : 1,
    domain_expires_manual: manual || null,
    memo,
  };
}

function addSite(db, fields) {
  const f = cleanSiteFields(fields);
  try {
    const r = db.prepare(
      `INSERT INTO maintenance_sites (name, url, server_name, client_type, is_wordpress, domain_expires_manual, memo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.name, f.url, f.server_name, f.client_type, f.is_wordpress, f.domain_expires_manual, f.memo, fields.created_by || null);
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new Error('すでに登録されているURLです');
    throw e;
  }
}

function updateSite(db, id, fields) {
  const f = cleanSiteFields(fields);
  try {
    db.prepare(
      `UPDATE maintenance_sites SET name=?, url=?, server_name=?, client_type=?, is_wordpress=?, domain_expires_manual=?, memo=?,
       updated_at=datetime('now') WHERE id=?`
    ).run(f.name, f.url, f.server_name, f.client_type, f.is_wordpress, f.domain_expires_manual, f.memo, id);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new Error('すでに登録されているURLです');
    throw e;
  }
}

function deleteSite(db, id) {
  db.transaction(() => {
    db.prepare('DELETE FROM maintenance_checks WHERE site_id=?').run(id);
    db.prepare('DELETE FROM maintenance_logs WHERE site_id=?').run(id);
    db.prepare('DELETE FROM maintenance_sites WHERE id=?').run(id);
  })();
}

const getSite = (db, id) => db.prepare('SELECT * FROM maintenance_sites WHERE id=?').get(id);
const listSites = (db) => db.prepare('SELECT * FROM maintenance_sites ORDER BY name COLLATE NOCASE, id').all();

function recordCheck(db, siteId, r) {
  db.transaction(() => {
    db.prepare(
      'INSERT INTO maintenance_checks (site_id, ok, http_status, response_ms, ssl_expires, error) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(siteId, r.ok ? 1 : 0, r.http_status ?? null, r.response_ms ?? null, r.ssl_expires ?? null, r.error ?? null);
    db.prepare(
      `DELETE FROM maintenance_checks WHERE site_id=? AND id NOT IN
       (SELECT id FROM maintenance_checks WHERE site_id=? ORDER BY id DESC LIMIT ${HISTORY_LIMIT})`
    ).run(siteId, siteId);
  })();
}

const latestChecks = (db, siteId, n) =>
  db.prepare('SELECT * FROM maintenance_checks WHERE site_id=? ORDER BY id DESC LIMIT ?').all(siteId, n);
const listChecks = (db, siteId, limit = 30) => latestChecks(db, siteId, limit);

function setDomainAuto(db, siteId, dateOrNull, checkedAtIso) {
  const checkedAt = String(checkedAtIso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
  if (dateOrNull) {
    db.prepare('UPDATE maintenance_sites SET domain_expires_auto=?, domain_checked_at=? WHERE id=?').run(dateOrNull, checkedAt, siteId);
  } else {
    db.prepare('UPDATE maintenance_sites SET domain_checked_at=? WHERE id=?').run(checkedAt, siteId);
  }
}

function addLog(db, siteId, l) {
  if (!LOG_KINDS.includes(l.kind)) throw new Error('種類を選んでください');
  if (!isDate(String(l.log_date || ''))) throw new Error('日付は、年-月-日の形で入力してください');
  const note = String(l.note || '').trim();
  if (note.length > 1000) throw new Error('内容は1000文字以内にしてください');
  const r = db.prepare('INSERT INTO maintenance_logs (site_id, log_date, kind, note, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(siteId, l.log_date, l.kind, note, l.created_by || null);
  return Number(r.lastInsertRowid);
}

// 別のサイトの記録を消さないよう、site_id も条件に含める
const deleteLog = (db, logId, siteId) =>
  db.prepare('DELETE FROM maintenance_logs WHERE id=? AND site_id=?').run(logId, siteId);
const listLogs = (db, siteId) =>
  db.prepare('SELECT * FROM maintenance_logs WHERE site_id=? ORDER BY log_date DESC, id DESC').all(siteId);

const lastLogDate = (db, siteId, kind) =>
  db.prepare('SELECT MAX(log_date) d FROM maintenance_logs WHERE site_id=? AND kind=?').get(siteId, kind).d || null;

const lastSslExpiry = (db, siteId) => {
  const r = db.prepare(
    'SELECT ssl_expires FROM maintenance_checks WHERE site_id=? AND ssl_expires IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(siteId);
  return r ? r.ssl_expires : null;
};

function buildRow(db, site, todayStr) {
  const checks = latestChecks(db, site.id, 3);
  const lastBackup = lastLogDate(db, site.id, 'バックアップ');
  const lastInspect = lastLogDate(db, site.id, '点検');
  // 証明書の期限は、最後に取れた値を使う（失敗が続いても、期限切れの表示を消さない）
  const sslExpires = lastSslExpiry(db, site.id);
  const domainExpires = site.domain_expires_manual || site.domain_expires_auto || null;
  // PCが取得したバックアップの、最後の結果（一度も届いていなければ null）
  const pcBackup = site.pc_report_at
    ? { reportAt: site.pc_report_at, ok: !!site.pc_report_ok, error: site.pc_report_error || null, size: site.pc_backup_size || 0 }
    : null;
  // 最新のバックアップの記録が、PC取得の自動記録かどうか（一覧の「PC取得済み」の印）
  const pcFetched = !!lastBackup && !!db.prepare("SELECT 1 FROM maintenance_logs WHERE site_id=? AND kind='バックアップ' AND log_date=? AND created_by='auto:pc-backup'").get(site.id, lastBackup);
  const status = judgeSite({ checks, sslExpires, domainExpires, lastBackup, lastInspect, pcBackup, todayStr });
  return { site, status, lastBackup, pcBackup, pcFetched, lastInspect, sslExpires, domainExpires, lastCheckedAt: checks[0] ? checks[0].checked_at : null };
}

const overview = (db, todayStr) => listSites(db).map((s) => buildRow(db, s, todayStr));
function getRow(db, id, todayStr) {
  const site = getSite(db, id);
  return site ? buildRow(db, site, todayStr) : null;
}

const RANK = { urgent: 0, warn: 1, unknown: 2, ok: 3 };
function sortOverview(rows) {
  return [...rows].sort((a, b) =>
    (RANK[a.status.level] - RANK[b.status.level]) || a.site.name.localeCompare(b.site.name, 'ja'));
}

const isExpiring = (st) => ['ssl', 'domain'].some((k) => ['warn', 'urgent'].includes(st.parts[k].level));

function summarize(rows, nowMs) {
  const times = rows.map((r) => r.lastCheckedAt).filter(Boolean).sort();
  const lastCheckedAt = times.length ? times[times.length - 1] : null;
  // 確認が1件もない間は「確認待ち（pending）」。「24時間以上更新なし（stale）」は、確認があって古いときだけ
  const pending = rows.length > 0 && !lastCheckedAt;
  const stale = rows.length > 0 && !!lastCheckedAt && nowMs - utcMs(lastCheckedAt) > STALE_CHECK_MS;
  return {
    total: rows.length,
    urgent: rows.filter((r) => r.status.level === 'urgent').length,
    expiring: rows.filter((r) => isExpiring(r.status)).length,
    lastCheckedAt,
    stale,
    pending,
  };
}

module.exports = {
  LOG_KINDS, HISTORY_LIMIT, cleanSiteFields, addSite, updateSite, deleteSite, getSite, listSites,
  recordCheck, latestChecks, listChecks, setDomainAuto, addLog, deleteLog, listLogs,
  buildRow, overview, getRow, sortOverview, summarize, isExpiring,
};

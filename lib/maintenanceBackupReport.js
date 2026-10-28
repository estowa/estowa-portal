// PCが取得したバックアップの結果を、サイト保守に反映する。
// 受け取るのは運用状況だけ（サイトのURL・バックアップの日付・サイズ・成否・失敗の分類）。ファイル名・パス・認証情報などは受け取らない。

const { normalizeSiteUrl } = require('./siteUrl');
const { addLog } = require('./maintenanceStore');

const AUTO_USER = 'auto:pc-backup';
const MAX_RESULTS = 100;

// 失敗の分類（これ以外の値は「その他」にする。自由な文章は受け取らない）
const ERROR_CODES = ['connect', 'auth', 'verify', 'size', 'other'];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

function sizeText(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  return Math.max(1, Math.round(bytes / 1024)) + 'KB';
}

// body: { results: [{ url, ok, date, size_bytes, error }] }。登録のないサイト・形式の違うものは数えて捨てる。
// 同じサイト・同じ日付の自動記録は、新しく増やさず更新する
function applyBackupReport(db, body) {
  const results = body && Array.isArray(body.results) ? body.results : null;
  if (!results) throw new Error('bad_request');
  if (results.length > MAX_RESULTS) throw new Error('too_many');
  const summary = { recorded: 0, failed: 0, ignored: 0 };

  const findSite = db.prepare('SELECT id FROM maintenance_sites WHERE url = ?');
  const findLog = db.prepare("SELECT id FROM maintenance_logs WHERE site_id = ? AND kind = 'バックアップ' AND log_date = ? AND created_by = ?");
  const updLog = db.prepare('UPDATE maintenance_logs SET note = ? WHERE id = ?');
  const setOk = db.prepare("UPDATE maintenance_sites SET pc_report_at = datetime('now'), pc_report_ok = 1, pc_report_error = NULL, pc_backup_size = ? WHERE id = ?");
  const setNg = db.prepare("UPDATE maintenance_sites SET pc_report_at = datetime('now'), pc_report_ok = 0, pc_report_error = ? WHERE id = ?");

  db.transaction(() => {
    for (const r of results) {
      let site = null;
      try {
        if (r && typeof r === 'object') site = findSite.get(normalizeSiteUrl(r.url));
      } catch (e) {
        site = null;
      }
      if (!site || typeof r.ok !== 'boolean') { summary.ignored += 1; continue; }
      if (!r.ok) {
        setNg.run(ERROR_CODES.includes(r.error) ? r.error : 'other', site.id);
        summary.failed += 1;
        continue;
      }
      const date = String(r.date || '');
      const size = Number.isInteger(r.size_bytes) && r.size_bytes > 0 ? r.size_bytes : 0;
      if (!isDate(date)) { summary.ignored += 1; continue; }
      const note = ('PC取得 ' + sizeText(size)).trim();
      const existing = findLog.get(site.id, date, AUTO_USER);
      if (existing) updLog.run(note, existing.id);
      else addLog(db, site.id, { kind: 'バックアップ', log_date: date, note, created_by: AUTO_USER });
      setOk.run(size, site.id);
      summary.recorded += 1;
    }
  })();
  return summary;
}

module.exports = { applyBackupReport, ERROR_CODES, AUTO_USER, MAX_RESULTS, sizeText };

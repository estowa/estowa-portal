// サイト保守のテーブルを作る（何度実行しても安全）。
// 既存のテーブルは変更しない。
function ensureMaintenanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      server_name TEXT,
      client_type TEXT NOT NULL DEFAULT 'client',   -- own(自社) / client(受託)
      is_wordpress INTEGER NOT NULL DEFAULT 1,
      domain_expires_manual TEXT,                   -- YYYY-MM-DD(手入力。自動取得より優先)
      domain_expires_auto TEXT,                     -- YYYY-MM-DD(RDAPで取得)
      domain_checked_at TEXT,                       -- 最後にRDAPを確認した日時(UTC)
      memo TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS maintenance_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      ok INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      response_ms INTEGER,
      ssl_expires TEXT,                             -- YYYY-MM-DD
      error TEXT                                    -- timeout / dns / blocked などの短い分類だけ
    );
    CREATE INDEX IF NOT EXISTS idx_mt_checks_site ON maintenance_checks(site_id, id);
    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      log_date TEXT NOT NULL,                       -- YYYY-MM-DD
      kind TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mt_logs_site ON maintenance_logs(site_id, log_date);
  `);
  // 2026-10-28追加: PCが取得したバックアップの、最後の結果（最後に受け取った日時・成否・失敗の分類・最後に成功したサイズ）
  const cols = db.prepare('PRAGMA table_info(maintenance_sites)').all().map((c) => c.name);
  for (const [name, type] of [['pc_report_at', 'TEXT'], ['pc_report_ok', 'INTEGER'], ['pc_report_error', 'TEXT'], ['pc_backup_size', 'INTEGER']]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE maintenance_sites ADD COLUMN ${name} ${type}`);
  }
}

module.exports = { ensureMaintenanceSchema };

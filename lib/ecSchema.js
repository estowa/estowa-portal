// EC売上のテーブルを作る（何度実行しても安全）。
// 旧テーブル sales_orders は残す（氏名・送付先の列は2026-10-29に本番から削除済み）。
function ensureEcSchema(db) {
  createTables(db);
  ensureEcColumns(db);
}

function createTables(db) {
  db.exec(`
    -- 注文明細（新仕様の売上CSV）。受注番号がキーなので、同じ注文を再アップしても二重にならない。
    -- 氏名・住所などの個人情報は保存しない
    CREATE TABLE IF NOT EXISTS ec_order_items (
      order_no TEXT PRIMARY KEY,
      ship_month TEXT NOT NULL,        -- 発送月 YYYY-MM
      mall TEXT NOT NULL,
      product_code TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL DEFAULT 0, -- 請求金額(税込)
      imported_by TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ec_items_month ON ec_order_items(ship_month);

    -- 商品コード一覧（アップのたびに全部入れ替える）
    CREATE TABLE IF NOT EXISTS ec_products (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    -- 過去分のモール別月次売上（旧仕様の期間用）
    CREATE TABLE IF NOT EXISTS ec_monthly_mall (
      month TEXT NOT NULL,             -- YYYY-MM
      mall TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0, -- 税込
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (month, mall)
    );

    -- 実施している広告・販促（モールごとに複数行）
    CREATE TABLE IF NOT EXISTS ec_ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mall TEXT NOT NULL,
      start_date TEXT NOT NULL,        -- YYYY-MM-DD
      end_date TEXT NOT NULL,          -- YYYY-MM-DD（単日はstart_dateと同じ）
      title TEXT NOT NULL,
      content TEXT,
      price TEXT,                      -- 自由入力（「¥3,980」「20%OFF」など）
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ec_ads_start ON ec_ads(start_date);
  `);
}

// 既存DBに quantity(数量) 列がなければ追加する（既存の行は1個として扱う）
function ensureEcColumns(db) {
  const cols = db.prepare('PRAGMA table_info(ec_order_items)').all().map((c) => c.name);
  if (!cols.includes('quantity')) {
    db.exec('ALTER TABLE ec_order_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
  }
}

module.exports = { ensureEcSchema };

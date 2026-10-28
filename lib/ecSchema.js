// EC売上のテーブルを作る（何度実行しても安全）。
// 旧テーブル sales_orders は変更しない（旧データはそのまま残す）。
function ensureEcSchema(db) {
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
  `);
}

module.exports = { ensureEcSchema };

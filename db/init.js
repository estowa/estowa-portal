// データベース初期化スクリプト
// ユーザーテーブルを作成し、初期管理者アカウントを1件登録する

const path = require('path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');

const dbPath = path.join(__dirname, 'estowa.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// ユーザーテーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,       -- ログインID
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member', -- 'admin' or 'member'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// お知らせテーブル(ホーム画面用の先行実装)
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// タスクテーブル(カンバンボード用)
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,       -- 担当者のログインID
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo', -- todo / doing / done
    due_date TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 既存DBに created_by 列がない場合は追加(マイグレーション)
const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes('created_by')) {
  db.exec('ALTER TABLE tasks ADD COLUMN created_by TEXT');
  console.log('tasksテーブルに created_by 列を追加しました');
}

// 勤怠打刻テーブル(仮。フェーズ3で本実装)
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- 'in' or 'out'
    logged_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 売上データテーブル(ROBOTINのCSV取り込み用)
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_date TEXT NOT NULL,      -- 受注日 (YYYY-MM-DD)
    customer_name TEXT,            -- 氏名
    mall TEXT NOT NULL,            -- モール
    product_name TEXT,             -- 商品名
    shipping_address TEXT,         -- 送付先
    amount INTEGER NOT NULL DEFAULT 0, -- 金額
    imported_by TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 初期管理者アカウント（存在しない場合のみ作成）
const existingAdmin = db.prepare('SELECT * FROM users WHERE user_id = ?').get('admin');
if (!existingAdmin) {
  const hash = bcrypt.hashSync('estowa2026', 10);
  db.prepare(
    'INSERT INTO users (user_id, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  ).run('admin', hash, '管理者', 'admin');
  console.log('初期管理者アカウントを作成しました → ID: admin / パスワード: estowa2026');
  console.log('※ ログイン後、必ずパスワードを変更してください');
} else {
  console.log('管理者アカウントは既に存在します（作成をスキップ）');
}

console.log('データベース初期化が完了しました:', dbPath);
db.close();

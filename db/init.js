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
    email TEXT,                          -- 通知メール送信先
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 既存DBに email 列がない場合は追加(マイグレーション)
const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColumns.includes('email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  console.log('usersテーブルに email 列を追加しました');
}

// 既存DBに avatar_emoji / avatar_color 列がない場合は追加(マイグレーション)
// タスク一覧・お知らせでの視認性向上のため、担当者/投稿者をアイコン表示できるようにする
if (!userColumns.includes('avatar_emoji')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_emoji TEXT');
  console.log('usersテーブルに avatar_emoji 列を追加しました');
}
if (!userColumns.includes('avatar_color')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_color TEXT');
  console.log('usersテーブルに avatar_color 列を追加しました');
}
// 自分でアップロードした画像をアイコンとして使えるように(設定されていれば絵文字より優先表示)
if (!userColumns.includes('avatar_image')) {
  db.exec('ALTER TABLE users ADD COLUMN avatar_image TEXT');
  console.log('usersテーブルに avatar_image 列を追加しました');
}

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
let taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes('created_by')) {
  db.exec('ALTER TABLE tasks ADD COLUMN created_by TEXT');
  console.log('tasksテーブルに created_by 列を追加しました');
}

// 開始日・締切日時(時刻まで)列を追加(マイグレーション)
taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes('start_date')) {
  db.exec('ALTER TABLE tasks ADD COLUMN start_date TEXT');
  console.log('tasksテーブルに start_date 列を追加しました');
}
if (!taskColumns.includes('due_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN due_at TEXT');
  console.log('tasksテーブルに due_at 列を追加しました');
  // 旧 due_date (日付のみ) が入っていれば 00:00 として引き継ぐ
  if (taskColumns.includes('due_date')) {
    db.exec("UPDATE tasks SET due_at = due_date || 'T00:00' WHERE due_at IS NULL AND due_date IS NOT NULL");
  }
}

// 担当者(複数人)テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS task_assignees (
    task_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );
`);
// 旧 user_id(単一担当者)を task_assignees に引き継ぐ
if (taskColumns.includes('user_id')) {
  db.exec(`
    INSERT OR IGNORE INTO task_assignees (task_id, user_id)
    SELECT id, user_id FROM tasks WHERE user_id IS NOT NULL AND user_id != ''
  `);
}

// 旧 tasks.user_id 列は NOT NULL 制約付きで残っており、複数担当者化に伴い不要になったため
// テーブルを再作成して制約を取り除く(SQLiteは列制約を直接変更できないため)
if (taskColumns.includes('user_id')) {
  db.exec(`
    CREATE TABLE tasks_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      due_date TEXT,
      due_at TEXT,
      start_date TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO tasks_new (id, title, status, due_date, due_at, start_date, created_by, created_at)
      SELECT id, title, status, due_date, due_at, start_date, created_by, created_at FROM tasks;
    DROP TABLE tasks;
    ALTER TABLE tasks_new RENAME TO tasks;
  `);
  console.log('tasksテーブルを再作成し、旧user_id列(NOT NULL制約)を除去しました');
}

// 概要(詳細説明)列を追加(マイグレーション) - Asanaのようなタスク概要欄
taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes('description')) {
  db.exec('ALTER TABLE tasks ADD COLUMN description TEXT');
  console.log('tasksテーブルに description 列を追加しました');
}

// 最終更新者・最終更新日時列を追加(マイグレーション) - 更新通知メールの表示用
taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes('updated_by')) {
  db.exec('ALTER TABLE tasks ADD COLUMN updated_by TEXT');
  console.log('tasksテーブルに updated_by 列を追加しました');
}
if (!taskColumns.includes('updated_at')) {
  db.exec('ALTER TABLE tasks ADD COLUMN updated_at TEXT');
  console.log('tasksテーブルに updated_at 列を追加しました');
}

// 開始日の時刻列を追加(マイグレーション) - 開始日にも時刻を指定できるように
// (旧user_id列除去のテーブル再作成より後段に置き、再作成時に列が消えないようにする)
taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes('start_time')) {
  db.exec('ALTER TABLE tasks ADD COLUMN start_time TEXT');
  console.log('tasksテーブルに start_time 列を追加しました');
}

// タスク添付ファイル(画像・各種ファイル)テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    uploaded_by TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
// 既存DBに mime_type 列がない場合は追加(マイグレーション)
let attachmentColumns = db.prepare("PRAGMA table_info(task_attachments)").all().map((c) => c.name);
if (!attachmentColumns.includes('mime_type')) {
  db.exec('ALTER TABLE task_attachments ADD COLUMN mime_type TEXT');
  console.log('task_attachmentsテーブルに mime_type 列を追加しました');
}

// タスクのコメント(やり取り)テーブル - コメント本文・添付ファイルを時系列で表示するため
db.exec(`
  CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    user_id TEXT,
    body TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 添付ファイルをコメントに紐付けるための comment_id 列を追加(マイグレーション)
// (紐付けがない既存の添付ファイルはタイムライン上で単独の「ファイル追加」として表示する)
attachmentColumns = db.prepare("PRAGMA table_info(task_attachments)").all().map((c) => c.name);
if (!attachmentColumns.includes('comment_id')) {
  db.exec('ALTER TABLE task_attachments ADD COLUMN comment_id INTEGER');
  console.log('task_attachmentsテーブルに comment_id 列を追加しました');
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

// 外注先リスト
db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    name TEXT NOT NULL,
    contact_info TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 共有シートリンク集
db.exec(`
  CREATE TABLE IF NOT EXISTS sheet_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    tags TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 表計算（シンプルな自由表 + 計算式）
db.exec(`
  CREATE TABLE IF NOT EXISTS spreadsheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ナレッジ共有（Markdown記事）
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    title TEXT NOT NULL,
    body TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

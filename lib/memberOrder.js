// メンバーの並び順(担当者の選択欄・カードのアイコンの順)。users.sort_order が小さい順。
// 未設定(NULL)の人は、設定済みの人の後ろに、登録順(id)で並ぶ。
const ORDER_SQL = 'users.sort_order IS NULL, users.sort_order, users.id';

// 2026-10-29に決めた順(user_id)
const INITIAL_ORDER = ['yamaguchi', 'shiroto', 'ueda', 'kikuchi', 'kudo', 'kogawa'];

// 列がなければ追加し、追加した直後だけ、決めた順を入れる(その後に画面などで変えても、上書きしない)
function ensureMemberOrder(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (cols.includes('sort_order')) return;
  db.exec('ALTER TABLE users ADD COLUMN sort_order INTEGER');
  const set = db.prepare('UPDATE users SET sort_order = ? WHERE user_id = ?');
  INITIAL_ORDER.forEach((userId, i) => set.run(i + 1, userId));
}

module.exports = { ORDER_SQL, INITIAL_ORDER, ensureMemberOrder };

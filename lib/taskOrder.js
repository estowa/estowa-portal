// ボードの列の中の並び順。手で並べ替えたもの（sort_order あり）は、その順。
// 並べ替えていない新しいタスクは、列の一番上に出て、その中は締切日の順（従来どおり）
const TASK_ORDER_SQL = 'sort_order IS NOT NULL, sort_order ASC, due_at IS NULL, due_at ASC, id DESC';

// タスクを、同じボードの status 列の beforeId の手前に置く（beforeId がなければ列の末尾）。
// 列の全タスクに 1,2,3… の並び順を付け直す。ステータスが変わったかは呼び出し側で判断する
function placeTask(db, taskId, status, beforeId) {
  const task = db.prepare('SELECT id, board FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('not_found');
  return db.transaction(() => {
    const ids = db
      .prepare(`SELECT id FROM tasks WHERE board = ? AND status = ? AND id != ? ORDER BY ${TASK_ORDER_SQL}`)
      .all(task.board, status, task.id)
      .map((r) => r.id);
    const at = ids.indexOf(Number(beforeId));
    ids.splice(at === -1 ? ids.length : at, 0, task.id);
    const set = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');
    ids.forEach((id, i) => set.run(i + 1, id));
    return ids;
  })();
}

module.exports = { TASK_ORDER_SQL, placeTask };

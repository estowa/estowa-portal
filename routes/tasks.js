const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

const STATUSES = ['todo', 'doing', 'done'];

function getMonthRange(year, month) {
  // month: 1-12
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, lastDay };
}

// タスク管理画面（カンバン + カレンダー）
router.get('/tasks', requireLogin, (req, res) => {
  const allTasks = db
    .prepare(
      `SELECT tasks.*, users.display_name AS assignee_name
       FROM tasks
       LEFT JOIN users ON users.user_id = tasks.user_id
       ORDER BY tasks.due_date IS NULL, tasks.due_date ASC, tasks.id DESC`
    )
    .all();

  const board = { todo: [], doing: [], done: [] };
  allTasks.forEach((t) => {
    if (board[t.status]) board[t.status].push(t);
  });

  const users = db.prepare('SELECT user_id, display_name FROM users ORDER BY display_name').all();

  // カレンダー用（クエリでyear/monthを指定可能。指定なしは今月）
  const today = new Date();
  const year = parseInt(req.query.year, 10) || today.getFullYear();
  const month = parseInt(req.query.month, 10) || today.getMonth() + 1;
  const { start, end, lastDay } = getMonthRange(year, month);

  const monthTasks = db
    .prepare(
      `SELECT tasks.*, users.display_name AS assignee_name
       FROM tasks
       LEFT JOIN users ON users.user_id = tasks.user_id
       WHERE due_date BETWEEN ? AND ?`
    )
    .all(start, end);

  const tasksByDay = {};
  monthTasks.forEach((t) => {
    const day = parseInt(t.due_date.split('-')[2], 10);
    if (!tasksByDay[day]) tasksByDay[day] = [];
    tasksByDay[day].push(t);
  });

  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0=日曜

  let prevMonth = month - 1, prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  let nextMonth = month + 1, nextYear = year;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  res.render('tasks/index', {
    board,
    users,
    year,
    month,
    lastDay,
    firstWeekday,
    tasksByDay,
    prevMonth,
    prevYear,
    nextMonth,
    nextYear,
    error: null,
  });
});

// タスク新規作成
router.post('/tasks', requireLogin, (req, res) => {
  const { title, user_id, due_date } = req.body;
  if (!title || !user_id) {
    return res.redirect('/tasks');
  }
  db.prepare(
    'INSERT INTO tasks (user_id, title, due_date, created_by) VALUES (?, ?, ?, ?)'
  ).run(user_id, title, due_date || null, req.session.user.user_id);
  res.redirect('/tasks');
});

// ステータス変更（カンバンでのドラッグ移動 / ボタン操作）
router.post('/tasks/:id/status', requireLogin, (req, res) => {
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: '不正なステータスです' });
  }
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, req.params.id);

  if (req.headers['x-requested-with'] === 'fetch') {
    return res.json({ ok: true });
  }
  res.redirect('/tasks');
});

// タスク削除
router.post('/tasks/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.redirect('/tasks');
});

module.exports = router;

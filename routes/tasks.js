const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

const STATUS_DEFS = [
  ['internal', '社内用'],
  ['todo', '未着手'],
  ['doing', '進行中'],
  ['internal_check', '社内確認'],
  ['client_check', 'クライアント確認'],
  ['fix', '修正対応'],
  ['done', '完了'],
];
const STATUSES = STATUS_DEFS.map(([key]) => key);

const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'tasks');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      const safeExt = /^[a-zA-Z0-9.]*$/.test(ext) ? ext : '';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\//.test(file.mimetype));
  },
});

function getMonthRange(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end, lastDay };
}

function dueDateOnly(dueAt) {
  return dueAt ? dueAt.split('T')[0] : null;
}

function attachAssignees(tasks) {
  if (tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT task_assignees.task_id, users.user_id, users.display_name
       FROM task_assignees
       LEFT JOIN users ON users.user_id = task_assignees.user_id
       WHERE task_assignees.task_id IN (${placeholders})`
    )
    .all(...ids);
  const byTask = {};
  rows.forEach((r) => {
    if (!byTask[r.task_id]) byTask[r.task_id] = [];
    byTask[r.task_id].push({ user_id: r.user_id, display_name: r.display_name || r.user_id });
  });
  tasks.forEach((t) => {
    t.assignees = byTask[t.id] || [];
    t.assigneeNames = t.assignees.map((a) => a.display_name).join('、');
  });
  return tasks;
}

// タスク管理画面（カンバン + カレンダー）
router.get('/tasks', requireLogin, (req, res) => {
  const allTasks = db.prepare('SELECT * FROM tasks ORDER BY due_at IS NULL, due_at ASC, id DESC').all();
  attachAssignees(allTasks);

  const board = {};
  STATUSES.forEach((s) => { board[s] = []; });
  allTasks.forEach((t) => {
    if (board[t.status]) {
      board[t.status].push(t);
    } else {
      board.todo.push(t);
    }
  });

  const users = db.prepare('SELECT user_id, display_name FROM users ORDER BY display_name').all();

  const today = new Date();
  const year = parseInt(req.query.year, 10) || today.getFullYear();
  const month = parseInt(req.query.month, 10) || today.getMonth() + 1;
  const { start, end, lastDay } = getMonthRange(year, month);

  // 月内に少しでも重なるタスク(開始日〜締切日の範囲)を取得
  const overlapping = db
    .prepare(
      `SELECT * FROM tasks
       WHERE due_at IS NOT NULL
         AND COALESCE(start_date, date(due_at)) <= ?
         AND date(due_at) >= ?`
    )
    .all(end, start);
  attachAssignees(overlapping);

  const tasksByDay = {};
  overlapping.forEach((t) => {
    const rangeStart = t.start_date || dueDateOnly(t.due_at);
    const rangeEnd = dueDateOnly(t.due_at);
    for (let day = 1; day <= lastDay; day++) {
      const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (dayStr >= rangeStart && dayStr <= rangeEnd) {
        if (!tasksByDay[day]) tasksByDay[day] = [];
        tasksByDay[day].push(t);
      }
    }
  });

  const firstWeekday = new Date(year, month - 1, 1).getDay();

  let prevMonth = month - 1, prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear -= 1; }
  let nextMonth = month + 1, nextYear = year;
  if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }

  res.render('tasks/index', {
    board,
    statusDefs: STATUS_DEFS,
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

// 指定日のタスク一覧
router.get('/tasks/day/:date', requireLogin, (req, res) => {
  const { date } = req.params;
  const tasks = db
    .prepare(
      `SELECT * FROM tasks
       WHERE due_at IS NOT NULL
         AND COALESCE(start_date, date(due_at)) <= ?
         AND date(due_at) >= ?`
    )
    .all(date, date);
  attachAssignees(tasks);
  res.render('tasks/day', { date, tasks, statusDefs: STATUS_DEFS });
});

// タスク新規作成
router.post('/tasks', requireLogin, (req, res) => {
  const { title, due_date, due_time, start_date, assignee_ids } = req.body;
  if (!title || !due_date) {
    return res.redirect('/tasks');
  }
  const dueAt = `${due_date}T${due_time || '18:00'}`;
  const result = db
    .prepare('INSERT INTO tasks (title, due_at, start_date, created_by) VALUES (?, ?, ?, ?)')
    .run(title, dueAt, start_date || null, req.session.user.user_id);

  const assignees = Array.isArray(assignee_ids) ? assignee_ids : (assignee_ids ? [assignee_ids] : []);
  const insertAssignee = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  assignees.forEach((uid) => insertAssignee.run(result.lastInsertRowid, uid));

  res.redirect('/tasks/' + result.lastInsertRowid);
});

// タスク詳細・編集画面
router.get('/tasks/:id', requireLogin, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { message: 'タスクが見つかりません', user: req.session.user });
  attachAssignees([task]);

  const attachments = db
    .prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY uploaded_at DESC')
    .all(task.id);

  const users = db.prepare('SELECT user_id, display_name FROM users ORDER BY display_name').all();
  const assignedIds = new Set(task.assignees.map((a) => a.user_id));

  res.render('tasks/show', {
    task,
    attachments,
    users,
    assignedIds,
    statusDefs: STATUS_DEFS,
    error: null,
  });
});

// タスク更新（内容・担当者・ステータス）
router.post('/tasks/:id', requireLogin, (req, res) => {
  const { title, status, due_date, due_time, start_date, assignee_ids } = req.body;
  if (!title || !due_date) {
    return res.redirect('/tasks/' + req.params.id);
  }
  const dueAt = `${due_date}T${due_time || '18:00'}`;

  db.prepare(
    'UPDATE tasks SET title = ?, status = ?, due_at = ?, start_date = ? WHERE id = ?'
  ).run(title, STATUSES.includes(status) ? status : 'todo', dueAt, start_date || null, req.params.id);

  const assignees = Array.isArray(assignee_ids) ? assignee_ids : (assignee_ids ? [assignee_ids] : []);
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(req.params.id);
  const insertAssignee = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  assignees.forEach((uid) => insertAssignee.run(req.params.id, uid));

  res.redirect('/tasks/' + req.params.id);
});

// 画像添付のアップロード
router.post('/tasks/:id/attachments', requireLogin, upload.array('images', 10), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { message: 'タスクが見つかりません', user: req.session.user });

  const insert = db.prepare(
    'INSERT INTO task_attachments (task_id, filename, original_name, uploaded_by) VALUES (?, ?, ?, ?)'
  );
  (req.files || []).forEach((f) => {
    insert.run(task.id, f.filename, f.originalname, req.session.user.user_id);
  });
  res.redirect('/tasks/' + req.params.id);
});

// 添付画像の削除
router.post('/tasks/:id/attachments/:attId/delete', requireLogin, (req, res) => {
  const att = db.prepare('SELECT * FROM task_attachments WHERE id = ? AND task_id = ?').get(req.params.attId, req.params.id);
  if (att) {
    const filePath = path.join(UPLOAD_DIR, att.filename);
    fs.unlink(filePath, () => {});
    db.prepare('DELETE FROM task_attachments WHERE id = ?').run(att.id);
  }
  res.redirect('/tasks/' + req.params.id);
});

// ステータス変更（カンバンでのドラッグ移動）
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
  const attachments = db.prepare('SELECT * FROM task_attachments WHERE task_id = ?').all(req.params.id);
  attachments.forEach((att) => fs.unlink(path.join(UPLOAD_DIR, att.filename), () => {}));
  db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(req.params.id);
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.redirect('/tasks');
});

module.exports = router;

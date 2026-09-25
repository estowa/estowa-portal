const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const mailer = require('../lib/mailer');

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

// 実行ファイルなど危険な拡張子のみ拒否し、それ以外の画像・PDF・Office文書・
// 圧縮ファイルなどは幅広く添付できるようにする(Asanaのような添付イメージ)
const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.com', '.php', '.js', '.jar', '.app'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      const safeExt = /^[a-zA-Z0-9.]*$/.test(ext) ? ext : '';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.includes(ext)) {
      return cb(null, false);
    }
    cb(null, true);
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

// 締切日時(任意)を組み立てる。日付が未入力ならnull
function buildDueAt(dueDate, dueTime) {
  if (!dueDate) return null;
  return `${dueDate}T${dueTime || '18:00'}`;
}

// 開始日+開始時刻の表示用テキスト
function formatStart(startDate, startTime) {
  if (!startDate) return 'なし';
  return startTime ? `${startDate} ${startTime}` : startDate;
}

const STATUS_LABELS = Object.fromEntries(STATUS_DEFS);

function statusLabel(key) {
  return STATUS_LABELS[key] || key;
}

function displayNamesFor(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const placeholders = userIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT user_id, display_name FROM users WHERE user_id IN (${placeholders})`).all(...userIds);
  const byId = Object.fromEntries(rows.map((r) => [r.user_id, r.display_name]));
  return userIds.map((id) => byId[id] || id);
}

// 指定したユーザーIDのメールアドレス一覧を取得(未設定は除外)
function emailsFor(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const placeholders = userIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT email FROM users WHERE user_id IN (${placeholders}) AND email IS NOT NULL AND email != ''`)
    .all(...userIds);
  return rows.map((r) => r.email);
}

// タスクの主要な変更(ステータス・締切・担当者)を通知メールで送信する
// 変更した本人には送らず、担当者+作成者にのみ送信する
function notifyTaskUpdate({ task, actorUserId, changeLines }) {
  if (changeLines.length === 0) return;

  const assigneeRows = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(task.id);
  const recipientIds = new Set(assigneeRows.map((r) => r.user_id));
  if (task.created_by) recipientIds.add(task.created_by);
  recipientIds.delete(actorUserId);

  const to = emailsFor(Array.from(recipientIds));
  if (to.length === 0) return;

  const actorName = displayNamesFor([actorUserId])[0] || actorUserId;
  const url = `${mailer.getBaseUrl()}/tasks/${task.id}`;
  const subject = `[estowa社内ポータル] タスク更新: ${task.title}`;
  const text =
    `${actorName} さんがタスク「${task.title}」を更新しました。\n\n` +
    changeLines.join('\n') +
    `\n\n詳細はこちら:\n${url}`;
  const html =
    `<p>${actorName} さんがタスク「<strong>${task.title}</strong>」を更新しました。</p>` +
    `<ul>${changeLines.map((l) => `<li>${l}</li>`).join('')}</ul>` +
    `<p><a href="${url}">詳細を見る</a></p>`;

  mailer.sendMail({ to, subject, text, html }).catch((err) => console.error('[tasks] メール通知エラー:', err));
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

// タスク新規作成画面(専用ページ)
router.get('/tasks/new', requireLogin, (req, res) => {
  const users = db.prepare('SELECT user_id, display_name FROM users ORDER BY display_name').all();
  res.render('tasks/new', { users, statusDefs: STATUS_DEFS, error: null });
});

// タスク新規作成
router.post('/tasks', requireLogin, (req, res) => {
  const { title, description, status, due_date, due_time, start_date, start_time, assignee_ids } = req.body;
  if (!title) {
    return res.redirect('/tasks/new');
  }
  const dueAt = buildDueAt(due_date, due_time);
  const newStatus = STATUSES.includes(status) ? status : 'todo';
  const result = db
    .prepare('INSERT INTO tasks (title, description, status, due_at, start_date, start_time, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(title, description || null, newStatus, dueAt, start_date || null, start_date ? (start_time || null) : null, req.session.user.user_id);

  const assignees = Array.isArray(assignee_ids) ? assignee_ids : (assignee_ids ? [assignee_ids] : []);
  const insertAssignee = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  assignees.forEach((uid) => insertAssignee.run(result.lastInsertRowid, uid));

  res.redirect('/tasks');
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
  const updatedByName = task.updated_by ? displayNamesFor([task.updated_by])[0] : null;

  res.render('tasks/show', {
    task,
    attachments,
    users,
    assignedIds,
    updatedByName,
    statusDefs: STATUS_DEFS,
    error: null,
    uploadError: req.query.uploadError || null,
  });
});

// タスク更新（内容・担当者・ステータス）
router.post('/tasks/:id', requireLogin, (req, res) => {
  const { title, description, status, due_date, due_time, start_date, start_time, assignee_ids } = req.body;
  if (!title) {
    return res.redirect('/tasks/' + req.params.id);
  }
  const dueAt = buildDueAt(due_date, due_time);
  const newStatus = STATUSES.includes(status) ? status : 'todo';
  const newStartDate = start_date || null;
  const newStartTime = newStartDate ? (start_time || null) : null;

  const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!before) return res.redirect('/tasks');
  const beforeAssigneeIds = db.prepare('SELECT user_id FROM task_assignees WHERE task_id = ?').all(req.params.id).map((r) => r.user_id);

  db.prepare(
    "UPDATE tasks SET title = ?, description = ?, status = ?, due_at = ?, start_date = ?, start_time = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, description || null, newStatus, dueAt, newStartDate, newStartTime, req.session.user.user_id, req.params.id);

  const assignees = Array.isArray(assignee_ids) ? assignee_ids : (assignee_ids ? [assignee_ids] : []);
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(req.params.id);
  const insertAssignee = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id) VALUES (?, ?)');
  assignees.forEach((uid) => insertAssignee.run(req.params.id, uid));

  // 主要な変更(ステータス・締切・開始日・担当者)のみ通知メールを送る
  const changeLines = [];
  if (before.status !== newStatus) {
    changeLines.push(`ステータス: ${statusLabel(before.status)} → ${statusLabel(newStatus)}`);
  }
  if ((before.due_at || null) !== dueAt) {
    const beforeDue = before.due_at ? before.due_at.replace('T', ' ') : 'なし';
    const afterDue = dueAt ? dueAt.replace('T', ' ') : 'なし';
    changeLines.push(`締切日時: ${beforeDue} → ${afterDue}`);
  }
  if ((before.start_date || null) !== newStartDate || (before.start_time || null) !== newStartTime) {
    changeLines.push(`開始日: ${formatStart(before.start_date, before.start_time)} → ${formatStart(newStartDate, newStartTime)}`);
  }
  const beforeSet = new Set(beforeAssigneeIds);
  const afterSet = new Set(assignees);
  const assigneesChanged = beforeSet.size !== afterSet.size || [...beforeSet].some((id) => !afterSet.has(id));
  if (assigneesChanged) {
    changeLines.push(`担当者: ${displayNamesFor(beforeAssigneeIds).join('、') || 'なし'} → ${displayNamesFor(assignees).join('、') || 'なし'}`);
  }

  const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  notifyTaskUpdate({ task: updatedTask, actorUserId: req.session.user.user_id, changeLines });

  res.redirect('/tasks/' + req.params.id);
});

// 添付ファイル(画像・各種ファイル)のアップロード
router.post('/tasks/:id/attachments', requireLogin, (req, res) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) {
      let message = 'アップロードに失敗しました';
      if (err.code === 'LIMIT_FILE_SIZE') message = 'ファイルサイズが大きすぎます(1ファイル15MBまで)';
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') message = '一度にアップロードできるファイル数を超えています(最大10件)';
      return res.redirect('/tasks/' + req.params.id + '?uploadError=' + encodeURIComponent(message));
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).render('error', { message: 'タスクが見つかりません', user: req.session.user });

    if (!req.files || req.files.length === 0) {
      return res.redirect('/tasks/' + req.params.id + '?uploadError=' + encodeURIComponent('この形式のファイルはアップロードできません'));
    }

    const insert = db.prepare(
      'INSERT INTO task_attachments (task_id, filename, original_name, mime_type, uploaded_by) VALUES (?, ?, ?, ?, ?)'
    );
    req.files.forEach((f) => {
      insert.run(task.id, f.filename, f.originalname, f.mimetype, req.session.user.user_id);
    });
    res.redirect('/tasks/' + req.params.id);
  });
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
  const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'タスクが見つかりません' });

  db.prepare("UPDATE tasks SET status = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, req.session.user.user_id, req.params.id);

  if (before.status !== status) {
    const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    notifyTaskUpdate({
      task: updatedTask,
      actorUserId: req.session.user.user_id,
      changeLines: [`ステータス: ${statusLabel(before.status)} → ${statusLabel(status)}`],
    });
  }

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

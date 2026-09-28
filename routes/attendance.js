const express = require('express');
const db = require('../db/connection');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { toJstParts, nowJstYearMonth } = require('../lib/jst');

const router = express.Router();

function csvField(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 勤怠ダウンロード画面（管理者のみ）
router.get('/attendance', requireLogin, requireAdmin, (req, res) => {
  const { year, month } = nowJstYearMonth();
  const defaultMonth = `${year}-${String(month).padStart(2, '0')}`;
  const members = db
    .prepare("SELECT user_id, display_name FROM users WHERE role = 'member' ORDER BY id")
    .all();
  res.render('attendance/index', { defaultMonth, members });
});

// 月・ユーザーごとの勤怠CSVダウンロード（管理者のみ）
// 日時 / 名前 / 出勤打刻 / 退勤打刻 の1日1行形式。打刻がない日は空欄
router.get('/attendance/export', requireLogin, requireAdmin, (req, res) => {
  const monthParam = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const { year: jstYear, month: jstMonth } = nowJstYearMonth();
  const [year, month] = monthParam
    ? monthParam.split('-').map(Number)
    : [jstYear, jstMonth];

  const targetUser = db.prepare('SELECT user_id, display_name FROM users WHERE user_id = ?').get(req.query.user_id);
  if (!targetUser) {
    return res.redirect('/attendance');
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const dayList = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // UTC保存のため、対象月の前後1日分を含めて広めに取得し、JST変換後に絞り込む
  const rangeStart = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
  const rangeEndDate = new Date(year, month, 1);
  const rangeEnd = `${rangeEndDate.getFullYear()}-${String(rangeEndDate.getMonth() + 1).padStart(2, '0')}-${String(rangeEndDate.getDate()).padStart(2, '0')} 23:59:59`;
  const logs = db
    .prepare(
      `SELECT * FROM attendance_logs
       WHERE user_id = ? AND datetime(logged_at) >= datetime(?, '-1 day') AND datetime(logged_at) <= datetime(?, '+1 day')
       ORDER BY logged_at ASC`
    )
    .all(targetUser.user_id, rangeStart, rangeEnd);

  // day(1-31) -> { in: 'HH:MM'|null, out: 'HH:MM'|null }
  const byDay = {};
  logs.forEach((log) => {
    const { dateStr, timeStr } = toJstParts(log.logged_at);
    const [y, m, d] = dateStr.split('-').map(Number);
    if (y !== year || m !== month) return;

    const bucket = byDay[d] || { in: null, out: null };
    if (log.type === 'in') {
      if (!bucket.in) bucket.in = timeStr; // その日最初の出勤打刻
    } else if (log.type === 'out') {
      bucket.out = timeStr; // その日最後の退勤打刻
    }
    byDay[d] = bucket;
  });

  const header = ['日時', '名前', '出勤打刻', '退勤打刻'];
  const lines = [header.map(csvField).join(',')];
  dayList.forEach((d) => {
    const bucket = byDay[d] || {};
    const dateStr = `${year}/${String(month).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
    lines.push([dateStr, '', bucket.in || '', bucket.out || ''].map(csvField).join(','));
  });

  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const filename = encodeURIComponent(
    `勤怠_${year}年${String(month).padStart(2, '0')}月_${targetUser.display_name}.csv`
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance.csv"; filename*=UTF-8''${filename}`);
  res.send(csv);
});

// 出勤・退勤の打刻（ホーム画面のボタンから呼ばれる）
router.post('/attendance/punch', requireLogin, (req, res) => {
  const user = req.session.user;

  const lastLog = db
    .prepare('SELECT * FROM attendance_logs WHERE user_id = ? ORDER BY logged_at DESC LIMIT 1')
    .get(user.user_id);

  const nextType = lastLog && lastLog.type === 'in' ? 'out' : 'in';

  db.prepare('INSERT INTO attendance_logs (user_id, type) VALUES (?, ?)').run(user.user_id, nextType);

  res.redirect('/');
});

module.exports = router;

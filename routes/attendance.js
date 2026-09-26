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
  res.render('attendance/index', { defaultMonth });
});

// 月ごとの勤怠CSVダウンロード（管理者のみ）
// 氏名 / 日にちごとの出勤・退勤時刻。打刻がない日は空欄
router.get('/attendance/export', requireLogin, requireAdmin, (req, res) => {
  const monthParam = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const { year: jstYear, month: jstMonth } = nowJstYearMonth();
  const [year, month] = monthParam
    ? monthParam.split('-').map(Number)
    : [jstYear, jstMonth];

  const daysInMonth = new Date(year, month, 0).getDate();
  const dayList = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const users = db.prepare('SELECT user_id, display_name FROM users ORDER BY id').all();

  // UTC保存のため、対象月の前後1日分を含めて広めに取得し、JST変換後に絞り込む
  const rangeStart = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
  const rangeEndDate = new Date(year, month, 1);
  const rangeEnd = `${rangeEndDate.getFullYear()}-${String(rangeEndDate.getMonth() + 1).padStart(2, '0')}-${String(rangeEndDate.getDate()).padStart(2, '0')} 23:59:59`;
  const logs = db
    .prepare(
      `SELECT * FROM attendance_logs
       WHERE datetime(logged_at) >= datetime(?, '-1 day') AND datetime(logged_at) <= datetime(?, '+1 day')
       ORDER BY logged_at ASC`
    )
    .all(rangeStart, rangeEnd);

  // user_id -> day(1-31) -> { in: 'HH:MM'|null, out: 'HH:MM'|null }
  const byUserDay = {};
  logs.forEach((log) => {
    const { dateStr, timeStr } = toJstParts(log.logged_at);
    const [y, m, d] = dateStr.split('-').map(Number);
    if (y !== year || m !== month) return;

    byUserDay[log.user_id] = byUserDay[log.user_id] || {};
    const bucket = byUserDay[log.user_id][d] || { in: null, out: null };
    if (log.type === 'in') {
      if (!bucket.in) bucket.in = timeStr; // その日最初の出勤打刻
    } else if (log.type === 'out') {
      bucket.out = timeStr; // その日最後の退勤打刻
    }
    byUserDay[log.user_id][d] = bucket;
  });

  const header = ['氏名'];
  dayList.forEach((d) => {
    header.push(`${month}/${d} 出勤`);
    header.push(`${month}/${d} 退勤`);
  });

  const lines = [header.map(csvField).join(',')];
  users.forEach((u) => {
    const row = [u.display_name];
    dayList.forEach((d) => {
      const bucket = (byUserDay[u.user_id] && byUserDay[u.user_id][d]) || {};
      row.push(bucket.in || '');
      row.push(bucket.out || '');
    });
    lines.push(row.map(csvField).join(','));
  });

  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const filename = encodeURIComponent(`勤怠_${year}-${String(month).padStart(2, '0')}.csv`);
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

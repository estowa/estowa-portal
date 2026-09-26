// イベントカレンダー（EC売上ページ下部・ホーム画面共通）で使う集計処理
const db = require('../db/connection');

// 指定した年月に少しでも重なるイベントを取得し、日ごとの配列にまとめる
// (日をまたぐイベントは範囲内の全ての日に表示される)
function eventsByDayForMonth(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const overlapping = db
    .prepare(
      `SELECT * FROM events WHERE start_date <= ? AND end_date >= ? ORDER BY start_date ASC, id ASC`
    )
    .all(end, start);

  const eventsByDay = {};
  overlapping.forEach((ev) => {
    for (let day = 1; day <= lastDay; day++) {
      const dayStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (dayStr >= ev.start_date && dayStr <= ev.end_date) {
        if (!eventsByDay[day]) eventsByDay[day] = [];
        eventsByDay[day].push(ev);
      }
    }
  });

  const firstWeekday = new Date(year, month - 1, 1).getDay();

  return { eventsByDay, lastDay, firstWeekday };
}

module.exports = { eventsByDayForMonth };

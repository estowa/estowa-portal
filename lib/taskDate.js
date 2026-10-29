// タスクカードの日時表示: 当日は「今日 時間」、翌日は「明日 時間」、それ以外は日付(+時間)。
// 日付が空なら空文字(表示しない)。時間は無ければ付けない。
// date は 'YYYY-MM-DD'、time は 'HH:MM' または空、todayStr は JST の今日 'YYYY-MM-DD'
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatWhen(date, time, todayStr) {
  if (!date) return '';
  let day = date;
  if (date === todayStr) day = '今日';
  else if (date === addDays(todayStr, 1)) day = '明日';
  return time ? `${day} ${time}` : day;
}

module.exports = { formatWhen, addDays };

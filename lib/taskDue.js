// タスクの締切の状態: 'overdue'(過ぎた) / 'soon'(24時間以内) / ''(それ以外・完了済み・締切なし)
// dueAt と nowStr は、どちらも JST の 'YYYY-MM-DDTHH:MM'
const SOON_HOURS = 24;

function dueState(dueAt, status, nowStr) {
  if (!dueAt || status === 'done') return '';
  if (dueAt < nowStr) return 'overdue';
  // 両方とも同じ時刻系(JST)の文字列なので、UTCとして読んで差を取れば時間差になる
  const diffMs = new Date(dueAt + ':00Z') - new Date(nowStr + ':00Z');
  return diffMs <= SOON_HOURS * 3600 * 1000 ? 'soon' : '';
}

module.exports = { dueState, SOON_HOURS };

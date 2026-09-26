// SQLiteのdatetime('now')はUTCで保存されるため、日本時間(JST)に変換して
// 日付・時刻を扱うための小さなヘルパー

const JST_FORMATTER = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// SQLiteの "YYYY-MM-DD HH:MM:SS"(UTC)文字列を受け取り、
// JSTでの { dateStr: 'YYYY-MM-DD', timeStr: 'HH:MM' } を返す
function toJstParts(sqliteUtcString) {
  const d = new Date(sqliteUtcString.replace(' ', 'T') + 'Z');
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    timeStr: `${parts.hour}:${parts.minute}`,
  };
}

// 現在時刻をJSTの { year, month }（月は1-12）で返す
function nowJstYearMonth() {
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month) };
}

// 現在時刻をJSTの 'YYYY-MM-DD' 文字列で返す
function nowJstDateStr() {
  const parts = Object.fromEntries(JST_FORMATTER.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = { toJstParts, nowJstYearMonth, nowJstDateStr };

// サイト保守: 状態の判定（純粋な関数。DBも時計も触らない）。
// しきい値は、ここにまとめる（運用しながら調整する）。

const LIMITS = {
  SLOW_MS: 3000, // これを超えたら「遅い」
  EXPIRY_WARN_DAYS: 30, // SSL・ドメインの期限: この日数以内で注意
  EXPIRY_URGENT_DAYS: 7, // この日数以内（期限切れ含む）で要対応
  BACKUP_STALE_DAYS: 10, // バックアップ最終日からこの日数以上で注意
  INSPECT_STALE_DAYS: 35, // 最終点検日からこの日数以上で注意
  DOWN_AFTER_FAILS: 2, // 連続でこの回数失敗したら「応答なし」
};

// 'YYYY-MM-DD' を、UTCの「日」の通し番号にする（時刻・夏時間の影響を受けない）
function dayNumber(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function daysUntil(dateStr, todayStr) {
  if (!dateStr) return null;
  return Math.round(dayNumber(dateStr) - dayNumber(todayStr));
}

function daysSince(dateStr, todayStr) {
  const d = daysUntil(dateStr, todayStr);
  return d === null ? null : -d;
}

function expiryLevel(days) {
  if (days === null) return 'none';
  if (days <= LIMITS.EXPIRY_URGENT_DAYS) return 'urgent';
  if (days <= LIMITS.EXPIRY_WARN_DAYS) return 'warn';
  return 'ok';
}

function expiryPart(label, code, dateStr, todayStr, reasons) {
  const days = daysUntil(dateStr, todayStr);
  const level = expiryLevel(days);
  if (level === 'urgent' || level === 'warn') {
    const text = days < 0 ? `${label}が期限切れです` : `${label}の期限まで あと${days}日`;
    reasons.push({ level, code, text });
  }
  return { days, level };
}

function stalePart(label, code, dateStr, todayStr, limit, reasons) {
  const days = daysSince(dateStr, todayStr);
  if (days === null) return { days: null, level: 'none' };
  if (days >= limit) {
    reasons.push({ level: 'warn', code, text: `${label}が${days}日前から更新されていません` });
    return { days, level: 'warn' };
  }
  return { days, level: 'ok' };
}

function judgeSite({ checks, sslExpires, domainExpires, lastBackup, lastInspect, todayStr }) {
  const reasons = [];
  const parts = {};
  const list = checks || [];

  // 稼働
  const recent = list.slice(0, LIMITS.DOWN_AFTER_FAILS);
  if (list.length === 0) {
    parts.uptime = 'unknown';
  } else if (recent.length >= LIMITS.DOWN_AFTER_FAILS && recent.every((c) => !c.ok)) {
    parts.uptime = 'down';
    reasons.push({ level: 'urgent', code: 'down', text: `応答がありません（${LIMITS.DOWN_AFTER_FAILS}回連続）` });
  } else if (!list[0].ok) {
    parts.uptime = 'failing'; // 1回だけの失敗は、様子を見る
  } else if (list[0].response_ms > LIMITS.SLOW_MS) {
    parts.uptime = 'slow';
    reasons.push({ level: 'warn', code: 'slow', text: `応答が遅い（${(list[0].response_ms / 1000).toFixed(1)}秒）` });
  } else {
    parts.uptime = 'ok';
  }

  parts.ssl = expiryPart('SSL証明書', 'ssl_expiry', sslExpires, todayStr, reasons);
  parts.domain = expiryPart('ドメイン', 'domain_expiry', domainExpires, todayStr, reasons);
  parts.backup = stalePart('バックアップ', 'backup_stale', lastBackup, todayStr, LIMITS.BACKUP_STALE_DAYS, reasons);
  parts.inspect = stalePart('点検', 'inspect_stale', lastInspect, todayStr, LIMITS.INSPECT_STALE_DAYS, reasons);

  reasons.sort((a, b) => (a.level === b.level ? 0 : a.level === 'urgent' ? -1 : 1));

  let level;
  if (reasons.some((r) => r.level === 'urgent')) level = 'urgent';
  else if (reasons.some((r) => r.level === 'warn')) level = 'warn';
  else if (list.length === 0) level = 'unknown';
  else level = 'ok';

  let label;
  if (level === 'urgent') label = reasons.some((r) => r.code === 'down') ? '応答なし' : '要対応';
  else if (level === 'warn') {
    if (reasons.some((r) => r.code === 'ssl_expiry' || r.code === 'domain_expiry')) label = '期限が近い';
    else if (reasons.some((r) => r.code === 'slow')) label = '遅い';
    else label = '要確認';
  } else if (level === 'ok') label = '稼働中';
  else label = '未確認';

  return { level, label, reasons, parts };
}

module.exports = { LIMITS, daysUntil, daysSince, judgeSite };

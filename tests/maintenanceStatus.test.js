const test = require('node:test');
const assert = require('node:assert');
const { LIMITS, daysUntil, daysSince, judgeSite } = require('../lib/maintenanceStatus');

const TODAY = '2026-10-15';
const okChecks = [{ ok: 1, response_ms: 400 }];
const base = (over = {}) => ({
  checks: okChecks, sslExpires: null, domainExpires: null, lastBackup: null, lastInspect: null, todayStr: TODAY, ...over,
});
const dayAfter = (n) => {
  const d = new Date(Date.UTC(2026, 9, 15) + n * 86400000);
  return d.toISOString().slice(0, 10);
};

test('日数の計算は、月またぎ・空の値でも正しい', () => {
  assert.strictEqual(daysUntil('2026-11-01', '2026-10-31'), 1);
  assert.strictEqual(daysUntil('2026-10-15', TODAY), 0);
  assert.strictEqual(daysUntil('2026-10-14', TODAY), -1);
  assert.strictEqual(daysUntil(null, TODAY), null);
  assert.strictEqual(daysSince('2026-10-05', TODAY), 10);
  assert.strictEqual(daysSince('', TODAY), null);
});

test('期限の境界: 31日=OK、30日=注意、8日=注意、7日=要対応、0日=要対応', () => {
  assert.strictEqual(judgeSite(base({ sslExpires: dayAfter(31) })).level, 'ok');
  assert.strictEqual(judgeSite(base({ sslExpires: dayAfter(30) })).level, 'warn');
  assert.strictEqual(judgeSite(base({ sslExpires: dayAfter(8) })).level, 'warn');
  assert.strictEqual(judgeSite(base({ sslExpires: dayAfter(7) })).level, 'urgent');
  assert.strictEqual(judgeSite(base({ sslExpires: dayAfter(0) })).level, 'urgent');
});

test('期限切れは「要対応」で、文言に期限切れと出る', () => {
  const r = judgeSite(base({ domainExpires: dayAfter(-1) }));
  assert.strictEqual(r.level, 'urgent');
  assert.strictEqual(r.label, '要対応');
  assert.ok(r.reasons.some((x) => x.text.includes('期限切れ')));
});

test('期限が30日以内（要対応でない）なら、ラベルは「期限が近い」', () => {
  const r = judgeSite(base({ sslExpires: dayAfter(12) }));
  assert.strictEqual(r.label, '期限が近い');
  assert.match(r.reasons[0].text, /あと12日/);
});

test('バックアップは10日以上前で注意、点検は35日以上前で注意（境界）', () => {
  assert.strictEqual(judgeSite(base({ lastBackup: dayAfter(-9) })).level, 'ok');
  assert.strictEqual(judgeSite(base({ lastBackup: dayAfter(-10) })).level, 'warn');
  assert.strictEqual(judgeSite(base({ lastInspect: dayAfter(-34) })).level, 'ok');
  assert.strictEqual(judgeSite(base({ lastInspect: dayAfter(-35) })).level, 'warn');
  assert.strictEqual(judgeSite(base({ lastBackup: dayAfter(-10) })).label, '要確認');
});

test('記録がない（バックアップ・点検・期限が空）ことは、それだけでは注意にしない', () => {
  const r = judgeSite(base());
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.label, '稼働中');
  assert.strictEqual(r.parts.backup.level, 'none');
  assert.strictEqual(r.parts.ssl.days, null);
});

test('一度も確認していないサイトは「未確認」（記録による注意があればそちらが優先）', () => {
  assert.strictEqual(judgeSite(base({ checks: [] })).label, '未確認');
  assert.strictEqual(judgeSite(base({ checks: [] })).level, 'unknown');
  assert.strictEqual(judgeSite(base({ checks: [], lastBackup: dayAfter(-20) })).level, 'warn');
});

test('2回連続で失敗＝応答なし（要対応）。1回だけの失敗は様子見', () => {
  const down = judgeSite(base({ checks: [{ ok: 0 }, { ok: 0 }, { ok: 1 }] }));
  assert.strictEqual(down.level, 'urgent');
  assert.strictEqual(down.label, '応答なし');
  assert.strictEqual(down.parts.uptime, 'down');
  const once = judgeSite(base({ checks: [{ ok: 0 }, { ok: 1, response_ms: 300 }] }));
  assert.strictEqual(once.level, 'ok');
  assert.strictEqual(once.parts.uptime, 'failing');
  const onlyOne = judgeSite(base({ checks: [{ ok: 0 }] }));
  assert.notStrictEqual(onlyOne.label, '応答なし');
});

test('応答が3秒を超えたら「遅い」（3000msちょうどは遅くない）', () => {
  assert.strictEqual(judgeSite(base({ checks: [{ ok: 1, response_ms: 3001 }] })).label, '遅い');
  assert.strictEqual(judgeSite(base({ checks: [{ ok: 1, response_ms: 3000 }] })).label, '稼働中');
  assert.strictEqual(LIMITS.SLOW_MS, 3000);
});

test('複数の理由があるとき、総合は一番重いもの。理由は重い順に並ぶ', () => {
  const r = judgeSite(base({
    checks: [{ ok: 1, response_ms: 5000 }], sslExpires: dayAfter(3), lastBackup: dayAfter(-30),
  }));
  assert.strictEqual(r.level, 'urgent');
  assert.strictEqual(r.reasons[0].level, 'urgent');
  assert.ok(r.reasons.length >= 3);
});

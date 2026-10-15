# サイト保守ダッシュボード 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理している約25のWordPressサイトの状態（稼働・SSL期限・ドメイン期限・バックアップ・点検）を、1画面で把握できる「サイト保守」画面を、ポータルに追加する。

**Architecture:** 判定・URL検証・取り込み・DB・確認処理を、それぞれ小さな `lib/` のファイルに分け（DBは引数で受け取り、`:memory:` でテストする）、`routes/maintenance.js` は `createMaintenanceRouter(db)` の工場関数にして、権限をテストできるようにする。自動確認は、外から見える情報（HTTP応答・SSL証明書・RDAP）だけを使い、認証情報は持たない。

**Tech Stack:** Node.js 24 / Express 5 / EJS / better-sqlite3 / `node:test`（`npm test`）。新しい依存パッケージは追加しない（Node標準の `http` `https` `dns` `net` と、標準の `fetch` を使う）。

**Spec:** `docs/superpowers/specs/2026-10-15-site-maintenance-dashboard-design.md`

## Global Constraints

- 返答・画面の文言・コメントは日本語。専門用語を避ける（依頼者はエンジニアではない）。
- ポータルは、サイトのログイン情報（パスワード・鍵・トークン）を、一切持たない・送らない・保存しない。
- メンバーも閲覧するため、保存するのは運用状況だけ。侵入経路・不審ファイルの内容・アカウント情報・個人情報は保存しない（画面の注意書きにも明記）。
- 管理者のみ: サイト・点検記録の追加／編集／削除、まとめて追加、「今すぐ確認」。閲覧は、ログイン済みの全員。
- 状態の判定しきい値（spec §5）: 遅い＝応答3秒超／期限（SSL・ドメイン）＝30日以内は注意・7日以内（期限切れ含む）は要対応／バックアップ＝10日以上前で注意／点検＝35日以上前で注意／応答なし＝直近2回連続で失敗。
- 自動確認（spec §6）: 6時間おき（起動1分後に1回目）・ドメイン期限は1日1回・同時3サイトまで・タイムアウト10秒・リダイレクト最大5回・User-Agent `estowa-portal-check`・本文は保存しない・履歴は1サイト200件まで・「今すぐ確認」は1サイト30秒に1回まで。内部アドレスには、アクセスしない。
- 時刻はUTCで保存し、表示で `lib/jst.js` の `formatJst` を使って日本時間にする。日付の「今日」は `nowJstDateStr()`。
- 状態バッジは、色＋アイコン＋文字（色だけに頼らない）。文字と背景は4.5:1以上。スマホ幅（640px以下）は表をカード表示にする。
- 既存のDBテーブルは変更しない。新規テーブルは `maintenance_sites` `maintenance_checks` `maintenance_logs` の3つ。
- **ファイル編集の注意**: 既存ファイルはCRLFが混在している。既存ファイルの変更は、Edit ツールで行う（Pythonでの一括置換や `sed` は使わない）。新規ファイルは Write ツールで作る。
- 作業は、`main` から切ったブランチ `site-maintenance` で行い、タスクごとにコミットする。コミットメッセージは日本語。末尾に `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` を付ける。
- 承認なしに、本番サーバーへの反映・push・外部サービスへの書き込みをしない。確認用のローカルDBに入れたダミーデータは、確認後に削除する。

## Review Focus

仕様が暗に求めているが、どのタスクのテストも直接は触れていない、利用者が困りやすい入力・状況（可能性が高い順）。各項目の「それを固定するテスト」は、担当タスクに入れてある。

1. **内部アドレス宛・内部アドレスへのリダイレクト**: `127.0.0.1`・`localhost`・`10.x`・`169.254.169.254`・`::1`・`::ffff:127.0.0.1`、および、公開サイトが内部アドレスへ転送する場合は、アクセスせず `blocked` とする（Task 4）。
2. **URLの入力ゆれ**: 空、`https://` なし、大文字、末尾スラッシュなし、`?query`・`#hash` 付き、`user:pass@` 付き、`ftp://`、`javascript:`、`localhost`（ドットなし）、全角スペース混じり。→ 正しいURLに直す、または、分かる理由で断る（Task 2）。
3. **期限の境界**: 残り30日ちょうど・31日、7日ちょうど・8日、当日（0日）、期限切れ（−1日）、月またぎ。バックアップ9日／10日、点検34日／35日。→ 仕様どおりの側に倒れる（Task 1）。
4. **空・未確認の状態**: サイトが0件、1度も確認していないサイト、全サイトが失敗、バックアップ・点検の記録がまったくないサイト。→ 画面が崩れず、案内が出る（Task 1・5）。
5. **管理者以外・未ログインの変更操作**: メンバーが、追加・編集・削除・点検記録・まとめて追加・今すぐ確認のURLへ直接アクセスしても、何も変わらず403。未ログインは、ログイン画面へ（Task 5）。

---

## ファイル構成

| ファイル | 役割 | 区分 |
|---|---|---|
| `lib/maintenanceStatus.js` | 状態の判定（純粋な関数） | 新規 |
| `lib/siteUrl.js` | URLの検証と正規化 | 新規 |
| `lib/maintenanceImport.js` | 「まとめて追加」の解析 | 新規 |
| `lib/maintenanceSchema.js` | テーブル作成（何度実行しても安全） | 新規 |
| `lib/maintenanceStore.js` | DBの読み書き・一覧の組み立て・集計 | 新規 |
| `lib/siteChecker.js` | 外からの確認（HTTP・証明書・RDAP）と内部アドレスの拒否 | 新規 |
| `lib/siteCheckRunner.js` | 全サイトの確認の実行と、定期実行 | 新規 |
| `lib/maintenanceView.js` | 画面用の小さな整形関数 | 新規 |
| `routes/maintenance.js` | 画面とフォームの処理（`createMaintenanceRouter(db, opts)`） | 新規 |
| `views/maintenance/list.ejs` `detail.ejs` `form.ejs` `bulk.ejs` `_badge.ejs` | 画面 | 新規 |
| `public/js/maintenance.js` | 絞り込み・並べ替え | 新規 |
| `public/css/style.css` | `.mt-*` と状態バッジのスタイルを末尾に追加 | 変更 |
| `views/partials/header.ejs` | サイドバーに「サイト保守」 | 変更 |
| `server.js` | ルート登録・スキーマ作成・定期確認の開始 | 変更 |
| `db/init.js` | スキーマ作成を呼ぶ | 変更 |
| `tests/maintenanceStatus.test.js` ほか | 自動テスト | 新規 |
| `CLAUDE.md` | 機能一覧に追記 | 変更 |

---

### Task 1: 状態の判定

**Files:**
- Create: `lib/maintenanceStatus.js`
- Test: `tests/maintenanceStatus.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `LIMITS`（定数オブジェクト）
  - `daysUntil(dateStr, todayStr): number | null` — `YYYY-MM-DD` 同士の日数差（`dateStr` が空なら `null`）
  - `daysSince(dateStr, todayStr): number | null`
  - `judgeSite({ checks, sslExpires, domainExpires, lastBackup, lastInspect, todayStr }): { level, label, reasons, parts }`
    - `checks`: 新しい順の `{ ok: 0|1|boolean, response_ms }` の配列
    - `level`: `'urgent' | 'warn' | 'ok' | 'unknown'`
    - `label`: `'応答なし' | '要対応' | '期限が近い' | '遅い' | '要確認' | '稼働中' | '未確認'`
    - `reasons`: `[{ level: 'urgent'|'warn', code, text }]`（重い順）
    - `parts`: `{ uptime: 'unknown'|'down'|'slow'|'failing'|'ok', ssl: {days, level}, domain: {days, level}, backup: {days, level}, inspect: {days, level} }`（`level` は `'none'|'ok'|'warn'|'urgent'`）

- [ ] **Step 1: 失敗するテストを書く**

`tests/maintenanceStatus.test.js` を新規作成:

```js
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
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/maintenanceStatus.test.js`
Expected: FAIL（`Cannot find module '../lib/maintenanceStatus'`）

- [ ] **Step 3: 実装する**

`lib/maintenanceStatus.js` を新規作成:

```js
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
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/maintenanceStatus.test.js`
Expected: PASS（10件）

- [ ] **Step 5: コミット**

```bash
git checkout -b site-maintenance
git add lib/maintenanceStatus.js tests/maintenanceStatus.test.js
git commit -m "サイト保守: 状態の判定ロジックを追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: URLの検証と「まとめて追加」の解析

**Files:**
- Create: `lib/siteUrl.js`, `lib/maintenanceImport.js`
- Test: `tests/siteUrl.test.js`, `tests/maintenanceImport.test.js`

**Interfaces:**
- Consumes: なし
- Produces:
  - `normalizeSiteUrl(input: string): string` — `http(s)://ホスト[:ポート]/パス/` の形（末尾は必ず `/`、query・hashは除く）。不正なら、日本語のメッセージの `Error` を投げる。
  - `parseBulk(text: string, existingUrls: string[]): { rows: [{ line, name, url, server_name, client_type }], errors: [{ line, text, message }] }` — `client_type` は `'own' | 'client'`。`MAX_LINES = 200`。

- [ ] **Step 1: 失敗するテストを書く**

`tests/siteUrl.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { normalizeSiteUrl } = require('../lib/siteUrl');

test('https:// がなくても補い、ホストは小文字、末尾は / にそろう', () => {
  assert.strictEqual(normalizeSiteUrl('example.com'), 'https://example.com/');
  assert.strictEqual(normalizeSiteUrl('  HTTPS://Example.COM  '), 'https://example.com/');
});

test('パスは残し、query・hashは捨てる。ポートは残す', () => {
  assert.strictEqual(normalizeSiteUrl('https://cityhall-koumei.com/site'), 'https://cityhall-koumei.com/site/');
  assert.strictEqual(normalizeSiteUrl('http://example.com/Path/?a=1#top'), 'http://example.com/Path/');
  assert.strictEqual(normalizeSiteUrl('example.com:8443/x'), 'https://example.com:8443/x/');
});

test('IDやパスワード付きのURLは断る（認証情報を保存しない）', () => {
  assert.throws(() => normalizeSiteUrl('https://user:pass@example.com/'), /パスワード/);
  assert.throws(() => normalizeSiteUrl('https://user@example.com/'), /パスワード/);
});

test('http・https以外、空、ドットのないホスト、壊れた形は断る', () => {
  ['', '   ', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'localhost', 'http://', 'https://exa mple.com'].forEach(
    (v) => assert.throws(() => normalizeSiteUrl(v), Error, `断るはず: ${JSON.stringify(v)}`)
  );
});

test('全角スペースが混じっても、前後は取り除く', () => {
  assert.strictEqual(normalizeSiteUrl('\u3000example.com\u3000'), 'https://example.com/');
});
```

`tests/maintenanceImport.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { parseBulk } = require('../lib/maintenanceImport');

test('1行1サイト。カンマ・タブどちらの区切りでも読める。種別は省略すると受託', () => {
  const r = parseBulk('estowa.jp,estowa.jp,ss256422,自社\nNAO\tnao-asobiba.com\tss170071\n', []);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.rows.map((x) => [x.name, x.url, x.server_name, x.client_type]), [
    ['estowa.jp', 'https://estowa.jp/', 'ss256422', 'own'],
    ['NAO', 'https://nao-asobiba.com/', 'ss170071', 'client'],
  ]);
});

test('空行と # で始まる行は無視する。行番号は元の行を指す', () => {
  const r = parseBulk('# メモ\n\nA,a.example.com\nB,\n', []);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].line, 4);
});

test('URL不正・種別不正・重複（取り込み内／登録済み）は、行ごとにエラーにして、他の行は通す', () => {
  const r = parseBulk(
    ['A,a.example.com', 'B,ftp://b.example.com', 'C,c.example.com,s1,謎', 'D,a.example.com', 'E,e.example.com'].join('\n'),
    ['https://e.example.com/']
  );
  assert.deepStrictEqual(r.rows.map((x) => x.name), ['A']);
  assert.deepStrictEqual(r.errors.map((e) => e.line), [2, 3, 4, 5]);
  assert.match(r.errors[3].message, /登録/);
});

test('全角スペースや全角カンマ以外の混在でも崩れない。名前だけの行はエラー', () => {
  const r = parseBulk('名前だけ\n　A　,　a.example.com　', []);
  assert.strictEqual(r.rows[0].name, 'A');
  assert.strictEqual(r.errors[0].line, 1);
});

test('一度に追加できるのは200件まで。超えた分は、1件のエラーにまとめる', () => {
  const text = Array.from({ length: 205 }, (_, i) => `S${i},s${i}.example.com`).join('\n');
  const r = parseBulk(text, []);
  assert.strictEqual(r.rows.length, 200);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /200件/);
});

test('空の入力は、行もエラーもなし', () => {
  assert.deepStrictEqual(parseBulk('', []), { rows: [], errors: [] });
  assert.deepStrictEqual(parseBulk(null, []), { rows: [], errors: [] });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/siteUrl.test.js tests/maintenanceImport.test.js`
Expected: FAIL（モジュールが見つからない）

- [ ] **Step 3: 実装する**

`lib/siteUrl.js`:

```js
// サイトのURLを検証して、同じサイトが同じ文字列になるようにそろえる。
// 認証情報つきのURL・http(s)以外・ホスト名がおかしいものは断る。

function normalizeSiteUrl(input) {
  let s = String(input || '').replace(/\u3000/g, ' ').trim();
  if (!s) throw new Error('URLを入力してください');

  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new Error('URLは http:// か https:// で始めてください');
  if (!scheme) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch (e) {
    throw new Error('URLの形式が正しくありません');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URLは http:// か https:// で始めてください');
  if (u.username || u.password) throw new Error('URLにIDやパスワードは含められません');
  if (!u.hostname || !u.hostname.includes('.')) throw new Error('URLの形式が正しくありません');

  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}/`;
}

module.exports = { normalizeSiteUrl };
```

`lib/maintenanceImport.js`:

```js
// 「まとめて追加」の入力（1行1サイト）を読む。
// 形式: 名前,URL,サーバー名,種別（カンマかタブ区切り。サーバー名・種別は省略可。種別は「自社」か「受託」）

const { normalizeSiteUrl } = require('./siteUrl');

const MAX_LINES = 200;
const TYPE_MAP = { 自社: 'own', own: 'own', 受託: 'client', client: 'client' };

function parseBulk(text, existingUrls = []) {
  const existing = new Set(existingUrls);
  const seen = new Set();
  const rows = [];
  const errors = [];
  let counted = 0;

  String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/\u3000/g, ' ').trim();
      if (!line || line.startsWith('#')) return;

      counted += 1;
      if (counted > MAX_LINES) {
        if (counted === MAX_LINES + 1) errors.push({ line: i + 1, text: '', message: `一度に追加できるのは${MAX_LINES}件までです` });
        return;
      }

      const [name, urlRaw, server = '', typeRaw = ''] = line.split(/\t|,/).map((s) => s.trim());
      const fail = (message) => errors.push({ line: i + 1, text: raw, message });

      if (!name || !urlRaw) return fail('名前とURLを入れてください');
      let url;
      try {
        url = normalizeSiteUrl(urlRaw);
      } catch (e) {
        return fail(e.message);
      }
      if (typeRaw && !TYPE_MAP[typeRaw]) return fail('種別は「自社」か「受託」で入れてください');
      if (existing.has(url) || seen.has(url)) return fail('すでに登録されているURLです');

      seen.add(url);
      rows.push({ line: i + 1, name, url, server_name: server, client_type: TYPE_MAP[typeRaw] || 'client' });
    });

  return { rows, errors };
}

module.exports = { parseBulk, MAX_LINES };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/siteUrl.test.js tests/maintenanceImport.test.js`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add lib/siteUrl.js lib/maintenanceImport.js tests/siteUrl.test.js tests/maintenanceImport.test.js
git commit -m "サイト保守: URLの検証と、まとめて追加の解析を追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: DB（テーブルと読み書き）

**Files:**
- Create: `lib/maintenanceSchema.js`, `lib/maintenanceStore.js`
- Modify: `db/init.js`（`ensureChatSchema` の呼び出しの隣）
- Test: `tests/maintenanceStore.test.js`

**Interfaces:**
- Consumes: `normalizeSiteUrl`（Task 2）、`judgeSite`（Task 1）
- Produces（`db` は better-sqlite3 のDB。すべて第1引数）:
  - `ensureMaintenanceSchema(db)`
  - `LOG_KINDS = ['点検','更新','バックアップ','対応','その他']`、`HISTORY_LIMIT = 200`
  - `cleanSiteFields(f): { name, url, server_name, client_type, is_wordpress, domain_expires_manual, memo }`（不正なら `Error`）
  - `addSite(db, fields & { created_by }): number`（新しいid。URL重複は `Error('すでに登録されているURLです')`）
  - `updateSite(db, id, fields): void` ／ `deleteSite(db, id): void`（関連する確認履歴・点検記録も削除）
  - `getSite(db, id): row | undefined` ／ `listSites(db): row[]`（名前順）
  - `recordCheck(db, siteId, { ok, http_status, response_ms, ssl_expires, error }): void`（200件を超えた古い履歴を削除）
  - `latestChecks(db, siteId, n): row[]`（新しい順） ／ `listChecks(db, siteId, limit = 30): row[]`
  - `setDomainAuto(db, siteId, dateOrNull, checkedAtIso): void`（`dateOrNull` が `null` のときは、期限の値を変えず、確認日時だけ更新）
  - `addLog(db, siteId, { log_date, kind, note, created_by }): number` ／ `deleteLog(db, logId, siteId): void` ／ `listLogs(db, siteId): row[]`（新しい順）
  - `buildRow(db, site, todayStr): { site, status, lastBackup, lastInspect, sslExpires, domainExpires, lastCheckedAt }`
  - `overview(db, todayStr): row[]` ／ `getRow(db, id, todayStr): row | null`
  - `sortOverview(rows): rows`（要対応→注意→未確認→稼働中、同順位は名前順）
  - `summarize(rows, nowMs): { total, urgent, expiring, lastCheckedAt, stale }`（`stale`: サイトがあり、最終確認が24時間以上前、または一度もない）

- [ ] **Step 1: 失敗するテストを書く**

`tests/maintenanceStore.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');

function makeDb() {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  return db;
}
const site = (over = {}) => ({ name: 'テスト', url: 'example.com', server_name: 's1', client_type: 'client', is_wordpress: true, created_by: 'admin', ...over });

test('スキーマは何度実行しても安全', () => {
  const db = makeDb();
  ensureMaintenanceSchema(db);
  assert.strictEqual(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'maintenance_%'").get().n >= 3, true);
});

test('サイトの追加: URLは正規化され、同じURLの二重登録は断る', () => {
  const db = makeDb();
  const id = store.addSite(db, site({ url: 'HTTPS://Example.com' }));
  assert.strictEqual(store.getSite(db, id).url, 'https://example.com/');
  assert.throws(() => store.addSite(db, site({ url: 'example.com/' })), /すでに登録/);
});

test('入力の検証: 名前が空・長すぎる／種別・日付・メモが不正', () => {
  assert.throws(() => store.cleanSiteFields(site({ name: '  ' })), /名前/);
  assert.throws(() => store.cleanSiteFields(site({ name: 'あ'.repeat(101) })), /名前/);
  assert.throws(() => store.cleanSiteFields(site({ client_type: 'x' })), /種別/);
  assert.throws(() => store.cleanSiteFields(site({ domain_expires_manual: '2026/13/40' })), /日付/);
  assert.throws(() => store.cleanSiteFields(site({ memo: 'あ'.repeat(501) })), /メモ/);
  const ok = store.cleanSiteFields(site({ domain_expires_manual: '', memo: '  メモ  ', is_wordpress: false }));
  assert.strictEqual(ok.domain_expires_manual, null);
  assert.strictEqual(ok.memo, 'メモ');
  assert.strictEqual(ok.is_wordpress, 0);
});

test('サイトを消すと、確認履歴と点検記録も消える', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  store.recordCheck(db, id, { ok: 1, http_status: 200, response_ms: 100, ssl_expires: null, error: null });
  store.addLog(db, id, { log_date: '2026-10-13', kind: '点検', note: '確認', created_by: 'admin' });
  store.deleteSite(db, id);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks').get().n, 0);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_logs').get().n, 0);
});

test('確認履歴は新しい順で、1サイト200件を超えた古いものから消える', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  for (let i = 0; i < 205; i++) store.recordCheck(db, id, { ok: 1, http_status: 200, response_ms: i, ssl_expires: null, error: null });
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks WHERE site_id=?').get(id).n, store.HISTORY_LIMIT);
  assert.strictEqual(store.latestChecks(db, id, 1)[0].response_ms, 204);
  assert.strictEqual(store.listChecks(db, id).length, 30);
});

test('点検記録: 種類・日付を検証し、バックアップ・点検の最新日が一覧の行に出る', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  assert.throws(() => store.addLog(db, id, { log_date: '2026-10-13', kind: '謎', note: '', created_by: 'a' }), /種類/);
  assert.throws(() => store.addLog(db, id, { log_date: 'きのう', kind: '点検', note: '', created_by: 'a' }), /日付/);
  assert.throws(() => store.addLog(db, id, { log_date: '2026-10-13', kind: '点検', note: 'あ'.repeat(1001), created_by: 'a' }), /内容/);
  store.addLog(db, id, { log_date: '2026-10-01', kind: 'バックアップ', note: '', created_by: 'a' });
  store.addLog(db, id, { log_date: '2026-10-12', kind: 'バックアップ', note: '', created_by: 'a' });
  store.addLog(db, id, { log_date: '2026-10-13', kind: '点検', note: '', created_by: 'a' });
  const row = store.getRow(db, id, '2026-10-15');
  assert.strictEqual(row.lastBackup, '2026-10-12');
  assert.strictEqual(row.lastInspect, '2026-10-13');
  assert.strictEqual(store.listLogs(db, id)[0].log_date, '2026-10-13');
});

test('ドメイン期限は、手入力が優先。自動取得に失敗（null）しても、前の値を消さない', () => {
  const db = makeDb();
  const id = store.addSite(db, site());
  store.setDomainAuto(db, id, '2027-01-01', '2026-10-15T00:00:00Z');
  store.setDomainAuto(db, id, null, '2026-10-16T00:00:00Z');
  assert.strictEqual(store.getSite(db, id).domain_expires_auto, '2027-01-01');
  assert.strictEqual(store.getRow(db, id, '2026-10-15').domainExpires, '2027-01-01');
  store.updateSite(db, id, site({ domain_expires_manual: '2026-12-01' }));
  assert.strictEqual(store.getRow(db, id, '2026-10-15').domainExpires, '2026-12-01');
});

test('一覧: 状態が重い順に並ぶ。0件でも動く。一度も確認していないサイトは「未確認」', () => {
  const db = makeDb();
  assert.deepStrictEqual(store.overview(db, '2026-10-15'), []);
  const a = store.addSite(db, site({ name: 'A', url: 'a.example.com' }));
  const b = store.addSite(db, site({ name: 'B', url: 'b.example.com' }));
  const c = store.addSite(db, site({ name: 'C', url: 'c.example.com' }));
  store.recordCheck(db, b, { ok: 1, http_status: 200, response_ms: 100, ssl_expires: null, error: null });
  store.recordCheck(db, c, { ok: 0, http_status: null, response_ms: 10000, ssl_expires: null, error: 'timeout' });
  store.recordCheck(db, c, { ok: 0, http_status: null, response_ms: 10000, ssl_expires: null, error: 'timeout' });
  const rows = store.sortOverview(store.overview(db, '2026-10-15'));
  assert.deepStrictEqual(rows.map((r) => [r.site.name, r.status.label]), [['C', '応答なし'], ['A', '未確認'], ['B', '稼働中']]);
  assert.ok(a && b);
});

test('集計: 要対応・期限が近い・最終確認・24時間以上更新なしの注意', () => {
  const db = makeDb();
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.strictEqual(store.summarize([], now).stale, false);
  const id = store.addSite(db, site());
  store.updateSite(db, id, site({ domain_expires_manual: '2026-10-25' }));
  let s = store.summarize(store.overview(db, '2026-10-15'), now);
  assert.deepStrictEqual([s.total, s.urgent, s.expiring, s.lastCheckedAt, s.stale], [1, 0, 1, null, true]);
  db.prepare("INSERT INTO maintenance_checks (site_id, checked_at, ok, http_status, response_ms) VALUES (?, '2026-10-15 11:00:00', 1, 200, 100)").run(id);
  s = store.summarize(store.overview(db, '2026-10-15'), now);
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.lastCheckedAt, '2026-10-15 11:00:00');
  assert.strictEqual(store.summarize(store.overview(db, '2026-10-15'), now + 25 * 3600 * 1000).stale, true);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/maintenanceStore.test.js`
Expected: FAIL（モジュールが見つからない）

- [ ] **Step 3: 実装する**

`lib/maintenanceSchema.js`:

```js
// サイト保守のテーブルを作る（何度実行しても安全）。
// 既存のテーブルは変更しない。
function ensureMaintenanceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      server_name TEXT,
      client_type TEXT NOT NULL DEFAULT 'client',   -- own(自社) / client(受託)
      is_wordpress INTEGER NOT NULL DEFAULT 1,
      domain_expires_manual TEXT,                   -- YYYY-MM-DD(手入力。自動取得より優先)
      domain_expires_auto TEXT,                     -- YYYY-MM-DD(RDAPで取得)
      domain_checked_at TEXT,                       -- 最後にRDAPを確認した日時(UTC)
      memo TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS maintenance_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      ok INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      response_ms INTEGER,
      ssl_expires TEXT,                             -- YYYY-MM-DD
      error TEXT                                    -- timeout / dns / blocked などの短い分類だけ
    );
    CREATE INDEX IF NOT EXISTS idx_mt_checks_site ON maintenance_checks(site_id, id);
    CREATE TABLE IF NOT EXISTS maintenance_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      log_date TEXT NOT NULL,                       -- YYYY-MM-DD
      kind TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mt_logs_site ON maintenance_logs(site_id, log_date);
  `);
}

module.exports = { ensureMaintenanceSchema };
```

`lib/maintenanceStore.js`:

```js
// サイト保守のDB読み書き。dbは引数で受け取る（テストでは :memory: を使う）。
// 外部キーの連動削除は有効になっていないため、子の行は deleteSite で明示的に消す。

const { normalizeSiteUrl } = require('./siteUrl');
const { judgeSite } = require('./maintenanceStatus');

const LOG_KINDS = ['点検', '更新', 'バックアップ', '対応', 'その他'];
const HISTORY_LIMIT = 200;
const STALE_CHECK_MS = 24 * 3600 * 1000;

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const utcMs = (sqlite) => Date.parse(String(sqlite).replace(' ', 'T') + 'Z');

function cleanSiteFields(f) {
  const name = String(f.name || '').trim();
  if (!name || name.length > 100) throw new Error('名前は1〜100文字で入力してください');
  const url = normalizeSiteUrl(f.url);
  const server_name = String(f.server_name || '').trim().slice(0, 50);
  const client_type = f.client_type === undefined || f.client_type === '' ? 'client' : f.client_type;
  if (client_type !== 'own' && client_type !== 'client') throw new Error('種別は「自社」か「受託」を選んでください');
  const manual = String(f.domain_expires_manual || '').trim();
  if (manual && !isDate(manual)) throw new Error('ドメイン期限は、日付（年-月-日）で入力してください');
  const memo = String(f.memo || '').trim();
  if (memo.length > 500) throw new Error('メモは500文字以内にしてください');
  return {
    name, url, server_name, client_type,
    is_wordpress: f.is_wordpress === false || f.is_wordpress === 0 || f.is_wordpress === '0' ? 0 : 1,
    domain_expires_manual: manual || null,
    memo,
  };
}

function addSite(db, fields) {
  const f = cleanSiteFields(fields);
  try {
    const r = db.prepare(
      `INSERT INTO maintenance_sites (name, url, server_name, client_type, is_wordpress, domain_expires_manual, memo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.name, f.url, f.server_name, f.client_type, f.is_wordpress, f.domain_expires_manual, f.memo, fields.created_by || null);
    return Number(r.lastInsertRowid);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new Error('すでに登録されているURLです');
    throw e;
  }
}

function updateSite(db, id, fields) {
  const f = cleanSiteFields(fields);
  try {
    db.prepare(
      `UPDATE maintenance_sites SET name=?, url=?, server_name=?, client_type=?, is_wordpress=?, domain_expires_manual=?, memo=?,
       updated_at=datetime('now') WHERE id=?`
    ).run(f.name, f.url, f.server_name, f.client_type, f.is_wordpress, f.domain_expires_manual, f.memo, id);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw new Error('すでに登録されているURLです');
    throw e;
  }
}

function deleteSite(db, id) {
  db.transaction(() => {
    db.prepare('DELETE FROM maintenance_checks WHERE site_id=?').run(id);
    db.prepare('DELETE FROM maintenance_logs WHERE site_id=?').run(id);
    db.prepare('DELETE FROM maintenance_sites WHERE id=?').run(id);
  })();
}

const getSite = (db, id) => db.prepare('SELECT * FROM maintenance_sites WHERE id=?').get(id);
const listSites = (db) => db.prepare('SELECT * FROM maintenance_sites ORDER BY name COLLATE NOCASE, id').all();

function recordCheck(db, siteId, r) {
  db.transaction(() => {
    db.prepare(
      'INSERT INTO maintenance_checks (site_id, ok, http_status, response_ms, ssl_expires, error) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(siteId, r.ok ? 1 : 0, r.http_status ?? null, r.response_ms ?? null, r.ssl_expires ?? null, r.error ?? null);
    db.prepare(
      `DELETE FROM maintenance_checks WHERE site_id=? AND id NOT IN
       (SELECT id FROM maintenance_checks WHERE site_id=? ORDER BY id DESC LIMIT ${HISTORY_LIMIT})`
    ).run(siteId, siteId);
  })();
}

const latestChecks = (db, siteId, n) =>
  db.prepare('SELECT * FROM maintenance_checks WHERE site_id=? ORDER BY id DESC LIMIT ?').all(siteId, n);
const listChecks = (db, siteId, limit = 30) => latestChecks(db, siteId, limit);

function setDomainAuto(db, siteId, dateOrNull, checkedAtIso) {
  const checkedAt = String(checkedAtIso).replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
  if (dateOrNull) {
    db.prepare('UPDATE maintenance_sites SET domain_expires_auto=?, domain_checked_at=? WHERE id=?').run(dateOrNull, checkedAt, siteId);
  } else {
    db.prepare('UPDATE maintenance_sites SET domain_checked_at=? WHERE id=?').run(checkedAt, siteId);
  }
}

function addLog(db, siteId, l) {
  if (!LOG_KINDS.includes(l.kind)) throw new Error('種類を選んでください');
  if (!isDate(String(l.log_date || ''))) throw new Error('日付は、年-月-日の形で入力してください');
  const note = String(l.note || '').trim();
  if (note.length > 1000) throw new Error('内容は1000文字以内にしてください');
  const r = db.prepare('INSERT INTO maintenance_logs (site_id, log_date, kind, note, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(siteId, l.log_date, l.kind, note, l.created_by || null);
  return Number(r.lastInsertRowid);
}

// 別のサイトの記録を消さないよう、site_id も条件に含める
const deleteLog = (db, logId, siteId) =>
  db.prepare('DELETE FROM maintenance_logs WHERE id=? AND site_id=?').run(logId, siteId);
const listLogs = (db, siteId) =>
  db.prepare('SELECT * FROM maintenance_logs WHERE site_id=? ORDER BY log_date DESC, id DESC').all(siteId);

const lastLogDate = (db, siteId, kind) =>
  db.prepare('SELECT MAX(log_date) d FROM maintenance_logs WHERE site_id=? AND kind=?').get(siteId, kind).d || null;

function buildRow(db, site, todayStr) {
  const checks = latestChecks(db, site.id, 3);
  const lastBackup = lastLogDate(db, site.id, 'バックアップ');
  const lastInspect = lastLogDate(db, site.id, '点検');
  const sslExpires = (checks.find((c) => c.ssl_expires) || {}).ssl_expires || null;
  const domainExpires = site.domain_expires_manual || site.domain_expires_auto || null;
  const status = judgeSite({ checks, sslExpires, domainExpires, lastBackup, lastInspect, todayStr });
  return { site, status, lastBackup, lastInspect, sslExpires, domainExpires, lastCheckedAt: checks[0] ? checks[0].checked_at : null };
}

const overview = (db, todayStr) => listSites(db).map((s) => buildRow(db, s, todayStr));
function getRow(db, id, todayStr) {
  const site = getSite(db, id);
  return site ? buildRow(db, site, todayStr) : null;
}

const RANK = { urgent: 0, warn: 1, unknown: 2, ok: 3 };
function sortOverview(rows) {
  return [...rows].sort((a, b) =>
    (RANK[a.status.level] - RANK[b.status.level]) || a.site.name.localeCompare(b.site.name, 'ja'));
}

const isExpiring = (st) => ['ssl', 'domain'].some((k) => ['warn', 'urgent'].includes(st.parts[k].level));

function summarize(rows, nowMs) {
  const times = rows.map((r) => r.lastCheckedAt).filter(Boolean).sort();
  const lastCheckedAt = times.length ? times[times.length - 1] : null;
  const stale = rows.length > 0 && (!lastCheckedAt || nowMs - utcMs(lastCheckedAt) > STALE_CHECK_MS);
  return {
    total: rows.length,
    urgent: rows.filter((r) => r.status.level === 'urgent').length,
    expiring: rows.filter((r) => isExpiring(r.status)).length,
    lastCheckedAt,
    stale,
  };
}

module.exports = {
  LOG_KINDS, HISTORY_LIMIT, cleanSiteFields, addSite, updateSite, deleteSite, getSite, listSites,
  recordCheck, latestChecks, listChecks, setDomainAuto, addLog, deleteLog, listLogs,
  buildRow, overview, getRow, sortOverview, summarize, isExpiring,
};
```

`db/init.js` を Edit で変更: 7行目付近の `const { ensureChatSchema } = require('../lib/chatSchema');` の次の行に追加:

```js
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
```

さらに、`ensureChatSchema(db);` が呼ばれている行（`grep -n "ensureChatSchema(" db/init.js` で確認）の次の行に追加:

```js
ensureMaintenanceSchema(db);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/maintenanceStore.test.js` → PASS
Run: `node db/init.js` → エラーなく完了し、`node -e "const db=require('./db/connection');console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE name LIKE 'maintenance_%'\").all())"` に3つのテーブルが出ること。

- [ ] **Step 5: コミット**

```bash
git add lib/maintenanceSchema.js lib/maintenanceStore.js db/init.js tests/maintenanceStore.test.js
git commit -m "サイト保守: テーブルとDBの読み書きを追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 外からの確認（HTTP・証明書・RDAP）と内部アドレスの拒否

**Files:**
- Create: `lib/siteChecker.js`
- Test: `tests/siteChecker.test.js`

**Interfaces:**
- Consumes: なし（Node標準のみ）
- Produces:
  - `isBlockedAddress(addr: string): boolean` — 内部・予約アドレスなら `true`（不明な形式も `true`）
  - `certExpiryToDate(validTo: string): string | null` — `YYYY-MM-DD`（UTC）
  - `requestOnce(urlStr, { timeoutMs, allowPrivate }): Promise<{ status, location, ms, sslExpires }>`（テストでの差し替え用に公開）
  - `checkSite(url, { timeoutMs = 10000, maxRedirects = 5, allowPrivate = false, requestFn = requestOnce }): Promise<{ ok: boolean, http_status: number|null, response_ms: number, ssl_expires: string|null, error: string|null }>`
    - `error`: `null | 'blocked' | 'timeout' | 'dns' | 'tls' | 'connect' | 'too_many_redirects' | 'other'`
    - `allowPrivate` は**テスト専用**。本番のコードは、決して渡さない。
  - `registrableDomain(hostname): string`
  - `fetchDomainExpiry(hostname, { fetchFn = fetch, timeoutMs = 10000 }): Promise<string | null>`

- [ ] **Step 1: 失敗するテストを書く**

`tests/siteChecker.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  isBlockedAddress, certExpiryToDate, requestOnce, checkSite, registrableDomain, fetchDomainExpiry,
} = require('../lib/siteChecker');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

test('内部・予約アドレスは止める（IPv4・IPv6・IPv4射影・メタデータ用）', () => {
  ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0',
    '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '0:0:0:0:0:0:0:1', 'abc', ''].forEach((a) => assert.strictEqual(isBlockedAddress(a), true, `止めるはず: ${a}`));
});

test('公開アドレスは止めない（境界の隣も）', () => {
  ['8.8.8.8', '172.15.0.1', '172.32.0.1', '11.0.0.1', '1.1.1.1', '2606:4700:4700::1111'].forEach(
    (a) => assert.strictEqual(isBlockedAddress(a), false, `通すはず: ${a}`)
  );
});

test('標準では、127.0.0.1・localhost・IP直指定の内部アドレスへ接続しない', async () => {
  const { server, url } = await serve((req, res) => res.end('ok'));
  try {
    for (const u of [url, url.replace('127.0.0.1', 'localhost'), 'http://169.254.169.254/latest/', 'http://[::1]:80/']) {
      const r = await checkSite(u, { timeoutMs: 2000 });
      assert.strictEqual(r.ok, false, u);
      assert.strictEqual(r.error, 'blocked', u);
    }
  } finally { server.close(); }
});

test('公開サイトが内部アドレスへ転送しても、転送先には接続しない', async () => {
  const fakePublicHop = (u, o) => (u.startsWith('https://public.example/')
    ? Promise.resolve({ status: 302, location: 'http://169.254.169.254/latest/meta-data', ms: 1, sslExpires: null })
    : requestOnce(u, o));
  const r = await checkSite('https://public.example/', { requestFn: fakePublicHop });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'blocked');
});

test('200は成功。ステータスと応答時間が入る', async () => {
  const { server, url } = await serve((req, res) => { res.statusCode = 200; res.end('hello'); });
  try {
    const r = await checkSite(url, { allowPrivate: true });
    assert.deepStrictEqual([r.ok, r.http_status, r.error], [true, 200, null]);
    assert.ok(r.response_ms >= 0);
  } finally { server.close(); }
});

test('500・404は失敗（ステータスは記録する）', async () => {
  const { server, url } = await serve((req, res) => { res.statusCode = req.url === '/x' ? 404 : 500; res.end(); });
  try {
    const a = await checkSite(url, { allowPrivate: true });
    assert.deepStrictEqual([a.ok, a.http_status], [false, 500]);
    const b = await checkSite(url + 'x', { allowPrivate: true });
    assert.deepStrictEqual([b.ok, b.http_status], [false, 404]);
  } finally { server.close(); }
});

test('転送（302）は、たどって最終結果を返す。転送が多すぎると失敗', async () => {
  const { server, url } = await serve((req, res) => {
    if (req.url === '/') { res.statusCode = 302; res.setHeader('Location', '/final'); return res.end(); }
    if (req.url === '/loop') { res.statusCode = 302; res.setHeader('Location', '/loop'); return res.end(); }
    res.statusCode = 200; res.end('done');
  });
  try {
    const ok = await checkSite(url, { allowPrivate: true });
    assert.deepStrictEqual([ok.ok, ok.http_status], [true, 200]);
    const loop = await checkSite(url + 'loop', { allowPrivate: true });
    assert.deepStrictEqual([loop.ok, loop.error], [false, 'too_many_redirects']);
  } finally { server.close(); }
});

test('応答が遅すぎると timeout。閉じているポートは connect', async () => {
  const { server, url } = await serve((req, res) => setTimeout(() => res.end('late'), 1500));
  try {
    const t = await checkSite(url, { allowPrivate: true, timeoutMs: 200 });
    assert.deepStrictEqual([t.ok, t.error], [false, 'timeout']);
  } finally { server.close(); }
  const c = await checkSite(url, { allowPrivate: true, timeoutMs: 2000 });
  assert.deepStrictEqual([c.ok, c.error], [false, 'connect']);
});

test('http・https以外への転送は止める', async () => {
  const hop = () => Promise.resolve({ status: 302, location: 'ftp://example.com/x', ms: 1, sslExpires: null });
  const r = await checkSite('https://public.example/', { requestFn: hop });
  assert.deepStrictEqual([r.ok, r.error], [false, 'blocked']);
});

test('証明書の期限は YYYY-MM-DD(UTC)にする。壊れた値は null', () => {
  assert.strictEqual(certExpiryToDate('Dec 31 23:59:59 2026 GMT'), '2026-12-31');
  assert.strictEqual(certExpiryToDate('nonsense'), null);
  assert.strictEqual(certExpiryToDate(undefined), null);
});

test('ドメイン名の切り出し: 通常は末尾2つ、co.jp などは3つ', () => {
  assert.strictEqual(registrableDomain('housing.nao-asobiba.com'), 'nao-asobiba.com');
  assert.strictEqual(registrableDomain('estowa.jp'), 'estowa.jp');
  assert.strictEqual(registrableDomain('www.example.co.jp'), 'example.co.jp');
  assert.strictEqual(registrableDomain('example.or.jp'), 'example.or.jp');
});

test('ドメイン期限（RDAP）: expiration の日付を取る。失敗・形式違いは null', async () => {
  const good = async () => ({ ok: true, json: async () => ({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-31T14:59:59Z' }] }) });
  assert.strictEqual(await fetchDomainExpiry('www.example.com', { fetchFn: good }), '2027-03-31');
  assert.strictEqual(await fetchDomainExpiry('example.com', { fetchFn: async () => ({ ok: false }) }), null);
  assert.strictEqual(await fetchDomainExpiry('example.com', { fetchFn: async () => { throw new Error('net'); } }), null);
  assert.strictEqual(await fetchDomainExpiry('example.com', { fetchFn: async () => ({ ok: true, json: async () => ({}) }) }), null);
  let called = 0;
  await fetchDomainExpiry('bad host!.com', { fetchFn: async () => { called += 1; return { ok: false }; } });
  assert.strictEqual(called, 0);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/siteChecker.test.js`
Expected: FAIL（モジュールが見つからない）

- [ ] **Step 3: 実装する**

`lib/siteChecker.js`:

```js
// サイトを「外から」確認する。ログインはしない。認証情報は持たない・送らない。
// 内部アドレス（自分のサーバー内・社内ネットワーク・クラウドの管理用アドレス）には接続しない。

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const USER_AGENT = 'estowa-portal-check';

// ---- 内部アドレスの判定 ----
const blocked = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv4'));
[['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]].forEach(([a, p]) => blocked.addSubnet(a, p, 'ipv6'));

function isBlockedAddress(addr) {
  const a = String(addr || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return blocked.check(a, 'ipv4');
  if (net.isIPv6(a)) return blocked.check(a, 'ipv6');
  return true; // 不明な形式は、止める
}

// 名前の解決結果に、内部アドレスが1つでもあれば、接続しない（DNSを使ったすり替え対策）
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.some((x) => isBlockedAddress(x.address))) {
      return callback(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function certExpiryToDate(validTo) {
  const d = new Date(validTo);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// 1回分のアクセス。本文は読まずに捨てる。
function requestOnce(urlStr, { timeoutMs = 10000, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(Object.assign(new Error('unsupported protocol'), { code: 'EBLOCKED' }));
    }
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(bare) && isBlockedAddress(bare)) {
      return reject(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const options = {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      agent: false,
      ...(allowPrivate ? {} : { lookup: safeLookup }),
    };
    let finished = false;
    const done = (fn, value) => { if (!finished) { finished = true; clearTimeout(timer); fn(value); } };
    const req = lib.request(u, options, (res) => {
      let sslExpires = null;
      if (u.protocol === 'https:' && res.socket && typeof res.socket.getPeerCertificate === 'function') {
        const cert = res.socket.getPeerCertificate();
        sslExpires = certExpiryToDate(cert && cert.valid_to);
      }
      const result = { status: res.statusCode, location: res.headers.location, ms: Date.now() - started, sslExpires };
      res.destroy();
      done(resolve, result);
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

function classifyError(e) {
  const code = e && e.code;
  if (code === 'EBLOCKED') return 'blocked';
  if (code === 'ETIMEDOUT' || (e && /timeout/i.test(e.message))) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NODATA') return 'dns';
  if (/CERT|SSL|TLS|HOSTNAME|ERR_TLS/i.test(String(code)) || /certificate|tls|ssl/i.test((e && e.message) || '')) return 'tls';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return 'connect';
  return 'other';
}

async function checkSite(url, opts = {}) {
  const { timeoutMs = 10000, maxRedirects = 5, allowPrivate = false, requestFn = requestOnce } = opts;
  const started = Date.now();
  const originalHost = new URL(url).hostname;
  let current = url;
  let sslExpires = null;
  const fail = (error, status = null) => ({
    ok: false, http_status: status, response_ms: Date.now() - started, ssl_expires: sslExpires, error,
  });
  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const r = await requestFn(current, { timeoutMs, allowPrivate });
      if (r.sslExpires && new URL(current).hostname === originalHost) sslExpires = r.sslExpires;
      if (r.status >= 300 && r.status < 400 && r.location) {
        current = new URL(r.location, current).toString();
        continue;
      }
      return {
        ok: r.status >= 200 && r.status < 400,
        http_status: r.status,
        response_ms: Date.now() - started,
        ssl_expires: sslExpires,
        error: null,
      };
    }
    return fail('too_many_redirects');
  } catch (e) {
    return fail(classifyError(e));
  }
}

// ---- ドメイン期限（公開の登録情報 RDAP）----
const JP_SECOND_LEVEL = new Set(['co', 'or', 'ne', 'ac', 'go', 'ed', 'gr', 'lg', 'ad']);

function registrableDomain(hostname) {
  const labels = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  return labels.slice(tld === 'jp' && JP_SECOND_LEVEL.has(second) ? -3 : -2).join('.');
}

async function fetchDomainExpiry(hostname, { fetchFn = fetch, timeoutMs = 10000 } = {}) {
  const domain = registrableDomain(hostname);
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes('.')) return null;
  try {
    const res = await fetchFn(`https://rdap.org/domain/${domain}`, {
      headers: { Accept: 'application/rdap+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ev = ((data && data.events) || []).find((e) => e.eventAction === 'expiration');
    return ev && ev.eventDate ? String(ev.eventDate).slice(0, 10) : null;
  } catch (e) {
    return null;
  }
}

module.exports = { isBlockedAddress, certExpiryToDate, requestOnce, checkSite, registrableDomain, fetchDomainExpiry };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/siteChecker.test.js`
Expected: PASS。続けて、実際の公開サイトで、本番と同じ経路（`allowPrivate` なし）が動くことを確認:

Run: `node -e "require('./lib/siteChecker').checkSite('https://example.com/').then(console.log)"`
Expected: `ok: true`、`http_status: 200`、`ssl_expires` に日付。

- [ ] **Step 5: コミット**

```bash
git add lib/siteChecker.js tests/siteChecker.test.js
git commit -m "サイト保守: 外からの確認（HTTP・SSL・RDAP）と内部アドレスの拒否を追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 確認の実行と定期実行

**Files:**
- Create: `lib/siteCheckRunner.js`
- Test: `tests/siteCheckRunner.test.js`

**Interfaces:**
- Consumes: `listSites` `recordCheck` `setDomainAuto`（Task 3）、`checkSite` `fetchDomainExpiry`（Task 4）
- Produces:
  - `DOMAIN_RECHECK_MS = 20 * 3600 * 1000`
  - `runChecks(db, { siteIds = null, checkFn = checkSite, domainFn = fetchDomainExpiry, now = Date.now(), concurrency = 3 }): Promise<number>`（確認したサイト数）
  - `startScheduler(db, { intervalMs = 21600000, firstDelayMs = 60000, run = runChecks }): () => void`（止める関数を返す）

- [ ] **Step 1: 失敗するテストを書く**

`tests/siteCheckRunner.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');
const { runChecks, startScheduler } = require('../lib/siteCheckRunner');

function makeDb(n = 3) {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  for (let i = 1; i <= n; i++) store.addSite(db, { name: `S${i}`, url: `s${i}.example.com`, created_by: 'a' });
  return db;
}
const okResult = { ok: true, http_status: 200, response_ms: 120, ssl_expires: '2027-01-01', error: null };

test('全サイトを確認して結果を保存し、確認したサイト数を返す', async () => {
  const db = makeDb(3);
  const n = await runChecks(db, { checkFn: async () => okResult, domainFn: async () => '2027-05-01' });
  assert.strictEqual(n, 3);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks').get().n, 3);
  assert.strictEqual(store.listSites(db)[0].domain_expires_auto, '2027-05-01');
});

test('1サイトが例外になっても、他のサイトは確認される', async () => {
  const db = makeDb(3);
  const calls = [];
  await runChecks(db, {
    checkFn: async (url) => { calls.push(url); if (url.includes('s2.')) throw new Error('boom'); return okResult; },
    domainFn: async () => null,
  });
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(db.prepare('SELECT count(*) n FROM maintenance_checks').get().n, 2);
});

test('同時に確認するのは、指定数まで', async () => {
  const db = makeDb(8);
  let active = 0, peak = 0;
  await runChecks(db, {
    concurrency: 3, domainFn: async () => null,
    checkFn: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return okResult; },
  });
  assert.ok(peak <= 3, `同時数が多すぎる: ${peak}`);
  assert.ok(peak >= 2);
});

test('指定したサイトだけを確認できる（今すぐ確認）', async () => {
  const db = makeDb(3);
  const target = store.listSites(db)[1].id;
  const seen = [];
  await runChecks(db, { siteIds: [target], checkFn: async (u) => { seen.push(u); return okResult; }, domainFn: async () => null });
  assert.deepStrictEqual(seen, ['https://s2.example.com/']);
});

test('ドメイン期限の確認は、前回から20時間たつまで再取得しない。失敗しても前の値は残る', async () => {
  const db = makeDb(1);
  let calls = 0;
  const domainFn = async () => { calls += 1; return calls === 1 ? '2027-05-01' : null; };
  const t0 = Date.parse('2026-10-15T00:00:00Z');
  await runChecks(db, { checkFn: async () => okResult, domainFn, now: t0 });
  await runChecks(db, { checkFn: async () => okResult, domainFn, now: t0 + 3600 * 1000 });
  assert.strictEqual(calls, 1);
  await runChecks(db, { checkFn: async () => okResult, domainFn, now: t0 + 21 * 3600 * 1000 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(store.listSites(db)[0].domain_expires_auto, '2027-05-01');
});

test('サイトが0件でも動く', async () => {
  const db = makeDb(0);
  assert.strictEqual(await runChecks(db, { checkFn: async () => okResult }), 0);
});

test('定期実行: 最初の待ち時間のあとと、一定間隔で実行される。重なって実行しない。止められる', async () => {
  const db = makeDb(1);
  let runs = 0, active = 0, overlap = false;
  const stop = startScheduler(db, {
    intervalMs: 30, firstDelayMs: 10,
    run: async () => { runs += 1; active += 1; if (active > 1) overlap = true; await new Promise((r) => setTimeout(r, 50)); active -= 1; },
  });
  await new Promise((r) => setTimeout(r, 200));
  stop();
  const after = runs;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(runs >= 2, `実行回数: ${runs}`);
  assert.strictEqual(overlap, false);
  assert.strictEqual(runs, after);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/siteCheckRunner.test.js`
Expected: FAIL（モジュールが見つからない）

- [ ] **Step 3: 実装する**

`lib/siteCheckRunner.js`:

```js
// 登録されたサイトを順に確認して、結果を保存する。定期実行もここ。

const store = require('./maintenanceStore');
const { checkSite, fetchDomainExpiry } = require('./siteChecker');

const DOMAIN_RECHECK_MS = 20 * 3600 * 1000;
const SIX_HOURS_MS = 6 * 3600 * 1000;

function needsDomainCheck(site, now) {
  if (!site.domain_checked_at) return true;
  const last = Date.parse(String(site.domain_checked_at).replace(' ', 'T') + 'Z');
  return Number.isNaN(last) || now - last >= DOMAIN_RECHECK_MS;
}

async function runChecks(db, opts = {}) {
  const {
    siteIds = null, checkFn = checkSite, domainFn = fetchDomainExpiry, now = Date.now(), concurrency = 3,
  } = opts;
  const sites = store.listSites(db).filter((s) => !siteIds || siteIds.includes(s.id));
  let next = 0;

  async function worker() {
    while (next < sites.length) {
      const site = sites[next];
      next += 1;
      try {
        store.recordCheck(db, site.id, await checkFn(site.url));
        if (needsDomainCheck(site, now)) {
          const expires = await domainFn(new URL(site.url).hostname);
          store.setDomainAuto(db, site.id, expires, new Date(now).toISOString());
        }
      } catch (e) {
        // 1サイトの失敗で、全体を止めない（ログにはサイト名だけ出す）
        console.error(`[サイト確認] ${site.name} の確認に失敗しました: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sites.length) }, worker));
  return sites.length;
}

function startScheduler(db, { intervalMs = SIX_HOURS_MS, firstDelayMs = 60 * 1000, run = runChecks } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run(db);
    } catch (e) {
      console.error('[サイト確認] 定期確認に失敗しました:', e.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstDelayMs);
  const timer = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

module.exports = { DOMAIN_RECHECK_MS, runChecks, startScheduler };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/siteCheckRunner.test.js`
Expected: PASS（7件）

- [ ] **Step 5: コミット**

```bash
git add lib/siteCheckRunner.js tests/siteCheckRunner.test.js
git commit -m "サイト保守: 確認の実行と定期実行を追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 画面とルート（一覧・詳細・追加・編集・まとめて追加）

**Files:**
- Create: `lib/maintenanceView.js`, `routes/maintenance.js`, `views/maintenance/_badge.ejs`, `views/maintenance/list.ejs`, `views/maintenance/detail.ejs`, `views/maintenance/form.ejs`, `views/maintenance/bulk.ejs`
- Modify: `server.js`（ルート登録・スキーマ作成・定期確認の開始）、`views/partials/header.ejs`（サイドバー）
- Test: `tests/maintenanceRoutes.test.js`

**Interfaces:**
- Consumes: Task 1〜5 の関数すべて（`store.*`、`parseBulk`、`runChecks`、`nowJstDateStr`、`requireLogin`、`requireAdmin`）
- Produces:
  - `createMaintenanceRouter(db, { runChecksFn = runChecks, nowFn = Date.now }): express.Router`
  - ルート:
    - `GET /maintenance`（全員）
    - `GET /maintenance/new` `POST /maintenance` `GET /maintenance/bulk` `POST /maintenance/bulk`（管理者）
    - `GET /maintenance/:id`（全員）
    - `GET /maintenance/:id/edit` `POST /maintenance/:id` `POST /maintenance/:id/delete` `POST /maintenance/:id/check` `POST /maintenance/:id/logs` `POST /maintenance/:id/logs/:logId/delete`（管理者）
  - `lib/maintenanceView.js` の `fmt`: `levelRank(level)` / `hostLabel(url)` / `expiryText(part, dateStr)` / `staleText(part, dateStr)` / `partClass(part)` / `isExpiring(status)` / `clientTypeLabel(t)`

- [ ] **Step 1: 失敗するテストを書く**

`tests/maintenanceRoutes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');
const Database = require('better-sqlite3');
const { ensureMaintenanceSchema } = require('../lib/maintenanceSchema');
const store = require('../lib/maintenanceStore');
const { avatarFor } = require('../lib/avatar');
const { formatJst } = require('../lib/jst');
const { createMaintenanceRouter } = require('../routes/maintenance');

const ADMIN = { user_id: 'admin', display_name: '管理者', role: 'admin' };
const MEMBER = { user_id: 'm1', display_name: 'メンバー', role: 'member' };

function makeDb() {
  const db = new Database(':memory:');
  ensureMaintenanceSchema(db);
  return db;
}

async function withApp(db, user, opts, fn) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = user ? { user } : {};
    res.locals.currentUser = user || null;
    res.locals.currentUserAvatar = user ? avatarFor(user) : null;
    res.locals.formatJst = formatJst;
    next();
  });
  app.use(createMaintenanceRouter(db, opts));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const post = (base, p, body) => fetch(base + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const seed = (db, over = {}) => store.addSite(db, { name: '試験サイト', url: 'example.com', server_name: 'ss1', created_by: 'admin', ...over });

test('サイトが0件でも一覧が表示される。メンバーには追加ボタンが出ない', async () => {
  const db = makeDb();
  await withApp(db, MEMBER, {}, async (base) => {
    const res = await fetch(base + '/maintenance');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /サイト保守/);
    assert.match(html, /管理者が登録します/);
    assert.ok(!html.includes('+ サイトを追加'));
  });
});

test('管理者の一覧には追加ボタンが出る。0件のときは、追加への案内が出る', async () => {
  await withApp(makeDb(), ADMIN, {}, async (base) => {
    const html = await (await fetch(base + '/maintenance')).text();
    assert.match(html, /\+ サイトを追加/);
    assert.match(html, /まとめて追加/);
  });
});

test('一度も確認していないサイトは「未確認」、2回連続失敗のサイトは「応答なし」と出る', async () => {
  const db = makeDb();
  seed(db, { name: 'まだ', url: 'a.example.com' });
  const down = seed(db, { name: '落ちてる', url: 'b.example.com' });
  for (let i = 0; i < 2; i++) store.recordCheck(db, down, { ok: 0, http_status: null, response_ms: 10000, ssl_expires: null, error: 'timeout' });
  await withApp(db, MEMBER, {}, async (base) => {
    const html = await (await fetch(base + '/maintenance')).text();
    assert.match(html, /未確認/);
    assert.match(html, /応答なし/);
    assert.ok(html.indexOf('落ちてる') < html.indexOf('まだ'), '要対応が上に並ぶ');
  });
});

test('全サイトが失敗していても一覧は崩れない（要対応の件数に反映）', async () => {
  const db = makeDb();
  for (const n of ['a', 'b']) {
    const id = seed(db, { name: n, url: `${n}.example.com` });
    for (let i = 0; i < 2; i++) store.recordCheck(db, id, { ok: 0, http_status: 500, response_ms: 50, ssl_expires: null, error: null });
  }
  await withApp(db, ADMIN, {}, async (base) => {
    const res = await fetch(base + '/maintenance');
    assert.strictEqual(res.status, 200);
  });
});

test('未ログインは、ログイン画面へ。メンバーの変更操作は、すべて403で何も変わらない', async () => {
  const db = makeDb();
  const id = seed(db);
  await withApp(db, null, {}, async (base) => {
    const res = await fetch(base + '/maintenance', { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/login');
  });
  let ran = 0;
  await withApp(db, MEMBER, { runChecksFn: async () => { ran += 1; } }, async (base) => {
    const gets = ['/maintenance/new', '/maintenance/bulk', `/maintenance/${id}/edit`];
    for (const g of gets) assert.strictEqual((await fetch(base + g)).status, 403, g);
    const posts = [
      ['/maintenance', { name: 'x', url: 'x.example.com' }],
      ['/maintenance/bulk', { text: 'A,a.example.com', confirm: '1' }],
      [`/maintenance/${id}`, { name: 'x', url: 'x.example.com' }],
      [`/maintenance/${id}/delete`, {}],
      [`/maintenance/${id}/check`, {}],
      [`/maintenance/${id}/logs`, { log_date: '2026-10-15', kind: '点検', note: 'x' }],
      [`/maintenance/${id}/logs/1/delete`, {}],
    ];
    for (const [p, b] of posts) assert.strictEqual((await post(base, p, b)).status, 403, p);
  });
  assert.strictEqual(ran, 0);
  assert.strictEqual(store.listSites(db).length, 1);
  assert.strictEqual(store.getSite(db, id).name, '試験サイト');
  assert.strictEqual(store.listLogs(db, id).length, 0);
});

test('管理者がサイトを追加できる。重複・不正なURLは、画面に理由が出て追加されない', async () => {
  const db = makeDb();
  await withApp(db, ADMIN, {}, async (base) => {
    const ok = await post(base, '/maintenance', { name: '新サイト', url: 'new.example.com', server_name: 'ss1', client_type: 'own', is_wordpress: '1' });
    assert.strictEqual(ok.status, 302);
    assert.strictEqual(store.listSites(db).length, 1);
    const dup = await post(base, '/maintenance', { name: '二重', url: 'https://NEW.example.com', client_type: 'client' });
    assert.strictEqual(dup.status, 200);
    assert.match(await dup.text(), /すでに登録/);
    const bad = await post(base, '/maintenance', { name: '悪い', url: 'ftp://x.example.com', client_type: 'client' });
    assert.strictEqual(bad.status, 200);
    assert.strictEqual(store.listSites(db).length, 1);
  });
});

test('まとめて追加: 確認画面では登録されず、確定すると、正しい行だけ登録される', async () => {
  const db = makeDb();
  const text = 'A,a.example.com,ss1,自社\nB,ftp://b.example.com\nC,c.example.com';
  await withApp(db, ADMIN, {}, async (base) => {
    const preview = await post(base, '/maintenance/bulk', { text });
    assert.strictEqual(preview.status, 200);
    const html = await preview.text();
    assert.match(html, /2件/);
    assert.match(html, /2行目/);
    assert.strictEqual(store.listSites(db).length, 0);
    const done = await post(base, '/maintenance/bulk', { text, confirm: '1' });
    assert.strictEqual(done.status, 302);
    assert.deepStrictEqual(store.listSites(db).map((s) => s.name), ['A', 'C']);
  });
});

test('詳細: 点検記録の追加・削除ができ、バックアップ最終日が反映される。サイトの削除もできる', async () => {
  const db = makeDb();
  const id = seed(db);
  await withApp(db, ADMIN, {}, async (base) => {
    const r = await post(base, `/maintenance/${id}/logs`, { log_date: '2026-10-12', kind: 'バックアップ', note: '手動で確認' });
    assert.strictEqual(r.status, 302);
    const html = await (await fetch(`${base}/maintenance/${id}`)).text();
    assert.match(html, /手動で確認/);
    assert.match(html, /バックアップ/);
    const bad = await post(base, `/maintenance/${id}/logs`, { log_date: 'きのう', kind: '点検', note: '' });
    assert.strictEqual(bad.status, 200);
    const logId = store.listLogs(db, id)[0].id;
    assert.strictEqual((await post(base, `/maintenance/${id}/logs/${logId}/delete`, {})).status, 302);
    assert.strictEqual(store.listLogs(db, id).length, 0);
    assert.strictEqual((await post(base, `/maintenance/${id}/delete`, {})).status, 302);
    assert.strictEqual(store.listSites(db).length, 0);
    assert.strictEqual((await fetch(`${base}/maintenance/${id}`)).status, 404);
  });
});

test('今すぐ確認: 実行され、30秒以内の連続実行は、実行されない', async () => {
  const db = makeDb();
  const id = seed(db);
  let ran = 0;
  const opts = {
    nowFn: () => Date.parse('2026-10-15T12:00:00Z'),
    runChecksFn: async (d, o) => { ran += 1; store.recordCheck(d, o.siteIds[0], { ok: 1, http_status: 200, response_ms: 50, ssl_expires: null, error: null }); },
  };
  await withApp(db, ADMIN, opts, async (base) => {
    const first = await post(base, `/maintenance/${id}/check`, {});
    assert.match(first.headers.get('location'), /notice=checked/);
    db.prepare("UPDATE maintenance_checks SET checked_at='2026-10-15 11:59:50'").run();
    const second = await post(base, `/maintenance/${id}/check`, {});
    assert.match(second.headers.get('location'), /notice=wait/);
    assert.strictEqual(ran, 1);
    db.prepare("UPDATE maintenance_checks SET checked_at='2026-10-15 11:59:00'").run();
    await post(base, `/maintenance/${id}/check`, {});
    assert.strictEqual(ran, 2);
  });
});

test('存在しないサイトは404。メモ欄の文字はエスケープされる', async () => {
  const db = makeDb();
  const id = seed(db, { memo: '<script>alert(1)</script>' });
  await withApp(db, MEMBER, {}, async (base) => {
    assert.strictEqual((await fetch(base + '/maintenance/9999')).status, 404);
    const html = await (await fetch(`${base}/maintenance/${id}`)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test tests/maintenanceRoutes.test.js`
Expected: FAIL（`routes/maintenance` が見つからない）

- [ ] **Step 3: 実装する（ファイルを順に作る）**

`lib/maintenanceView.js`:

```js
// サイト保守の画面で使う、小さな整形関数。

const RANK = { urgent: 0, warn: 1, unknown: 2, ok: 3 };
const levelRank = (level) => (RANK[level] === undefined ? 9 : RANK[level]);

function hostLabel(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch (e) {
    return url;
  }
}

function expiryText(part, dateStr) {
  if (!dateStr || part.days === null) return '—';
  if (part.days < 0) return '期限切れ';
  return `あと${part.days}日`;
}

function staleText(part, dateStr) {
  if (!dateStr) return '記録なし';
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}（${part.days}日前）`;
}

const partClass = (part) => (part.level === 'urgent' ? 'mt-urgent' : part.level === 'warn' ? 'mt-warn-text' : '');
const isExpiring = (st) => ['ssl', 'domain'].some((k) => ['warn', 'urgent'].includes(st.parts[k].level));
const clientTypeLabel = (t) => (t === 'own' ? '自社' : '受託');

module.exports = { levelRank, hostLabel, expiryText, staleText, partClass, isExpiring, clientTypeLabel };
```

`routes/maintenance.js`:

```js
const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const store = require('../lib/maintenanceStore');
const { parseBulk } = require('../lib/maintenanceImport');
const { runChecks } = require('../lib/siteCheckRunner');
const { nowJstDateStr } = require('../lib/jst');
const fmt = require('../lib/maintenanceView');

const CHECK_COOLDOWN_MS = 30 * 1000;
const NOTICES = {
  checked: '確認しました。',
  wait: '直前に確認したばかりです。30秒ほど待ってから、もう一度押してください。',
  added: 'サイトを追加しました。',
  saved: '保存しました。',
  deleted: 'サイトを削除しました。',
};

function createMaintenanceRouter(db, { runChecksFn = runChecks, nowFn = () => Date.now() } = {}) {
  const router = express.Router();
  const admin = [requireLogin, requireAdmin];
  const notFound = (req, res) =>
    res.status(404).render('error', { message: 'サイトが見つかりません', user: req.session.user });
  const noticeOf = (req) => NOTICES[req.query.notice] || null;
  const emptyForm = { name: '', url: '', server_name: '', client_type: 'client', is_wordpress: 1, domain_expires_manual: '', memo: '' };

  // ---- 一覧 ----
  router.get('/maintenance', requireLogin, (req, res) => {
    const rows = store.sortOverview(store.overview(db, nowJstDateStr()));
    const servers = [...new Set(rows.map((r) => r.site.server_name).filter(Boolean))].sort();
    let notice = noticeOf(req);
    if (req.query.notice === 'added' && Number(req.query.n) > 0) notice = `${Number(req.query.n)}件のサイトを追加しました。`;
    res.render('maintenance/list', { rows, servers, summary: store.summarize(rows, nowFn()), notice, fmt });
  });

  // ---- 追加・まとめて追加（/:id より先に定義する）----
  router.get('/maintenance/new', admin, (req, res) => {
    res.render('maintenance/form', { site: null, values: emptyForm, error: null });
  });

  router.post('/maintenance', admin, (req, res) => {
    const values = { ...req.body, is_wordpress: req.body.is_wordpress === '1' ? 1 : 0 };
    try {
      store.addSite(db, { ...values, created_by: req.session.user.user_id });
      res.redirect('/maintenance?notice=added');
    } catch (e) {
      res.render('maintenance/form', { site: null, values, error: e.message });
    }
  });

  router.get('/maintenance/bulk', admin, (req, res) => {
    res.render('maintenance/bulk', { text: '', preview: null, error: null });
  });

  router.post('/maintenance/bulk', admin, (req, res) => {
    const text = String(req.body.text || '');
    const parsed = parseBulk(text, store.listSites(db).map((s) => s.url));
    if (req.body.confirm !== '1') return res.render('maintenance/bulk', { text, preview: parsed, error: null });
    try {
      db.transaction(() => {
        parsed.rows.forEach((r) => store.addSite(db, { ...r, is_wordpress: 1, created_by: req.session.user.user_id }));
      })();
      return res.redirect(`/maintenance?notice=added&n=${parsed.rows.length}`);
    } catch (e) {
      return res.render('maintenance/bulk', { text, preview: parsed, error: e.message });
    }
  });

  // ---- 詳細 ----
  router.get('/maintenance/:id', requireLogin, (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? store.getRow(db, id, nowJstDateStr()) : null;
    if (!row) return notFound(req, res);
    res.render('maintenance/detail', {
      row, checks: store.listChecks(db, id, 30), logs: store.listLogs(db, id), kinds: store.LOG_KINDS,
      today: nowJstDateStr(), notice: noticeOf(req), logError: null, logValues: null, fmt,
    });
  });

  // ---- 編集・削除 ----
  router.get('/maintenance/:id/edit', admin, (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    res.render('maintenance/form', { site, values: { ...site, domain_expires_manual: site.domain_expires_manual || '' }, error: null });
  });

  router.post('/maintenance/:id', admin, (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    const values = { ...req.body, is_wordpress: req.body.is_wordpress === '1' ? 1 : 0 };
    try {
      store.updateSite(db, site.id, values);
      res.redirect(`/maintenance/${site.id}?notice=saved`);
    } catch (e) {
      res.render('maintenance/form', { site, values, error: e.message });
    }
  });

  router.post('/maintenance/:id/delete', admin, (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    store.deleteSite(db, site.id);
    res.redirect('/maintenance?notice=deleted');
  });

  // ---- 今すぐ確認（1サイトにつき30秒に1回まで）----
  router.post('/maintenance/:id/check', admin, async (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    const last = store.latestChecks(db, site.id, 1)[0];
    if (last && nowFn() - Date.parse(String(last.checked_at).replace(' ', 'T') + 'Z') < CHECK_COOLDOWN_MS) {
      return res.redirect(`/maintenance/${site.id}?notice=wait`);
    }
    await runChecksFn(db, { siteIds: [site.id] });
    return res.redirect(`/maintenance/${site.id}?notice=checked`);
  });

  // ---- 点検記録 ----
  router.post('/maintenance/:id/logs', admin, (req, res) => {
    const id = Number(req.params.id);
    if (!store.getSite(db, id)) return notFound(req, res);
    try {
      store.addLog(db, id, { ...req.body, created_by: req.session.user.user_id });
      res.redirect(`/maintenance/${id}`);
    } catch (e) {
      res.render('maintenance/detail', {
        row: store.getRow(db, id, nowJstDateStr()), checks: store.listChecks(db, id, 30), logs: store.listLogs(db, id),
        kinds: store.LOG_KINDS, today: nowJstDateStr(), notice: null, logError: e.message, logValues: req.body, fmt,
      });
    }
  });

  router.post('/maintenance/:id/logs/:logId/delete', admin, (req, res) => {
    const id = Number(req.params.id);
    store.deleteLog(db, Number(req.params.logId), id);
    res.redirect(`/maintenance/${id}`);
  });

  return router;
}

module.exports = { createMaintenanceRouter };
```

`views/maintenance/_badge.ejs`（状態バッジ。色＋アイコン＋文字）:

```ejs
<%
const _icons = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  urgent: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  unknown: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'
};
%>
<span class="st-badge st-<%= status.level %>"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><%- _icons[status.level] %></svg><%= status.label %></span>
```

`views/maintenance/list.ejs`:

```ejs
<%- include('../partials/header') %>

<div class="page-header">
  <h1>サイト保守</h1>
  <% if (currentUser && currentUser.role === 'admin') { %>
    <div class="mt-head-actions">
      <a href="/maintenance/bulk" class="mini-btn">まとめて追加</a>
      <a href="/maintenance/new" class="new-toggle-btn">+ サイトを追加</a>
    </div>
  <% } %>
</div>

<% if (notice) { %><div class="success-text"><%= notice %></div><% } %>
<% if (summary.stale) { %>
  <div class="mt-alert">自動確認が24時間以上、更新されていません。サーバーの状態を確認してください。</div>
<% } %>

<div class="kpi-grid">
  <div class="kpi-card"><div class="label">管理サイト</div><div class="value"><%= summary.total %></div></div>
  <div class="kpi-card"><div class="label">要対応</div><div class="value"><%= summary.urgent %></div></div>
  <div class="kpi-card"><div class="label">期限が近い（30日以内）</div><div class="value"><%= summary.expiring %></div></div>
  <div class="kpi-card"><div class="label">最終確認</div><div class="value" style="font-size:16px;"><%= summary.lastCheckedAt ? formatJst(summary.lastCheckedAt) : 'まだ確認していません' %></div></div>
</div>

<% if (rows.length === 0) { %>
  <div class="panel">
    <div class="empty-note">
      まだサイトが登録されていません。
      <% if (currentUser && currentUser.role === 'admin') { %>
        <a href="/maintenance/new">サイトを追加する →</a> ／ <a href="/maintenance/bulk">まとめて追加する →</a>
      <% } else { %>
        管理者が登録します。
      <% } %>
    </div>
  </div>
<% } else { %>
  <div class="panel mt-panel">
    <div class="mt-filters" role="group" aria-label="絞り込み">
      <button type="button" class="mt-chip" data-filter="all" aria-pressed="true">すべて</button>
      <button type="button" class="mt-chip" data-filter="urgent" aria-pressed="false">要対応</button>
      <button type="button" class="mt-chip" data-filter="expiring" aria-pressed="false">期限が近い</button>
      <% servers.forEach(s => { %>
        <button type="button" class="mt-chip" data-filter="server" data-value="<%= s %>" aria-pressed="false"><%= s %></button>
      <% }) %>
      <span class="mt-count" id="mt-count" role="status" aria-live="polite"><%= rows.length %>件を表示</span>
    </div>

    <table class="mt-table" id="mt-table">
      <thead>
        <tr>
          <th scope="col"><button type="button" class="mt-sort" data-sort="name">サイト</button></th>
          <th scope="col"><button type="button" class="mt-sort" data-sort="status">状態</button></th>
          <th scope="col"><button type="button" class="mt-sort" data-sort="ssl">SSL期限</button></th>
          <th scope="col"><button type="button" class="mt-sort" data-sort="domain">ドメイン期限</button></th>
          <th scope="col"><button type="button" class="mt-sort" data-sort="backup">バックアップ</button></th>
          <th scope="col"><button type="button" class="mt-sort" data-sort="inspect">最終点検</button></th>
        </tr>
      </thead>
      <tbody>
        <% rows.forEach(r => { const p = r.status.parts; %>
          <tr data-level="<%= r.status.level %>" data-expiring="<%= fmt.isExpiring(r.status) ? '1' : '0' %>" data-server="<%= r.site.server_name || '' %>">
            <td data-label="サイト" data-sort-value="<%= r.site.name %>">
              <a class="link-title" href="/maintenance/<%= r.site.id %>"><%= r.site.name %></a>
              <div class="mt-sub">
                <a href="<%= r.site.url %>" target="_blank" rel="noopener noreferrer"><%= fmt.hostLabel(r.site.url) %></a>
                ・ <%= fmt.clientTypeLabel(r.site.client_type) %><%= r.site.server_name ? ' ・ ' + r.site.server_name : '' %>
              </div>
            </td>
            <td data-label="状態" data-sort-value="<%= fmt.levelRank(r.status.level) %>"><%- include('_badge', { status: r.status }) %></td>
            <td data-label="SSL期限" data-sort-value="<%= r.sslExpires || '9999-12-31' %>" class="<%= fmt.partClass(p.ssl) %>"><%= fmt.expiryText(p.ssl, r.sslExpires) %></td>
            <td data-label="ドメイン期限" data-sort-value="<%= r.domainExpires || '9999-12-31' %>" class="<%= fmt.partClass(p.domain) %>"><%= fmt.expiryText(p.domain, r.domainExpires) %></td>
            <td data-label="バックアップ" data-sort-value="<%= r.lastBackup || '0000-00-00' %>" class="<%= fmt.partClass(p.backup) %>"><%= fmt.staleText(p.backup, r.lastBackup) %></td>
            <td data-label="最終点検" data-sort-value="<%= r.lastInspect || '0000-00-00' %>" class="<%= fmt.partClass(p.inspect) %>"><%= fmt.staleText(p.inspect, r.lastInspect) %></td>
          </tr>
        <% }) %>
      </tbody>
    </table>
  </div>
  <script src="/js/maintenance.js"></script>
<% } %>

<%- include('../partials/footer') %>
```

`views/maintenance/detail.ejs`:

```ejs
<%- include('../partials/header') %>
<% const site = row.site; const isAdmin = currentUser && currentUser.role === 'admin'; const p = row.status.parts; %>

<div class="page-header">
  <h1><%= site.name %></h1>
  <div class="mt-head-actions">
    <a href="/maintenance" class="mini-btn">← 一覧に戻る</a>
    <% if (isAdmin) { %><a href="/maintenance/<%= site.id %>/edit" class="mini-btn">編集</a><% } %>
  </div>
</div>

<% if (notice) { %><div class="success-text"><%= notice %></div><% } %>

<div class="content-grid">
  <div>
    <div class="panel">
      <h2>状態 <%- include('_badge', { status: row.status }) %></h2>
      <% if (row.status.reasons.length === 0) { %>
        <div class="empty-note">注意が必要な点はありません。</div>
      <% } else { %>
        <ul class="mt-reasons">
          <% row.status.reasons.forEach(r => { %><li class="mt-reason-<%= r.level %>"><%= r.level === 'urgent' ? '要対応：' : '注意：' %><%= r.text %></li><% }) %>
        </ul>
      <% } %>
      <table class="mt-facts">
        <tr><th scope="row">SSL期限</th><td><%= row.sslExpires || '—' %>（<%= fmt.expiryText(p.ssl, row.sslExpires) %>）</td></tr>
        <tr><th scope="row">ドメイン期限</th><td><%= row.domainExpires || '—' %>（<%= fmt.expiryText(p.domain, row.domainExpires) %>）<%= site.domain_expires_manual ? ' ※手入力' : '' %></td></tr>
        <tr><th scope="row">バックアップ</th><td><%= fmt.staleText(p.backup, row.lastBackup) %></td></tr>
        <tr><th scope="row">最終点検</th><td><%= fmt.staleText(p.inspect, row.lastInspect) %></td></tr>
        <tr><th scope="row">最終確認</th><td><%= row.lastCheckedAt ? formatJst(row.lastCheckedAt) : 'まだ確認していません' %></td></tr>
      </table>
      <% if (isAdmin) { %>
        <form method="POST" action="/maintenance/<%= site.id %>/check" style="margin-top:12px;">
          <button type="submit" class="mini-btn">今すぐ確認</button>
        </form>
      <% } %>
    </div>

    <div class="panel">
      <h2>点検記録</h2>
      <% if (isAdmin) { %>
        <% if (logError) { %><div class="error-text"><%= logError %></div><% } %>
        <form method="POST" action="/maintenance/<%= site.id %>/logs" class="mt-log-form">
          <label>日付<input type="date" name="log_date" required value="<%= logValues ? logValues.log_date : today %>" /></label>
          <label>種類
            <select name="kind">
              <% kinds.forEach(k => { %><option value="<%= k %>" <%= logValues && logValues.kind === k ? 'selected' : '' %>><%= k %></option><% }) %>
            </select>
          </label>
          <label class="mt-log-note">内容（パスワード・個人情報・侵入の詳細は書かない）
            <input type="text" name="note" maxlength="1000" value="<%= logValues ? logValues.note : '' %>" />
          </label>
          <button type="submit" class="new-toggle-btn">記録する</button>
        </form>
      <% } %>
      <% if (logs.length === 0) { %>
        <div class="empty-note">まだ記録がありません。</div>
      <% } else { %>
        <% logs.forEach(l => { %>
          <div class="mt-log-row">
            <span class="mt-log-date"><%= l.log_date %></span>
            <span class="mt-log-kind"><%= l.kind %></span>
            <span class="mt-log-text"><%= l.note %></span>
            <% if (isAdmin) { %>
              <form method="POST" action="/maintenance/<%= site.id %>/logs/<%= l.id %>/delete" onsubmit="return confirm('この記録を削除しますか？');">
                <button type="submit" class="mini-btn">削除</button>
              </form>
            <% } %>
          </div>
        <% }) %>
      <% } %>
    </div>
  </div>

  <div>
    <div class="panel">
      <h2>基本情報</h2>
      <table class="mt-facts">
        <tr><th scope="row">URL</th><td><a href="<%= site.url %>" target="_blank" rel="noopener noreferrer"><%= fmt.hostLabel(site.url) %></a></td></tr>
        <tr><th scope="row">種別</th><td><%= fmt.clientTypeLabel(site.client_type) %></td></tr>
        <tr><th scope="row">サーバー</th><td><%= site.server_name || '—' %></td></tr>
        <tr><th scope="row">WordPress</th><td><%= site.is_wordpress ? 'はい' : 'いいえ' %></td></tr>
        <tr><th scope="row">メモ</th><td class="mt-memo"><%= site.memo || '—' %></td></tr>
      </table>
      <% if (isAdmin) { %>
        <form method="POST" action="/maintenance/<%= site.id %>/delete" onsubmit="return confirm('このサイトと、確認履歴・点検記録をすべて削除します。よろしいですか？');" style="margin-top:12px;">
          <button type="submit" class="mini-btn mt-danger-btn">このサイトを削除</button>
        </form>
      <% } %>
    </div>

    <div class="panel">
      <h2>自動確認の履歴（直近30回）</h2>
      <% if (checks.length === 0) { %>
        <div class="empty-note">まだ確認していません。</div>
      <% } else { %>
        <div class="table-scroll">
          <table class="mt-facts mt-history">
            <thead><tr><th scope="col">日時</th><th scope="col">結果</th><th scope="col">応答</th></tr></thead>
            <tbody>
              <% checks.forEach(c => { %>
                <tr>
                  <td><%= formatJst(c.checked_at) %></td>
                  <td><%= c.ok ? '成功' : '失敗' %><%= c.http_status ? '（' + c.http_status + '）' : '' %><%= c.error ? '：' + c.error : '' %></td>
                  <td><%= c.response_ms === null ? '—' : c.response_ms + 'ms' %></td>
                </tr>
              <% }) %>
            </tbody>
          </table>
        </div>
      <% } %>
    </div>
  </div>
</div>

<%- include('../partials/footer') %>
```

`views/maintenance/form.ejs`:

```ejs
<%- include('../partials/header') %>

<div class="page-header">
  <h1><%= site ? 'サイトを編集' : 'サイトを追加' %></h1>
  <a href="<%= site ? '/maintenance/' + site.id : '/maintenance' %>" class="mini-btn">← 戻る</a>
</div>

<div class="panel" style="max-width:640px;">
  <% if (error) { %><div class="error-text"><%= error %></div><% } %>
  <form method="POST" action="<%= site ? '/maintenance/' + site.id : '/maintenance' %>">
    <label class="mt-label" for="f-name">名前</label>
    <input id="f-name" type="text" name="name" required maxlength="100" value="<%= values.name %>" class="mt-input" />

    <label class="mt-label" for="f-url">URL</label>
    <input id="f-url" type="text" name="url" required value="<%= values.url %>" placeholder="例: example.com" class="mt-input" />

    <label class="mt-label" for="f-server">サーバー名（任意）</label>
    <input id="f-server" type="text" name="server_name" maxlength="50" value="<%= values.server_name %>" placeholder="例: ss170071" class="mt-input" />

    <label class="mt-label" for="f-type">種別</label>
    <select id="f-type" name="client_type" class="mt-input">
      <option value="client" <%= values.client_type !== 'own' ? 'selected' : '' %>>受託</option>
      <option value="own" <%= values.client_type === 'own' ? 'selected' : '' %>>自社</option>
    </select>

    <label class="mt-check"><input type="checkbox" name="is_wordpress" value="1" <%= values.is_wordpress ? 'checked' : '' %> /> WordPressのサイト</label>

    <label class="mt-label" for="f-domain">ドメイン期限（任意・自動で取得できないとき用）</label>
    <input id="f-domain" type="date" name="domain_expires_manual" value="<%= values.domain_expires_manual || '' %>" class="mt-input" />

    <label class="mt-label" for="f-memo">メモ（任意）</label>
    <textarea id="f-memo" name="memo" rows="3" maxlength="500" class="mt-input"><%= values.memo %></textarea>
    <div class="mt-help">このメモは、メンバー全員が見られます。パスワード・個人情報・侵入や不審ファイルの詳細は書かないでください。</div>

    <button type="submit" class="new-toggle-btn"><%= site ? '保存する' : '追加する' %></button>
  </form>
</div>

<%- include('../partials/footer') %>
```

`views/maintenance/bulk.ejs`:

```ejs
<%- include('../partials/header') %>

<div class="page-header">
  <h1>サイトをまとめて追加</h1>
  <a href="/maintenance" class="mini-btn">← 一覧に戻る</a>
</div>

<div class="panel" style="max-width:760px;">
  <% if (error) { %><div class="error-text"><%= error %></div><% } %>
  <p class="mt-help">1行に1サイトで、<b>名前,URL,サーバー名,種別</b> の順に書きます（カンマかタブ区切り）。サーバー名と種別は省略できます。種別は「自社」か「受託」（省略すると受託）。<br />例：<code>estowa.jp,estowa.jp,ss256422,自社</code></p>

  <form method="POST" action="/maintenance/bulk">
    <textarea name="text" rows="12" class="mt-input" style="font-family:monospace;" aria-label="サイトの一覧"><%= text %></textarea>
    <button type="submit" class="mini-btn">内容を確認する</button>
  </form>

  <% if (preview) { %>
    <h2 style="margin-top:20px;">確認</h2>
    <p><b><%= preview.rows.length %>件</b>を追加します。<%= preview.errors.length ? preview.errors.length + '行は、追加されません（下記）。' : '' %></p>
    <% if (preview.errors.length > 0) { %>
      <ul class="mt-reasons">
        <% preview.errors.forEach(e => { %><li class="mt-reason-urgent"><%= e.line %>行目：<%= e.message %><%= e.text ? '（' + e.text + '）' : '' %></li><% }) %>
      </ul>
    <% } %>
    <% if (preview.rows.length > 0) { %>
      <ul class="mt-preview-list">
        <% preview.rows.forEach(r => { %><li><%= r.name %> ・ <%= r.url %> ・ <%= r.server_name || 'サーバー名なし' %> ・ <%= r.client_type === 'own' ? '自社' : '受託' %></li><% }) %>
      </ul>
      <form method="POST" action="/maintenance/bulk">
        <input type="hidden" name="text" value="<%= text %>" />
        <input type="hidden" name="confirm" value="1" />
        <button type="submit" class="new-toggle-btn"><%= preview.rows.length %>件を追加する</button>
      </form>
    <% } %>
  <% } %>
</div>

<%- include('../partials/footer') %>
```

`views/partials/header.ejs` を Edit で変更: 「アイディア」のリンク（`href="/ideas"` の `<a>` ブロック）の直後、`<% if (currentUser && currentUser.role === 'admin') { %>`（勤怠ダウンロードの前）の直前に追加:

```ejs
    <a class="nav-item" href="/maintenance" title="サイト保守">
      <span class="nav-ico nav-ico-plain"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>
      <span class="nav-label">サイト保守</span>
    </a>
```

`server.js` を Edit で変更（3か所）:

1. `const searchRoutes = require('./routes/search');` の次の行に追加:
```js
const { createMaintenanceRouter } = require('./routes/maintenance');
const { ensureMaintenanceSchema } = require('./lib/maintenanceSchema');
const { startScheduler } = require('./lib/siteCheckRunner');
```
2. `app.use(searchRoutes);` の次の行に追加:
```js
ensureMaintenanceSchema(db);
app.use(createMaintenanceRouter(db));
```
3. ファイル末尾の `attachChatSocket(server, sessionMiddleware, db);` の次の行に追加（Task 7 で動作確認する）:
```js
if (process.env.SITE_CHECK_DISABLED !== '1') startScheduler(db);
```

- [ ] **Step 4: テストが通ることを確認**

Run: `node --test tests/maintenanceRoutes.test.js`
Expected: PASS（10件）。続けて、全体: `npm test` → すべて PASS。

- [ ] **Step 5: コミット**

```bash
git add lib/maintenanceView.js routes/maintenance.js views/maintenance views/partials/header.ejs server.js tests/maintenanceRoutes.test.js
git commit -m "サイト保守: 一覧・詳細・追加・編集・まとめて追加の画面とルートを追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: スタイルと、絞り込み・並べ替え

**Files:**
- Modify: `public/css/style.css`（末尾に追加）
- Create: `public/js/maintenance.js`

**Interfaces:**
- Consumes: Task 6 の `list.ejs` のHTML（`#mt-table` `.mt-chip[data-filter]` `.mt-sort[data-sort]` `#mt-count`、行の `data-level` `data-expiring` `data-server`、セルの `data-sort-value`）
- Produces: 絞り込み・並べ替えの動作、状態バッジ・表・スマホ用カードのスタイル

- [ ] **Step 1: スタイルを追加する**

`public/css/style.css` の末尾に、Edit ツールで追加（既存の最終行の後ろに、そのまま続ける）:

```css

/* ---- サイト保守 ---- */
.mt-head-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mt-alert { background: #fff4d6; border-left: 5px solid #d9a400; color: #7a4a00; padding: 10px 14px; margin-bottom: 14px; }
.mt-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
.mt-chip { border: 1px solid var(--border); background: #fff; color: var(--text); border-radius: 16px; padding: 4px 14px; font-size: 13px; cursor: pointer; min-height: 32px; }
.mt-chip[aria-pressed="true"] { background: var(--primary); border-color: var(--primary); color: #fff; }
.mt-count { margin-left: auto; font-size: 13px; color: var(--text-muted); }
.mt-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.mt-table th, .mt-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
.mt-table thead th { background: #ececf1; font-size: 13px; }
.mt-sort { all: unset; cursor: pointer; font-weight: 700; }
.mt-sort:focus-visible, .mt-chip:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
th[aria-sort="ascending"] .mt-sort::after { content: " ▲"; font-size: 11px; }
th[aria-sort="descending"] .mt-sort::after { content: " ▼"; font-size: 11px; }
.mt-sub { font-size: 12px; color: var(--text-muted); }
.mt-sub a { color: var(--text-muted); text-decoration: underline; }
.mt-urgent { color: #8f1717; font-weight: 700; }
.mt-warn-text { color: #7a4a00; font-weight: 700; }
.mt-table tr[hidden] { display: none; }

.st-badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 14px; padding: 2px 10px; font-size: 13px; font-weight: 700; white-space: nowrap; }
.st-badge svg { width: 14px; height: 14px; flex: none; }
.st-ok { background: #e3f6e8; color: #1d7a34; }
.st-warn { background: #fff4d6; color: #7a4a00; }
.st-urgent { background: #fdecec; color: #8f1717; }
.st-unknown { background: #eef0f4; color: #444a5e; }

.mt-reasons { margin: 8px 0 12px; padding-left: 20px; }
.mt-reason-urgent { color: #8f1717; }
.mt-reason-warn { color: #7a4a00; }
.mt-facts { width: 100%; border-collapse: collapse; font-size: 14px; }
.mt-facts th, .mt-facts td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.mt-facts th { width: 8em; color: var(--text-muted); font-weight: 400; white-space: nowrap; }
.mt-history th { width: auto; font-weight: 700; color: var(--text); }
.mt-memo { white-space: pre-wrap; word-break: break-word; }
.mt-danger-btn { color: #8f1717; border-color: #c93030; }
.mt-log-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin-bottom: 14px; }
.mt-log-form label { font-size: 13px; color: var(--text-muted); display: flex; flex-direction: column; gap: 2px; }
.mt-log-form input, .mt-log-form select { padding: 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 14px; }
.mt-log-note { flex: 1 1 240px; }
.mt-log-row { display: flex; gap: 10px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.mt-log-date { font-variant-numeric: tabular-nums; color: var(--text-muted); }
.mt-log-kind { background: #ececf1; border-radius: 10px; padding: 1px 10px; font-size: 12px; }
.mt-log-text { flex: 1 1 200px; word-break: break-word; }
.mt-label { font-size: 13px; color: var(--text-muted); display: block; margin-bottom: 2px; }
.mt-input { width: 100%; padding: 10px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: inherit; }
.mt-check { display: block; margin-bottom: 12px; font-size: 14px; }
.mt-help { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }
.mt-preview-list { padding-left: 20px; font-size: 14px; }

/* スマホ幅: 表をカード表示にする */
@media (max-width: 640px) {
  .mt-table thead { display: none; }
  .mt-table, .mt-table tbody { display: block; }
  .mt-table tr { display: block; border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 10px; }
  .mt-table td { display: flex; justify-content: space-between; gap: 12px; border-bottom: none; padding: 4px 0; }
  .mt-table td::before { content: attr(data-label); color: var(--text-muted); font-size: 13px; flex: none; }
  .mt-table td:first-child { display: block; }
  .mt-table td:first-child::before { display: none; }
  .mt-chip, .mini-btn { min-height: 44px; }
  .mt-count { flex-basis: 100%; margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) { .mt-chip, .mt-sort { transition: none; } }
```

- [ ] **Step 2: 絞り込み・並べ替えのスクリプトを書く**

`public/js/maintenance.js`:

```js
// サイト保守の一覧: 絞り込みチップと、列見出しによる並べ替え。
(function () {
  var table = document.getElementById('mt-table');
  if (!table) return;
  var body = table.tBodies[0];
  var rows = Array.prototype.slice.call(body.rows);
  var chips = document.querySelectorAll('.mt-chip');
  var count = document.getElementById('mt-count');
  var current = { filter: 'all', value: '' };

  function matches(row) {
    if (current.filter === 'urgent') return row.getAttribute('data-level') === 'urgent';
    if (current.filter === 'expiring') return row.getAttribute('data-expiring') === '1';
    if (current.filter === 'server') return row.getAttribute('data-server') === current.value;
    return true;
  }

  function applyFilter() {
    var shown = 0;
    rows.forEach(function (row) {
      var ok = matches(row);
      row.hidden = !ok;
      if (ok) shown += 1;
    });
    count.textContent = shown + '件を表示';
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
      chip.setAttribute('aria-pressed', 'true');
      current = { filter: chip.getAttribute('data-filter'), value: chip.getAttribute('data-value') || '' };
      applyFilter();
    });
  });

  // 列の並べ替え: 同じ列をもう一度押すと、逆順になる
  var keyIndex = { name: 0, status: 1, ssl: 2, domain: 3, backup: 4, inspect: 5 };
  var sorted = { key: null, dir: 1 };

  function cellValue(row, idx) {
    return row.cells[idx].getAttribute('data-sort-value') || '';
  }

  table.querySelectorAll('.mt-sort').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-sort');
      var idx = keyIndex[key];
      sorted.dir = sorted.key === key ? -sorted.dir : 1;
      sorted.key = key;
      var numeric = key === 'status';
      rows.sort(function (a, b) {
        var x = cellValue(a, idx), y = cellValue(b, idx);
        var cmp = numeric ? Number(x) - Number(y) : x.localeCompare(y, 'ja');
        return cmp * sorted.dir;
      });
      rows.forEach(function (row) { body.appendChild(row); });
      table.querySelectorAll('th').forEach(function (th) { th.removeAttribute('aria-sort'); });
      btn.parentNode.setAttribute('aria-sort', sorted.dir === 1 ? 'ascending' : 'descending');
    });
  });
})();
```

- [ ] **Step 3: 画面で確認する（PC幅・スマホ幅）**

1. ローカルのDBに、ダミーを入れる（名前の先頭に `ZZ確認用:` を付ける）:

```bash
node -e "
const db=require('./db/connection');
const {ensureMaintenanceSchema}=require('./lib/maintenanceSchema');
const s=require('./lib/maintenanceStore');
ensureMaintenanceSchema(db);
const mk=(n,u,srv,t)=>s.addSite(db,{name:'ZZ確認用:'+n,url:u,server_name:srv,client_type:t,created_by:'admin'});
const ok=mk('正常','ok.example.com','ss1','own'), slow=mk('遅い','slow.example.com','ss1','client'), down=mk('応答なし','down.example.com','ss2','client'), soon=mk('期限間近','soon.example.com','お名前.com','client'), fresh=mk('未確認','fresh.example.com','ss2','client');
const chk=(id,o)=>s.recordCheck(db,id,Object.assign({ok:1,http_status:200,response_ms:300,ssl_expires:'2027-06-01',error:null},o));
chk(ok,{}); chk(slow,{response_ms:4200});
chk(down,{ok:0,http_status:null,error:'timeout'}); chk(down,{ok:0,http_status:null,error:'timeout'});
chk(soon,{ssl_expires:new Date(Date.now()+12*864e5).toISOString().slice(0,10)});
s.addLog(db,ok,{log_date:new Date().toISOString().slice(0,10),kind:'バックアップ',note:'ダミー',created_by:'admin'});
console.log('ok');"
node server.js
```

2. ブラウザで `http://localhost:3000/maintenance` を開く（ローカル用の管理者でログイン）。次を確認する:
   - 4枚の集計カード、要対応が上に並ぶ、状態バッジ（アイコン＋文字）。
   - チップ「要対応」「期限が近い」「ss1」で、表示が絞られ、「n件を表示」が変わる。
   - 列見出しを押すと並び替わり、もう一度押すと逆順になる。
   - 詳細画面で、点検記録を追加・削除できる。「今すぐ確認」を押すと、`example.com` 系は応答なし（DNSで失敗）と記録されること（外部へは出ない前提で、失敗が正しく記録されればよい）。
3. 幅390pxで、横にはみ出さず、表がカード表示になること（`document.documentElement.scrollWidth <= 390`）。
4. 確認後、ダミーを削除し、サーバーを止める:

```bash
node -e "
const db=require('./db/connection');
const ids=db.prepare(\"SELECT id FROM maintenance_sites WHERE name LIKE 'ZZ確認用:%'\").all().map(r=>r.id);
ids.forEach(id=>require('./lib/maintenanceStore').deleteSite(db,id)); console.log('削除',ids.length);"
```

- [ ] **Step 4: 全テストを実行する**

Run: `npm test`
Expected: すべて PASS

- [ ] **Step 5: コミット**

```bash
git add public/css/style.css public/js/maintenance.js
git commit -m "サイト保守: スタイル（状態バッジ・表・スマホ用カード）と、絞り込み・並べ替えを追加

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 実機での通信確認・ドキュメント・仕上げ

**Files:**
- Modify: `CLAUDE.md`（機能一覧に追記）
- Create（Git管理外）: `C:\estowa_ai\output\server\maintenance-sites-import-draft.csv`（本番へ「まとめて追加」で登録する一覧の下書き）

**Interfaces:**
- Consumes: Task 1〜7 のすべて
- Produces: 反映できる状態（`main` に統合・全テスト通過）、反映手順、登録用の下書き

- [ ] **Step 1: 公開サイトへの実通信を確認する（本番と同じ経路）**

Run:
```bash
node -e "
const c=require('./lib/siteChecker');
(async()=>{
  console.log('example.com', await c.checkSite('https://example.com/'));
  console.log('RDAP', await c.fetchDomainExpiry('example.com'));
  console.log('内部', await c.checkSite('http://169.254.169.254/latest/meta-data/'));
})();"
```
Expected: 1つ目は `ok: true`・`ssl_expires` に日付、2つ目は日付または `null`（取れない場合は手入力の欄を使う運用でよい）、3つ目は `error: 'blocked'`。

- [ ] **Step 2: 定期実行の起動を確認する**

Run: `SITE_CHECK_DISABLED=1 node server.js` が、確認の予約なしで起動すること。通常起動（環境変数なし）でも、サイトが0件のとき、エラーが出ないこと（起動1分後に、何もせず終わる）。確認後、サーバーを止める。

- [ ] **Step 3: `CLAUDE.md` の機能一覧に追記する**

`CLAUDE.md` の「機能一覧」の段落の、「全体検索（…）/」の後ろに、Edit ツールで次を追加:

```
サイト保守ダッシュボード（管理しているWordPressサイトの稼働・SSL期限・ドメイン期限・バックアップ・点検を一覧。`routes/maintenance.js`、`lib/maintenance*.js`・`lib/siteChecker.js`。自動確認は外から見える情報だけで、サイトの認証情報は持たない。閲覧は全員・編集は管理者のみ）/
```

さらに、「アーキテクチャ・実装パターン」の末尾（チャット・音声の項目の後）に、次の項目を追加:

```
- **サイト保守（自動確認）**: `lib/siteCheckRunner.js` が、起動1分後と6時間おきに、登録サイトのURLへ外から1回アクセスし、応答・応答時間・SSL証明書の期限を保存する（ドメイン期限は1日1回、公開のRDAPから）。本文は保存しない。内部アドレス（127.x・10.x・169.254.x・::1 など）と、そこへの転送には、接続しない（`lib/siteChecker.js` の `isBlockedAddress` / `safeLookup`）。`allowPrivate` はテスト専用で、本番のコードから渡さない。ログインが必要な情報（更新状況・バックアップ日）は取得せず、「点検記録」の手入力から出す。`SITE_CHECK_DISABLED=1` で、定期確認を止められる。
```

- [ ] **Step 4: 登録用の一覧の下書きを作る（Git管理外）**

`C:\estowa_ai\brain\projects\サーバー保守.md` と `C:\estowa_ai\docs\server-management.md` を読み、管理対象サイトの「名前・URL・サーバー名・種別」を、`output/server/maintenance-sites-import-draft.csv` に、`名前,URL,サーバー名,種別` の形式（まとめて追加の入力形式）で書き出す。
- URL・サーバー名が、ノート・手順書から確定できないサイトは、その行の先頭に `# 要確認:` を付けて、書き出す（`#` で始まる行は、取り込みで無視される）。推測でURLを書かない。
- パスワード・個人情報・アカウント名は、書かない。
- 出力の末尾に、「確定できなかった件数」を、集計して報告する。

- [ ] **Step 5: 全体の確認とコミット**

Run: `npm test`
Expected: すべて PASS。

```bash
git add CLAUDE.md
git commit -m "サイト保守: CLAUDE.mdに機能と自動確認の方針を追記

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git checkout main
git merge --ff-only site-maintenance
git branch -d site-maintenance
git log --oneline -10
```

- [ ] **Step 6: 反映の手順を、山口さんに渡す（push・反映は、承認をもらってから）**

承認後に、`git push origin main`。反映は、山口さんのPCで:

```bash
ssh deploy@160.251.181.171 "cd ~/estowa-portal && git pull && npm install && sudo systemctl restart estowa-portal && systemctl is-active estowa-portal"
```

反映後の確認:
1. サイドバーに「サイト保守」が出る。
2. 「まとめて追加」で、下書きの一覧を貼り付け、確認画面で件数とエラー行を見てから、追加する。
3. 詳細画面の「今すぐ確認」で、実際のサイトの結果（成功・応答時間・SSL期限）が出る。
4. 6時間以内に、自動確認が走り、一覧の「最終確認」が更新される。VPSから外へ出られない場合は、`journalctl -u estowa-portal -n 50` に `[サイト確認]` のエラーが出る。

---

## Self-Review（計画の自己点検）

**1. 仕様の網羅（spec → タスク）**
- §2 権限（管理者／メンバー、保存しない情報） → Task 6（`requireAdmin`、権限テスト、メモ欄の注意書き）。
- §3 範囲（一覧・詳細・追加・編集・まとめて追加・自動確認・点検記録→最新日） → Task 3, 4, 5, 6, 7。
- §4 画面（集計カード、絞り込み、並べ替え、状態バッジ、スマホカード、0件の案内、詳細、フォーム、まとめて追加の確認） → Task 6（HTML）、Task 7（CSS・JS）。
- §5 状態の判定（しきい値・優先順・ラベル） → Task 1。
- §6 自動確認（6時間・1日1回・同時3・タイムアウト・リダイレクト・内部アドレス拒否・UA・本文を保存しない・200件・今すぐ確認30秒） → Task 4（確認）、Task 5（実行・間隔・同時数）、Task 3（200件）、Task 6（30秒）。
- §7 データ（3テーブル、バックアップ最終日＝記録の最新） → Task 3。
- §8 構成 → ファイル構成の表。
- §9 UI方針（色＋アイコン＋文字、44px、`aria-sort`、`aria-pressed`、reduced-motion） → Task 6（`_badge.ejs`・`aria-*`）、Task 7（CSS）。
- §10 エラー処理（失敗の記録・フォームのエラー・24時間以上更新なしの注意） → Task 3（`summarize` の `stale`）、Task 5（例外の吸収）、Task 6（フォームのエラー表示・注意帯）。
- §11 テスト・§12 反映 → 各タスクのテスト、Task 8。
- 抜けは見つからなかった。

**2. プレースホルダーの確認**: 「TBD」「あとで」「適切に処理」などの記述はない。Task 8 Step 4 の下書き作成は、元データ（ノート）を読んで確定する作業で、推測を書かない規則を明記した。

**3. 型・名前の一貫性**: `judgeSite` の返り値（`level/label/reasons/parts`）は、Task 1 の定義と、Task 3（`buildRow`・`summarize`・`isExpiring`）、Task 6（`_badge.ejs`・`fmt`）で一致。`deleteLog(db, logId, siteId)` は、Task 3 の定義と Task 6 の呼び出しで一致。`runChecks(db, { siteIds })` は、Task 5 の定義と Task 6 の呼び出し（`runChecksFn(db, { siteIds: [id] })`）で一致。`checkSite` の `allowPrivate`・`requestFn` は、Task 4 の定義とテストで一致。

**4. Review Focus の網羅**: ①内部アドレス・転送 → Task 4 のテスト。②URLの入力ゆれ → Task 2 のテスト。③期限の境界 → Task 1 のテスト。④空・未確認 → Task 1・3・6 のテスト。⑤管理者以外の変更操作 → Task 6 のテスト。

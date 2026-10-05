# ホーム画面チャット＋トランシーバー音声 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ホーム画面に、在宅の人と社内の各人（1対1）のテキストチャットと、押している間だけ届くトランシーバー式音声を追加する。

**Architecture:** 既存のExpressプロセスにWebSocket（`ws`）を同居させ、既存のセッションで認証する。メッセージはSQLiteに保存し、新着・オンライン状態・WebRTCの接続情報（シグナリング）はWebSocketで中継する。音声はブラウザ同士のWebRTC（在宅の人と各社内の人の間に1本ずつ常時接続）で、「話す」ボタンの間だけ送信トラックを差し込む。サーバー側の判断（誰と誰が話せるか）は、DBに依存する純粋なロジック（`lib/chatRules.js`・`lib/chatHub.js`）に集め、`node:test`で自動テストする。

**Tech Stack:** Node.js（>=18）/ Express 5 / EJS / better-sqlite3 / `ws` / ブラウザ標準のWebRTC・Fetch / `node:test`（追加ライブラリなし）

**Spec:** `docs/superpowers/specs/2026-10-05-voice-chat-design.md`

## Global Constraints

- 会話の組み合わせは「在宅の人1人 ↔ 社内の各人」のみ。社内同士は、サーバー側で必ず拒否する。
- 在宅の人は `users.is_remote = 1` の1人だけ（それ以外は社内扱い）。
- 認証はポータルの既存セッションを使う。別ログインは作らない。
- 時刻はUTCで保存し、表示は `lib/jst.js` の `formatJst` を使う。
- 音声は保存しない。録音しない。
- 作らないもの: 着信画面、ミュート、社内同士の会話、複数人同時通話、ファイル添付、画面共有、プッシュ通知。
- ミュート/音量: ブラウザからPC本体の音量は操作しない。受信音声は、相手が話している間だけ設定音量で鳴らし、それ以外は無音（ページ内の制御のみ）。音量はlocalStorageに記憶する。
- 初回に「PCのミュートを解除し、音量を上げてください」の案内を出す。
- TURN認証情報・キーは`.env`から読む。コードに書かない。
- テストは実スタッフのデータを使わず、ダミーアカウントで行う。
- `git push`（＝Renderへの本番デプロイ）は、人の承認を得てから行う。この計画ではpushしない。
- Windowsのコマンドは、`apps/estowa-portal/` を作業ディレクトリとして実行する。

## Review Focus

- 社内の人から別の社内の人へ、チャット・「話す」・接続情報を送る → サーバーが拒否し、相手には何も届かない（Task 3でテスト）。
- 同じ人が複数タブ／ブラウザで開いている → チャットは全タブに届き、1つ閉じてもオンラインのまま。音声の接続情報は最新のタブにだけ届く（Task 3でテスト）。
- 在宅フラグ未設定、または在宅フラグを別の人に移した → 常に1人だけ。未設定の間はチャット欄を出さない（Task 1・Task 4でテスト）。
- 空メッセージ・2000文字超・`<script>`を含む本文 → 空と超過は拒否し、本文は常にテキストとして表示する（Task 2でテスト、Task 5で`textContent`のみ使用）。
- オフラインの相手へ送信 → 保存され、相手の次回表示で未読として出る。「話す」は相手がオンラインの時だけ押せる（Task 2・Task 5）。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `lib/chatSchema.js`（新規） | `users.is_remote`列と`chat_messages`表を作る（`db/init.js`とテストが共用） |
| `lib/chatRules.js`（新規） | 在宅ユーザーの取得・設定、「この2人は話せるか」の判定、相手一覧 |
| `lib/chatStore.js`（新規） | メッセージの保存・取得・既読・未読数 |
| `lib/chatHub.js`（新規） | 接続管理、オンライン状態、メッセージ・音声シグナルの中継（ソケットを抽象化） |
| `lib/chatSocket.js`（新規） | `ws`をHTTPサーバーに接続し、セッション認証を行って`chatHub`に渡す（薄い層） |
| `routes/chat.js`（新規） | `GET /chat/state`、`GET /chat/messages/:peerUserId` |
| `routes/users.js`・`views/users/list.ejs`（変更） | 在宅フラグの設定 |
| `routes/home.js`・`views/home.ejs`（変更） | ホームにチャット欄を差し込む |
| `views/partials/chat.ejs`（新規） | チャット欄のHTML |
| `public/js/chat.js`（新規） | チャットと音声のクライアント |
| `public/css/style.css`（変更） | チャット欄のスタイル |
| `db/seed-chat-dummy.js`（新規） | ローカル確認用ダミーアカウント |
| `tests/*.test.js`（新規） | 自動テスト |

---

### Task 1: スキーマ・在宅フラグ・ペア判定

**Files:**
- Create: `lib/chatSchema.js`
- Create: `lib/chatRules.js`
- Create: `tests/chatRules.test.js`
- Modify: `db/init.js`（`email`列マイグレーションの直後、ファイル末尾の管理者作成より前）
- Modify: `package.json`（`scripts.test`）
- Modify: `routes/users.js`、`views/users/list.ejs`

**Interfaces:**
- Produces:
  - `ensureChatSchema(db): void`
  - `getRemoteUser(db): {id, user_id, display_name} | null`
  - `setRemoteUser(db, id: number | null): void`（指定した1人だけ`is_remote=1`にする。`null`で全解除）
  - `canPair(db, userIdA: string, userIdB: string): boolean`
  - `peersOf(db, userId: string): {id, user_id, display_name}[]`

- [ ] **Step 1: 失敗するテストを書く**

`package.json`の`scripts.test`を `"node --test"` に変更する（`tests/`配下の`*.test.js`が自動で実行される）。

`tests/chatRules.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { getRemoteUser, setRemoteUser, canPair, peersOf } = require('../lib/chatRules');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x',
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
  )`);
  ensureChatSchema(db);
  for (const [uid, name] of [['home', '在宅'], ['a', '社内A'], ['b', '社内B'], ['c', '社内C']]) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, name);
  }
  return db;
}
const idOf = (db, uid) => db.prepare('SELECT id FROM users WHERE user_id = ?').get(uid).id;

test('在宅未設定の間は誰も話せない', () => {
  const db = makeDb();
  assert.strictEqual(getRemoteUser(db), null);
  assert.strictEqual(canPair(db, 'home', 'a'), false);
  assert.deepStrictEqual(peersOf(db, 'a'), []);
});

test('在宅×社内は話せる、社内同士は話せない', () => {
  const db = makeDb();
  setRemoteUser(db, idOf(db, 'home'));
  assert.strictEqual(canPair(db, 'home', 'a'), true);
  assert.strictEqual(canPair(db, 'b', 'home'), true);
  assert.strictEqual(canPair(db, 'a', 'b'), false);
  assert.strictEqual(canPair(db, 'a', 'a'), false);
  assert.strictEqual(canPair(db, 'home', 'ghost'), false);
});

test('在宅フラグは常に1人だけ（移すと前の人は社内に戻る）', () => {
  const db = makeDb();
  setRemoteUser(db, idOf(db, 'home'));
  setRemoteUser(db, idOf(db, 'a'));
  assert.strictEqual(getRemoteUser(db).user_id, 'a');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users WHERE is_remote = 1').get().c, 1);
  setRemoteUser(db, null);
  assert.strictEqual(getRemoteUser(db), null);
});

test('相手一覧: 在宅は全社内、社内は在宅1人', () => {
  const db = makeDb();
  setRemoteUser(db, idOf(db, 'home'));
  assert.deepStrictEqual(peersOf(db, 'home').map((u) => u.user_id), ['a', 'b', 'c']);
  assert.deepStrictEqual(peersOf(db, 'a').map((u) => u.user_id), ['home']);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/chatSchema'`）

- [ ] **Step 3: 最小の実装を書く**

`lib/chatSchema.js`:

```js
// チャット用のテーブル・列を作る（何度実行しても安全）
function ensureChatSchema(db) {
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('is_remote')) {
    db.exec('ALTER TABLE users ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id TEXT NOT NULL,     -- users.user_id
      receiver_id TEXT NOT NULL,   -- users.user_id
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_receiver_unread ON chat_messages(receiver_id, sender_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_chat_pair ON chat_messages(sender_id, receiver_id, id);
  `);
}

module.exports = { ensureChatSchema };
```

`lib/chatRules.js`:

```js
// 「在宅の人1人 ↔ 社内の各人」だけが話せる、というルールを集めたモジュール

function getRemoteUser(db) {
  return db.prepare('SELECT id, user_id, display_name FROM users WHERE is_remote = 1').get() || null;
}

// 指定した1人だけを在宅にする。nullなら全解除
function setRemoteUser(db, id) {
  db.transaction(() => {
    db.prepare('UPDATE users SET is_remote = 0').run();
    if (id !== null && id !== undefined) {
      db.prepare('UPDATE users SET is_remote = 1 WHERE id = ?').run(id);
    }
  })();
}

function canPair(db, userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  const remote = getRemoteUser(db);
  if (!remote) return false;
  const aIsRemote = remote.user_id === userIdA;
  const bIsRemote = remote.user_id === userIdB;
  if (aIsRemote === bIsRemote) return false; // 社内同士
  const other = aIsRemote ? userIdB : userIdA;
  return !!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(other);
}

function peersOf(db, userId) {
  const remote = getRemoteUser(db);
  if (!remote) return [];
  if (remote.user_id === userId) {
    return db
      .prepare('SELECT id, user_id, display_name FROM users WHERE user_id != ? ORDER BY id')
      .all(userId);
  }
  return [remote];
}

module.exports = { getRemoteUser, setRemoteUser, canPair, peersOf };
```

`db/init.js`: 先頭付近の`require`群に `const { ensureChatSchema } = require('../lib/chatSchema');` を追加し、`email`列マイグレーションのブロックの直後に次を追加する。

```js
ensureChatSchema(db);
```

`routes/users.js`: 先頭に `const { setRemoteUser } = require('../lib/chatRules');` を追加。`USER_LIST_SELECT` の列に `is_remote` を追加し、ユーザー削除ルートの直前に次を追加する。

```js
const USER_LIST_SELECT = 'SELECT id, user_id, display_name, role, email, is_remote, created_at FROM users ORDER BY id';
```
（既存の同名定数を上記に置き換える。）

```js
// 在宅フラグの設定／解除（常に1人だけ）
router.post('/users/:id/remote', requireLogin, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const turnOn = req.body.remote === '1';
  setRemoteUser(db, turnOn ? id : null);
  res.redirect('/users');
});
```

`views/users/list.ejs`: `<th>権限変更</th>` の直後に `<th>在宅</th>` を、対応する行の「権限変更」`<td>`の直後に次を追加する。

```html
          <td>
            <form method="POST" action="/users/<%= u.id %>/remote" class="form-inline"<% if (!u.is_remote) { %> data-confirm="<%= u.display_name %>さんを在宅に設定します（前の在宅設定は解除されます）"<% } %>>
              <% if (u.is_remote) { %>
                <span class="badge member">在宅</span>
                <input type="hidden" name="remote" value="0" />
                <button type="submit" class="mini-btn">解除</button>
              <% } else { %>
                <input type="hidden" name="remote" value="1" />
                <button type="submit" class="mini-btn">在宅にする</button>
              <% } %>
            </form>
          </td>
```

（`data-confirm`は`<form>`に付ける仕組みのため、上記のとおり`<form>`側に置いている。`footer.ejs`のsubmitハンドラが確認ダイアログを出す。）

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（4件）

- [ ] **Step 5: ローカルのDBに反映して画面を確認し、コミットする**

Run: `node db/init.js`（`is_remote`列と`chat_messages`表が追加される。既存データは消えない）
`node server.js` を起動し、`admin`でログイン→`/users`で「在宅」列が出て、「在宅にする」で設定・解除できることを確認する。

```bash
git add lib/chatSchema.js lib/chatRules.js tests/chatRules.test.js db/init.js package.json routes/users.js views/users/list.ejs
git commit -m "チャットの土台（在宅フラグ・チャット用テーブル・ペア判定）を追加"
```

---

### Task 2: メッセージの保存・取得

**Files:**
- Create: `lib/chatStore.js`
- Create: `tests/chatStore.test.js`

**Interfaces:**
- Consumes: `ensureChatSchema`（Task 1）
- Produces:
  - `MAX_BODY: 2000`
  - `saveMessage(db, fromUserId, toUserId, body): Message`（空・超過は`Error('empty')`／`Error('too_long')`を投げる。本文は前後の空白を除去して保存）
  - `listMessages(db, userIdA, userIdB, limit = 100): Message[]`（古い順）
  - `markRead(db, readerUserId, fromUserId): void`
  - `unreadCounts(db, userId): { [senderUserId]: number }`
  - `Message = { id, sender_id, receiver_id, body, created_at /* JST表示 */, read: boolean }`

- [ ] **Step 1: 失敗するテストを書く**

`tests/chatStore.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const store = require('../lib/chatStore');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensureChatSchema(db);
  return db;
}

test('保存した本文は前後の空白が除かれ、JST表示の時刻が付く', () => {
  const db = makeDb();
  const m = store.saveMessage(db, 'home', 'a', '  こんにちは  ');
  assert.strictEqual(m.body, 'こんにちは');
  assert.strictEqual(m.sender_id, 'home');
  assert.strictEqual(m.read, false);
  assert.match(m.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('空と2000文字超は拒否する', () => {
  const db = makeDb();
  assert.throws(() => store.saveMessage(db, 'home', 'a', '   '), /empty/);
  assert.throws(() => store.saveMessage(db, 'home', 'a', undefined), /empty/);
  assert.throws(() => store.saveMessage(db, 'home', 'a', 'あ'.repeat(2001)), /too_long/);
  assert.doesNotThrow(() => store.saveMessage(db, 'home', 'a', 'あ'.repeat(2000)));
});

test('HTMLを含む本文もそのまま保存する（表示側でテキスト扱い）', () => {
  const db = makeDb();
  const m = store.saveMessage(db, 'a', 'home', '<script>alert(1)</script>');
  assert.strictEqual(m.body, '<script>alert(1)</script>');
});

test('一覧は2人の間の会話だけを古い順に返す', () => {
  const db = makeDb();
  store.saveMessage(db, 'home', 'a', '1');
  store.saveMessage(db, 'a', 'home', '2');
  store.saveMessage(db, 'home', 'b', '別の人');
  const list = store.listMessages(db, 'home', 'a');
  assert.deepStrictEqual(list.map((m) => m.body), ['1', '2']);
});

test('一覧はlimit件の最新分を返す', () => {
  const db = makeDb();
  for (let i = 1; i <= 5; i++) store.saveMessage(db, 'home', 'a', String(i));
  assert.deepStrictEqual(store.listMessages(db, 'home', 'a', 3).map((m) => m.body), ['3', '4', '5']);
});

test('未読数は受信者ごと・送信者ごとに数え、既読にすると減る', () => {
  const db = makeDb();
  store.saveMessage(db, 'a', 'home', 'x');
  store.saveMessage(db, 'a', 'home', 'y');
  store.saveMessage(db, 'b', 'home', 'z');
  store.saveMessage(db, 'home', 'a', '自分が送ったもの');
  assert.deepStrictEqual(store.unreadCounts(db, 'home'), { a: 2, b: 1 });
  store.markRead(db, 'home', 'a');
  assert.deepStrictEqual(store.unreadCounts(db, 'home'), { b: 1 });
  assert.deepStrictEqual(store.unreadCounts(db, 'a'), { home: 1 });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/chatStore'`）

- [ ] **Step 3: 最小の実装を書く**

`lib/chatStore.js`:

```js
const { formatJst } = require('./jst');

const MAX_BODY = 2000;

function toMessage(row) {
  return {
    id: row.id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id,
    body: row.body,
    created_at: formatJst(row.created_at),
    read: !!row.read_at,
  };
}

function saveMessage(db, fromUserId, toUserId, body) {
  const text = String(body === undefined || body === null ? '' : body).trim();
  if (!text) throw new Error('empty');
  if (text.length > MAX_BODY) throw new Error('too_long');
  const result = db
    .prepare('INSERT INTO chat_messages (sender_id, receiver_id, body) VALUES (?, ?, ?)')
    .run(fromUserId, toUserId, text);
  return toMessage(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(result.lastInsertRowid));
}

function listMessages(db, userIdA, userIdB, limit = 100) {
  const rows = db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY id DESC LIMIT ?`
    )
    .all(userIdA, userIdB, userIdB, userIdA, limit);
  return rows.reverse().map(toMessage);
}

function markRead(db, readerUserId, fromUserId) {
  db.prepare(
    "UPDATE chat_messages SET read_at = datetime('now') WHERE receiver_id = ? AND sender_id = ? AND read_at IS NULL"
  ).run(readerUserId, fromUserId);
}

function unreadCounts(db, userId) {
  const rows = db
    .prepare(
      'SELECT sender_id, COUNT(*) AS c FROM chat_messages WHERE receiver_id = ? AND read_at IS NULL GROUP BY sender_id'
    )
    .all(userId);
  return Object.fromEntries(rows.map((r) => [r.sender_id, r.c]));
}

module.exports = { MAX_BODY, saveMessage, listMessages, markRead, unreadCounts };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（Task 1の4件＋6件）

- [ ] **Step 5: コミットする**

```bash
git add lib/chatStore.js tests/chatStore.test.js
git commit -m "チャットメッセージの保存・取得・既読・未読数を追加"
```

---

### Task 3: 中継ハブ（権限・オンライン状態・音声シグナル）

**Files:**
- Create: `lib/chatHub.js`
- Create: `tests/chatHub.test.js`

**Interfaces:**
- Consumes: `canPair`, `peersOf`（Task 1）、`saveMessage`, `markRead`（Task 2）
- Produces: `createHub(db)` → `{ connect(userId, socket), disconnect(userId, socket), handle(userId, socket, rawString) }`
  - `socket`は`send(string)`を持つ任意のオブジェクト（`readyState`があり1以外なら送らない）。`connect`は`socket.cid`（接続番号）を付与する。
  - クライアント→サーバー: `{type:'chat', to, body}` / `{type:'read', from}` / `{type:'ptt', to, on}` / `{type:'signal', to, data}`
  - サーバー→クライアント:
    - `{type:'presence', online: {[userId]: cid}}`（相手として話せる人のうち、オンラインの人だけ。値は最新の接続番号）
    - `{type:'chat', message: Message}`（受信者の全接続と、送信者の全接続に送る）
    - `{type:'read', by: userId}`
    - `{type:'ptt', from: userId, on: boolean}`（相手の最新の接続にだけ）
    - `{type:'signal', from: userId, data}`（相手の最新の接続にだけ）
    - `{type:'error', code: 'forbidden' | 'empty' | 'too_long'}`（送信者のその接続に返す）

- [ ] **Step 1: 失敗するテストを書く**

`tests/chatHub.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const { createHub } = require('../lib/chatHub');

function makeEnv() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensureChatSchema(db);
  for (const uid of ['home', 'a', 'b']) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, uid);
  }
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id = 'home'").get().id);
  return { db, hub: createHub(db) };
}
function fakeSocket() {
  const s = { sent: [], send(d) { s.sent.push(JSON.parse(d)); } };
  s.of = (type) => s.sent.filter((m) => m.type === type);
  return s;
}
const send = (hub, uid, sock, obj) => hub.handle(uid, sock, JSON.stringify(obj));

test('在宅→社内のチャットは保存され、双方の全接続に届く', () => {
  const { hub } = makeEnv();
  const home1 = fakeSocket(), home2 = fakeSocket(), a = fakeSocket();
  hub.connect('home', home1); hub.connect('home', home2); hub.connect('a', a);
  send(hub, 'home', home1, { type: 'chat', to: 'a', body: 'おはよう' });
  assert.strictEqual(a.of('chat')[0].message.body, 'おはよう');
  assert.strictEqual(home1.of('chat').length, 1);
  assert.strictEqual(home2.of('chat').length, 1);
});

test('社内同士のチャット・ptt・signalは拒否され、相手に何も届かない', () => {
  const { hub } = makeEnv();
  const a = fakeSocket(), b = fakeSocket();
  hub.connect('a', a); hub.connect('b', b);
  send(hub, 'a', a, { type: 'chat', to: 'b', body: 'こそこそ' });
  send(hub, 'a', a, { type: 'ptt', to: 'b', on: true });
  send(hub, 'a', a, { type: 'signal', to: 'b', data: { x: 1 } });
  assert.strictEqual(a.of('error').length, 3);
  assert.strictEqual(a.of('error')[0].code, 'forbidden');
  assert.strictEqual(b.of('chat').length, 0);
  assert.strictEqual(b.of('ptt').length, 0);
  assert.strictEqual(b.of('signal').length, 0);
});

test('空・長すぎる本文はエラーを返し、保存も配信もしない', () => {
  const { hub, db } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'chat', to: 'a', body: '  ' });
  send(hub, 'home', home, { type: 'chat', to: 'a', body: 'あ'.repeat(2001) });
  assert.deepStrictEqual(home.of('error').map((e) => e.code), ['empty', 'too_long']);
  assert.strictEqual(a.of('chat').length, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_messages').get().c, 0);
});

test('不正なJSON・未知のtypeは無視する（落ちない）', () => {
  const { hub } = makeEnv();
  const home = fakeSocket();
  hub.connect('home', home);
  assert.doesNotThrow(() => hub.handle('home', home, 'これはJSONではない'));
  assert.doesNotThrow(() => send(hub, 'home', home, { type: 'unknown' }));
  assert.doesNotThrow(() => send(hub, 'home', home, null));
});

test('オンライン状態は話せる相手の分だけ、最新の接続番号つきで届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a = fakeSocket(), b = fakeSocket();
  hub.connect('home', home);
  hub.connect('a', a);
  hub.connect('b', b);
  const last = (s) => s.of('presence').at(-1).online;
  assert.deepStrictEqual(Object.keys(last(home)).sort(), ['a', 'b']);
  assert.deepStrictEqual(Object.keys(last(a)), ['home']);   // 社内のaに、社内のbは見えない
  assert.strictEqual(last(a).home, home.cid);
});

test('複数タブ: 1つ閉じてもオンラインのまま、全部閉じるとオフライン', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2);
  hub.disconnect('a', a1);
  assert.ok('a' in home.of('presence').at(-1).online);
  hub.disconnect('a', a2);
  assert.ok(!('a' in home.of('presence').at(-1).online));
});

test('音声シグナルとpttは、相手の最新の接続にだけ届く', () => {
  const { hub } = makeEnv();
  const home = fakeSocket(), a1 = fakeSocket(), a2 = fakeSocket();
  hub.connect('home', home); hub.connect('a', a1); hub.connect('a', a2);
  send(hub, 'home', home, { type: 'signal', to: 'a', data: { sdp: 'offer' } });
  send(hub, 'home', home, { type: 'ptt', to: 'a', on: true });
  assert.strictEqual(a1.of('signal').length, 0);
  assert.deepStrictEqual(a2.of('signal')[0], { type: 'signal', from: 'home', data: { sdp: 'offer' } });
  assert.deepStrictEqual(a2.of('ptt')[0], { type: 'ptt', from: 'home', on: true });
});

test('既読にすると送信者に通知され、未読が消える', () => {
  const { hub, db } = makeEnv();
  const home = fakeSocket(), a = fakeSocket();
  hub.connect('home', home); hub.connect('a', a);
  send(hub, 'home', home, { type: 'chat', to: 'a', body: 'x' });
  send(hub, 'a', a, { type: 'read', from: 'home' });
  assert.deepStrictEqual(home.of('read')[0], { type: 'read', by: 'a' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM chat_messages WHERE read_at IS NULL').get().c, 0);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm test`
Expected: FAIL（`Cannot find module '../lib/chatHub'`）

- [ ] **Step 3: 最小の実装を書く**

`lib/chatHub.js`:

```js
const { canPair, peersOf } = require('./chatRules');
const store = require('./chatStore');

// 接続の管理と、メッセージ・音声シグナルの中継。
// socketは send(string) を持つ任意のオブジェクト（本番はws、テストは偽物）。
function createHub(db) {
  const sockets = new Map(); // user_id -> Set<socket>（追加順。最後が最新の接続）
  let nextCid = 1;

  function deliver(socket, payload) {
    if (socket.readyState !== undefined && socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  }
  function sendToAll(userId, payload) {
    for (const s of sockets.get(userId) || []) deliver(s, payload);
  }
  function sendToLatest(userId, payload) {
    const set = sockets.get(userId);
    if (!set || set.size === 0) return;
    deliver([...set].at(-1), payload);
  }
  function latestCid(userId) {
    const set = sockets.get(userId);
    return set && set.size ? [...set].at(-1).cid : null;
  }

  function broadcastPresence() {
    for (const userId of sockets.keys()) {
      const online = {};
      for (const peer of peersOf(db, userId)) {
        const cid = latestCid(peer.user_id);
        if (cid !== null) online[peer.user_id] = cid;
      }
      sendToAll(userId, { type: 'presence', online });
    }
  }

  function connect(userId, socket) {
    socket.cid = nextCid++;
    if (!sockets.has(userId)) sockets.set(userId, new Set());
    sockets.get(userId).add(socket);
    broadcastPresence();
  }

  function disconnect(userId, socket) {
    const set = sockets.get(userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) sockets.delete(userId);
    broadcastPresence();
  }

  function handle(userId, socket, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const forbid = () => deliver(socket, { type: 'error', code: 'forbidden' });

    switch (msg.type) {
      case 'chat': {
        if (!canPair(db, userId, msg.to)) return forbid();
        let message;
        try {
          message = store.saveMessage(db, userId, msg.to, msg.body);
        } catch (e) {
          return deliver(socket, { type: 'error', code: e.message });
        }
        sendToAll(msg.to, { type: 'chat', message });
        sendToAll(userId, { type: 'chat', message });
        return;
      }
      case 'read': {
        if (!canPair(db, userId, msg.from)) return forbid();
        store.markRead(db, userId, msg.from);
        sendToAll(msg.from, { type: 'read', by: userId });
        return;
      }
      case 'ptt': {
        if (!canPair(db, userId, msg.to)) return forbid();
        sendToLatest(msg.to, { type: 'ptt', from: userId, on: !!msg.on });
        return;
      }
      case 'signal': {
        if (!canPair(db, userId, msg.to)) return forbid();
        sendToLatest(msg.to, { type: 'signal', from: userId, data: msg.data });
        return;
      }
      default:
        return;
    }
  }

  return { connect, disconnect, handle };
}

module.exports = { createHub };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npm test`
Expected: PASS（全テスト）

- [ ] **Step 5: コミットする**

```bash
git add lib/chatHub.js tests/chatHub.test.js
git commit -m "チャットの中継ハブ（権限チェック・オンライン状態・音声シグナル）を追加"
```

---

### Task 4: サーバー接続（WebSocket・REST）

**Files:**
- Create: `lib/chatSocket.js`
- Create: `routes/chat.js`
- Create: `tests/chatRoutes.test.js`
- Modify: `server.js`
- Modify: `package.json`（`npm install ws`で追加される）
- Modify: `.env.example`

**Interfaces:**
- Consumes: `createHub`（Task 3）、`peersOf`, `getRemoteUser`, `canPair`（Task 1）、`listMessages`, `unreadCounts`（Task 2）
- Produces:
  - `attachChatSocket(server, sessionMiddleware, db): void` — `/ws/chat`でWebSocketを受け付ける（未ログインは401で拒否）。
  - `buildChatState(db, userId, env): { me:{user_id,display_name,isRemote}, remoteConfigured:boolean, peers:{user_id,display_name,unread}[], iceServers:object[] }`（`routes/chat.js`から`module.exports.buildChatState`として公開）
  - `GET /chat/state` → `buildChatState`のJSON
  - `GET /chat/messages/:peerUserId` → `{messages: Message[]}`（話せない相手なら403）

- [ ] **Step 1: 失敗するテストを書く**

`tests/chatRoutes.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');
const { saveMessage } = require('../lib/chatStore');
const { buildChatState } = require('../routes/chat');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL DEFAULT 'x', display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member')`);
  ensureChatSchema(db);
  for (const [uid, name] of [['home', '在宅'], ['a', '社内A'], ['b', '社内B']]) {
    db.prepare('INSERT INTO users (user_id, display_name) VALUES (?, ?)').run(uid, name);
  }
  return db;
}

test('在宅未設定ならremoteConfigured=false、相手なし', () => {
  const db = makeDb();
  const s = buildChatState(db, 'a', {});
  assert.strictEqual(s.remoteConfigured, false);
  assert.deepStrictEqual(s.peers, []);
});

test('在宅の人には社内全員（未読数つき）、社内の人には在宅1人が返る', () => {
  const db = makeDb();
  setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id='home'").get().id);
  saveMessage(db, 'a', 'home', 'x');
  const home = buildChatState(db, 'home', {});
  assert.strictEqual(home.me.isRemote, true);
  assert.deepStrictEqual(home.peers.map((p) => [p.user_id, p.unread]), [['a', 1], ['b', 0]]);
  const a = buildChatState(db, 'a', {});
  assert.strictEqual(a.me.isRemote, false);
  assert.deepStrictEqual(a.peers.map((p) => p.user_id), ['home']);
});

test('TURNの設定がある時だけiceServersに加わる（認証情報は環境変数から）', () => {
  const db = makeDb();
  const none = buildChatState(db, 'a', {});
  assert.deepStrictEqual(none.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  const withTurn = buildChatState(db, 'a', { TURN_URL: 'turn:example.test:3478', TURN_USER: 'u', TURN_PASS: 'p' });
  assert.deepStrictEqual(withTurn.iceServers[1], { urls: 'turn:example.test:3478', username: 'u', credential: 'p' });
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `npm install ws` の後に `npm test`
Expected: FAIL（`Cannot find module '../routes/chat'`）

- [ ] **Step 3: 実装を書く**

`routes/chat.js`:

```js
const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { getRemoteUser, canPair, peersOf } = require('../lib/chatRules');
const { listMessages, unreadCounts } = require('../lib/chatStore');

const router = express.Router();

function buildIceServers(env) {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (env.TURN_URL) {
    servers.push({ urls: env.TURN_URL, username: env.TURN_USER || '', credential: env.TURN_PASS || '' });
  }
  return servers;
}

function buildChatState(database, userId, env) {
  const remote = getRemoteUser(database);
  const me = database.prepare('SELECT user_id, display_name FROM users WHERE user_id = ?').get(userId);
  const unread = unreadCounts(database, userId);
  return {
    me: { user_id: me.user_id, display_name: me.display_name, isRemote: !!remote && remote.user_id === userId },
    remoteConfigured: !!remote,
    peers: peersOf(database, userId).map((p) => ({
      user_id: p.user_id,
      display_name: p.display_name,
      unread: unread[p.user_id] || 0,
    })),
    iceServers: buildIceServers(env),
  };
}

router.get('/chat/state', requireLogin, (req, res) => {
  res.json(buildChatState(db, req.session.user.user_id, process.env));
});

router.get('/chat/messages/:peerUserId', requireLogin, (req, res) => {
  const me = req.session.user.user_id;
  if (!canPair(db, me, req.params.peerUserId)) return res.status(403).json({ error: 'forbidden' });
  res.json({ messages: listMessages(db, me, req.params.peerUserId) });
});

module.exports = router;
module.exports.buildChatState = buildChatState;
```

`lib/chatSocket.js`:

```js
const { WebSocketServer } = require('ws');
const { createHub } = require('./chatHub');

// ws を既存のHTTPサーバーに同居させる。認証は既存のセッション（Cookie）を使う。
function attachChatSocket(server, sessionMiddleware, db) {
  const hub = createHub(db);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/chat') return socket.destroy();
    sessionMiddleware(req, {}, () => {
      const user = req.session && req.session.user;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (raw) => hub.handle(user.user_id, ws, raw.toString()));
        ws.on('close', () => hub.disconnect(user.user_id, ws));
        ws.on('error', () => {});
        hub.connect(user.user_id, ws);
      });
    });
  });

  // 30秒ごとに生存確認し、応答のない接続は切る（切れた接続を「オンライン」のまま残さない）
  const timer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  timer.unref();
}

module.exports = { attachChatSocket };
```

`server.js`:
- `const chatRoutes = require('./routes/chat');` と `const { attachChatSocket } = require('./lib/chatSocket');` を`require`群に追加。
- `app.use(session({...}))` を、変数に取り出して使う形に変更する。

```js
const sessionMiddleware = session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'db') }),
  secret: process.env.SESSION_SECRET || 'estowa-portal-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
  },
});
app.use(sessionMiddleware);
```
- `app.use(ideaRoutes);` の直後に `app.use(chatRoutes);` を追加。
- 末尾の `app.listen(...)` を次に置き換える。

```js
const server = app.listen(PORT, () => {
  console.log(`estowa社内ポータル起動: http://localhost:${PORT}`);
});
attachChatSocket(server, sessionMiddleware, db);
```

`.env.example` の末尾に追加:

```
# 音声通話のTURNサーバー（VPS移行後に設定。未設定ならSTUNのみで動作）
# TURN_URL=turn:turn.example.jp:3478
# TURN_USER=
# TURN_PASS=
```

- [ ] **Step 4: テストと起動を確認する**

Run: `npm test`
Expected: PASS（全テスト）

Run: `node server.js` を起動し、別のターミナルで未ログインの接続が拒否されることを確認する。
`node -e "const WebSocket=require('ws');const w=new WebSocket('ws://localhost:3000/ws/chat');w.on('error',e=>console.log('拒否:',e.message));w.on('open',()=>console.log('接続できてしまった'))"`
Expected: `拒否: Unexpected server response: 401`

- [ ] **Step 5: コミットする**

```bash
git add lib/chatSocket.js routes/chat.js tests/chatRoutes.test.js server.js package.json package-lock.json .env.example
git commit -m "チャットのWebSocket接続とREST（状態・履歴）を追加"
```

---

### Task 5: ホーム画面のテキストチャット

**Files:**
- Create: `views/partials/chat.ejs`
- Create: `public/js/chat.js`
- Modify: `views/home.ejs`
- Modify: `public/css/style.css`（末尾に追記）

**Interfaces:**
- Consumes: `GET /chat/state`、`GET /chat/messages/:peerUserId`、WebSocket（Task 3・4のメッセージ形式）
- Produces: `chat.js`内の`window.estowaChat = { send(obj), onSignal(handler), onPtt(handler), onPresence(handler), getState() }`（Task 6が音声に使う）。Task 5の段階では音声ボタンは出さない。

- [ ] **Step 1: チャット欄のHTMLを作る**

`views/partials/chat.ejs`:

```html
<div class="panel chat-panel" id="chat-root" hidden>
  <h2>チャット・通話</h2>
  <div class="chat-layout">
    <ul class="chat-peers" id="chat-peers"></ul>
    <div class="chat-thread">
      <div class="chat-thread-title" id="chat-title">相手を選んでください</div>
      <div class="chat-log" id="chat-log"></div>
      <div class="chat-error" id="chat-error" hidden></div>
      <form class="chat-form" id="chat-form">
        <input type="text" id="chat-input" maxlength="2000" autocomplete="off" placeholder="メッセージを入力" disabled />
        <button type="submit" id="chat-send" disabled>送信</button>
      </form>
    </div>
  </div>
</div>
<script src="/js/chat.js"></script>
```

`views/home.ejs`: `<div class="content-grid">` の直後の左カラム（`<div>` の中、`お知らせ`の`<div class="panel">`の前）に次を追加する。

```ejs
    <%- include('partials/chat') %>
```

- [ ] **Step 2: クライアントを書く（テキストのみ）**

`public/js/chat.js`:

```js
(function () {
  const root = document.getElementById('chat-root');
  if (!root) return;

  const peersEl = document.getElementById('chat-peers');
  const logEl = document.getElementById('chat-log');
  const titleEl = document.getElementById('chat-title');
  const errorEl = document.getElementById('chat-error');
  const formEl = document.getElementById('chat-form');
  const inputEl = document.getElementById('chat-input');
  const sendEl = document.getElementById('chat-send');

  const ERROR_TEXT = {
    forbidden: 'この相手には送れません',
    empty: 'メッセージが空です',
    too_long: 'メッセージが長すぎます（2000文字まで）',
  };

  let state = null;            // /chat/state の内容
  let online = {};             // user_id -> 接続番号
  let active = null;           // 開いている会話の相手 user_id
  let ws = null;
  let retry = 0;
  const handlers = { signal: [], ptt: [], presence: [] };
  const baseTitle = document.title;

  // 本文は必ず textContent で入れる（HTMLとして解釈させない）
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function showError(text) {
    errorEl.textContent = text || '';
    errorEl.hidden = !text;
  }
  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function peerName(userId) {
    const p = state.peers.find((x) => x.user_id === userId);
    return p ? p.display_name : userId;
  }
  function totalUnread() {
    return state.peers.reduce((n, p) => n + p.unread, 0);
  }
  function updateTabTitle() {
    const n = totalUnread();
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
  }

  function renderPeers() {
    peersEl.textContent = '';
    state.peers.forEach((p) => {
      const li = el('li', 'chat-peer' + (p.user_id === active ? ' active' : ''));
      li.dataset.userId = p.user_id;
      li.appendChild(el('span', 'chat-dot' + (online[p.user_id] ? ' on' : '')));
      const name = el('span', 'chat-peer-name', p.display_name);
      name.addEventListener('click', () => openConversation(p.user_id));
      li.appendChild(name);
      if (p.unread > 0) li.appendChild(el('span', 'chat-unread', String(p.unread)));
      peersEl.appendChild(li);
    });
    updateTabTitle();
    if (window.estowaChat && window.estowaChat.afterRenderPeers) window.estowaChat.afterRenderPeers(peersEl);
  }

  function appendMessage(m) {
    const mine = m.sender_id === state.me.user_id;
    const row = el('div', 'chat-msg ' + (mine ? 'mine' : 'theirs'));
    row.appendChild(el('div', 'chat-bubble', m.body));
    row.appendChild(el('div', 'chat-time', m.created_at));
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function openConversation(userId) {
    active = userId;
    titleEl.textContent = peerName(userId) + ' さんとのチャット';
    inputEl.disabled = false;
    sendEl.disabled = false;
    logEl.textContent = '';
    showError('');
    const res = await fetch('/chat/messages/' + encodeURIComponent(userId));
    if (!res.ok) return showError('履歴を読み込めませんでした');
    const { messages } = await res.json();
    if (active !== userId) return;
    messages.forEach(appendMessage);
    markActiveRead();
    renderPeers();
  }

  function markActiveRead() {
    const p = state.peers.find((x) => x.user_id === active);
    if (!p) return;
    p.unread = 0;
    send({ type: 'read', from: active });
    updateTabTitle();
  }

  function onChat(m) {
    const mine = m.sender_id === state.me.user_id;
    const other = mine ? m.receiver_id : m.sender_id;
    if (other === active) {
      appendMessage(m);
      if (!mine) markActiveRead();
    } else if (!mine) {
      const p = state.peers.find((x) => x.user_id === other);
      if (p) p.unread += 1;
    }
    renderPeers();
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/chat');
    ws.onopen = () => {
      retry = 0;
      showError('');
      if (active) openConversation(active); // 切断中の取りこぼしを読み直す
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'chat') onChat(msg.message);
      else if (msg.type === 'presence') {
        online = msg.online || {};
        renderPeers();
        handlers.presence.forEach((h) => h(online));
      } else if (msg.type === 'signal') handlers.signal.forEach((h) => h(msg.from, msg.data));
      else if (msg.type === 'ptt') handlers.ptt.forEach((h) => h(msg.from, msg.on));
      else if (msg.type === 'error') showError(ERROR_TEXT[msg.code] || 'エラーが発生しました');
    };
    ws.onclose = () => {
      online = {};
      renderPeers();
      handlers.presence.forEach((h) => h(online));
      showError('接続が切れました。再接続しています…');
      retry += 1;
      setTimeout(connect, Math.min(10000, 1000 * retry));
    };
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = inputEl.value.trim();
    if (!body || !active) return;
    send({ type: 'chat', to: active, body });
    inputEl.value = '';
  });

  window.estowaChat = {
    send,
    getState: () => state,
    onSignal: (h) => handlers.signal.push(h),
    onPtt: (h) => handlers.ptt.push(h),
    onPresence: (h) => handlers.presence.push(h),
    isOnline: (userId) => !!online[userId],
    onlineCid: (userId) => online[userId],
    afterRenderPeers: null,
  };

  (async function init() {
    const res = await fetch('/chat/state');
    if (!res.ok) return;
    state = await res.json();
    if (!state.remoteConfigured || state.peers.length === 0) return; // 在宅未設定の間は出さない
    root.hidden = false;
    renderPeers();
    if (state.peers.length === 1) openConversation(state.peers[0].user_id);
    connect();
  })();
})();
```

`public/css/style.css` の末尾に追記:

```css
/* ---- チャット・通話 ---- */
.chat-layout { display: grid; grid-template-columns: 200px 1fr; gap: 14px; }
.chat-peers { list-style: none; margin: 0; padding: 0; }
.chat-peer { display: flex; align-items: center; gap: 8px; padding: 8px 6px; border-bottom: 1px solid var(--border); font-size: 14px; }
.chat-peer.active { background: rgba(0,0,0,0.04); border-radius: 6px; }
.chat-peer-name { cursor: pointer; flex: 1; }
.chat-dot { width: 9px; height: 9px; border-radius: 50%; background: #c9ccd6; flex: none; }
.chat-dot.on { background: #2fb344; }
.chat-unread { background: #e0245e; color: #fff; border-radius: 10px; font-size: 11px; padding: 1px 7px; }
.chat-thread-title { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; }
.chat-log { height: 280px; overflow-y: auto; border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: #fafbfd; }
.chat-msg { margin-bottom: 10px; display: flex; flex-direction: column; }
.chat-msg.mine { align-items: flex-end; }
.chat-msg.theirs { align-items: flex-start; }
.chat-bubble { max-width: 80%; padding: 8px 12px; border-radius: 12px; font-size: 14px; white-space: pre-wrap; word-break: break-word; background: #fff; border: 1px solid var(--border); }
.chat-msg.mine .chat-bubble { background: var(--primary); color: #fff; border-color: var(--primary); }
.chat-time { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.chat-form { display: flex; gap: 8px; margin-top: 8px; }
.chat-form input { flex: 1; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; }
.chat-form button { padding: 8px 16px; background: var(--primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
.chat-form button:disabled, .chat-form input:disabled { opacity: 0.5; cursor: not-allowed; }
.chat-error { color: #e0245e; font-size: 12px; margin-top: 6px; }
```

- [ ] **Step 3: ダミーアカウントを用意する**

`db/seed-chat-dummy.js`:

```js
// ローカル確認用のダミーアカウントを作る（本番では実行しない）
const bcrypt = require('bcryptjs');
const db = require('./connection');
const { ensureChatSchema } = require('../lib/chatSchema');
const { setRemoteUser } = require('../lib/chatRules');

if (process.env.NODE_ENV === 'production') {
  console.error('本番環境では実行できません');
  process.exit(1);
}

ensureChatSchema(db);
const hash = bcrypt.hashSync('dummy1234', 10);
const dummies = [
  ['chat_home', '在宅ダミー'],
  ['chat_a', '社内ダミーA'],
  ['chat_b', '社内ダミーB'],
  ['chat_c', '社内ダミーC'],
  ['chat_d', '社内ダミーD'],
];
for (const [userId, name] of dummies) {
  if (!db.prepare('SELECT 1 FROM users WHERE user_id = ?').get(userId)) {
    db.prepare("INSERT INTO users (user_id, password_hash, display_name, role) VALUES (?, ?, ?, 'member')").run(userId, hash, name);
  }
}
setRemoteUser(db, db.prepare("SELECT id FROM users WHERE user_id = 'chat_home'").get().id);
console.log('ダミーアカウントを作成しました（パスワードはすべて dummy1234）。在宅は chat_home です');
```

Run: `node db/seed-chat-dummy.js`

- [ ] **Step 4: 画面で確認する（手動）**

`node server.js` を起動し、ブラウザの**別プロファイル／シークレット**で2つ開く（同じブラウザの別タブはCookieを共有して同じユーザーになるため）。
1. 片方で `chat_home`、もう片方で `chat_a` でログインし、ホームにチャット欄が出ることを確認する。
2. `chat_home` に社内4人が、`chat_a` に在宅1人が出ること。両方緑の点（オンライン）になること。
3. 送信が相手に即座に表示されること。`<b>テスト</b>` を送ると、タグがそのまま文字として表示されること。
4. 相手が別の人の会話を開いている時に送ると、未読バッジとタブ名の `(1)` が出て、会話を開くと消えること。
5. `chat_a` のタブを閉じると、`chat_home` 側で点が灰色になること。
6. サーバーを止めて再起動すると、約1〜10秒で自動再接続し、履歴が残っていること。
7. `chat_a` と `chat_b` が互いに見えないこと。

- [ ] **Step 5: コミットする**

```bash
git add views/partials/chat.ejs public/js/chat.js views/home.ejs public/css/style.css db/seed-chat-dummy.js
git commit -m "ホーム画面にテキストチャットを追加"
```

---

### Task 6: 音声（トランシーバー式）

**Files:**
- Modify: `views/partials/chat.ejs`（音声バーを追加）
- Create: `public/js/voice.js`
- Modify: `public/css/style.css`（追記）
- Modify: `views/partials/chat.ejs`（`voice.js`の読み込みを`chat.js`の後ろに追加）

**Interfaces:**
- Consumes: `window.estowaChat`（Task 5）。`getState()`、`send`、`onSignal`、`onPtt`、`onPresence`、`isOnline`、`onlineCid`、`afterRenderPeers`。
- Produces: なし（画面の機能のみ）

設計の要点:
- 在宅の人（`me.isRemote`）が、オンラインの相手それぞれに対してWebRTC接続を1本ずつ作る（offerを出す側）。社内の人は応答する側。
- 接続は常時張りっぱなし。音声トラックの向きは `sendrecv`。普段は送信トラックなし（`replaceTrack(null)`）。「話す」を押している間だけマイクのトラックを差し込む。
- 受信側の`<audio>`は普段 `muted`。相手の `ptt on` で、音声ONの場合だけ解除し、設定音量で鳴らす。
- 相手の接続番号（`onlineCid`）が変わったら（相手がタブを開き直した等）、在宅側が接続を作り直す。
- 話している途中にタブを離れた・ポインターが外れた場合は、必ず止める。

- [ ] **Step 1: 音声バーのHTMLを追加する**

`views/partials/chat.ejs` の `<h2>チャット・通話</h2>` の直後に追加:

```html
  <div class="voice-bar">
    <button type="button" id="voice-enable" class="voice-enable">音声ON</button>
    <label class="voice-volume">音量 <input type="range" id="voice-volume" min="0" max="100" value="80" /></label>
    <span class="voice-note" id="voice-note">先に「音声ON」を押してください。PCのミュートを解除し、音量を上げておいてください。</span>
  </div>
  <div class="voice-speaking" id="voice-speaking" hidden></div>
  <div class="voice-error" id="voice-error" hidden></div>
```

`<script src="/js/chat.js"></script>` の次の行に追加:

```html
<script src="/js/voice.js"></script>
```

- [ ] **Step 2: 音声クライアントを書く**

`public/js/voice.js`:

```js
(function () {
  const chat = window.estowaChat;
  const enableBtn = document.getElementById('voice-enable');
  if (!chat || !enableBtn) return;

  const volumeEl = document.getElementById('voice-volume');
  const noteEl = document.getElementById('voice-note');
  const speakingEl = document.getElementById('voice-speaking');
  const errorEl = document.getElementById('voice-error');

  let audioEnabled = false;
  let holding = null;          // 「話す」を押している相手
  let talking = null;          // { peerId, stream }
  const speaking = new Set();  // 今こちらに話しかけている相手
  const conns = new Map();     // peerId -> { pc, cid, audio, sender, pending }

  let volume = 0.8;
  try {
    const saved = parseFloat(localStorage.getItem('estowaVoiceVolume'));
    if (!Number.isNaN(saved)) volume = Math.min(1, Math.max(0, saved));
  } catch (e) { /* localStorageが使えなくても動く */ }
  volumeEl.value = String(Math.round(volume * 100));

  function me() { return chat.getState().me; }
  function nameOf(userId) {
    const p = chat.getState().peers.find((x) => x.user_id === userId);
    return p ? p.display_name : userId;
  }
  function showError(text) {
    errorEl.textContent = text || '';
    errorEl.hidden = !text;
  }

  // ---- 音声ON・音量 ----
  enableBtn.addEventListener('click', () => {
    audioEnabled = true;
    enableBtn.textContent = '音声ON済み';
    enableBtn.disabled = true;
    noteEl.textContent = 'PCの音量が小さい／ミュートの場合は、PC側で調整してください。';
    conns.forEach((c) => c.audio.play().catch(() => {}));
    renderSpeaking();
  });
  volumeEl.addEventListener('input', () => {
    volume = Number(volumeEl.value) / 100;
    conns.forEach((c) => { c.audio.volume = volume; });
    try { localStorage.setItem('estowaVoiceVolume', String(volume)); } catch (e) { /* 無視 */ }
  });

  function renderSpeaking() {
    if (speaking.size === 0) { speakingEl.hidden = true; return; }
    const names = [...speaking].map(nameOf).join('、');
    speakingEl.textContent = audioEnabled
      ? names + ' さんが話しています'
      : names + ' さんが話しています（「音声ON」を押すと聞こえます）';
    speakingEl.hidden = false;
  }

  // ---- WebRTC接続 ----
  function closeConn(peerId) {
    const c = conns.get(peerId);
    if (!c) return;
    conns.delete(peerId);
    try { c.pc.close(); } catch (e) { /* 無視 */ }
    c.audio.srcObject = null;
    c.audio.remove();
    if (speaking.delete(peerId)) renderSpeaking();
  }

  function createConn(peerId, cid, asOfferer) {
    closeConn(peerId);
    const pc = new RTCPeerConnection({ iceServers: chat.getState().iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = true;          // 相手が話している間だけ解除する
    audio.volume = volume;
    document.body.appendChild(audio);

    const conn = { pc, cid, audio, sender: null, pending: [] };
    if (asOfferer) conn.sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;

    pc.ontrack = (ev) => {
      audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      audio.play().catch(() => {});
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) chat.send({ type: 'signal', to: peerId, data: { candidate: ev.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (conns.get(peerId) !== conn) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closeConn(peerId);
        maybeOffer(peerId);
      }
    };
    conns.set(peerId, conn);
    return conn;
  }

  async function maybeOffer(peerId) {
    if (!me().isRemote || !chat.isOnline(peerId)) return;
    const cid = chat.onlineCid(peerId);
    const existing = conns.get(peerId);
    if (existing && existing.cid === cid &&
        !['failed', 'closed'].includes(existing.pc.connectionState)) return;
    try {
      const conn = createConn(peerId, cid, true);
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      chat.send({ type: 'signal', to: peerId, data: { sdp: conn.pc.localDescription } });
    } catch (e) {
      showError('通話の準備に失敗しました');
    }
  }

  async function flushPending(conn) {
    for (const cand of conn.pending.splice(0)) {
      try { await conn.pc.addIceCandidate(cand); } catch (e) { /* 古い候補は無視 */ }
    }
  }

  chat.onSignal(async (from, data) => {
    try {
      if (data && data.sdp && data.sdp.type === 'offer') {
        const conn = createConn(from, chat.onlineCid(from), false);
        await conn.pc.setRemoteDescription(data.sdp);
        const transceiver = conn.pc.getTransceivers()[0];
        transceiver.direction = 'sendrecv';
        conn.sender = transceiver.sender;
        await flushPending(conn);
        const answer = await conn.pc.createAnswer();
        await conn.pc.setLocalDescription(answer);
        chat.send({ type: 'signal', to: from, data: { sdp: conn.pc.localDescription } });
      } else if (data && data.sdp && data.sdp.type === 'answer') {
        const conn = conns.get(from);
        if (!conn) return;
        await conn.pc.setRemoteDescription(data.sdp);
        await flushPending(conn);
      } else if (data && data.candidate) {
        const conn = conns.get(from);
        if (!conn) return;
        if (conn.pc.remoteDescription) {
          try { await conn.pc.addIceCandidate(data.candidate); } catch (e) { /* 無視 */ }
        } else {
          conn.pending.push(data.candidate);
        }
      }
    } catch (e) {
      showError('通話の接続に失敗しました');
    }
  });

  chat.onPresence((online) => {
    // 相手がいなくなったら接続を片付ける
    [...conns.keys()].forEach((peerId) => { if (!online[peerId]) closeConn(peerId); });
    // 在宅側は、オンラインの相手に接続する（相手の接続番号が変わっていたら作り直す）
    if (me().isRemote) Object.keys(online).forEach((peerId) => maybeOffer(peerId));
  });

  // ---- 受信側: 相手が話している間だけ鳴らす ----
  chat.onPtt((from, on) => {
    const conn = conns.get(from);
    if (conn) {
      conn.audio.muted = !(on && audioEnabled);
      if (!conn.audio.muted) conn.audio.play().catch(() => {});
    }
    if (on) speaking.add(from); else speaking.delete(from);
    renderSpeaking();
  });

  // ---- 送信側: 「話す」ボタン ----
  async function startTalk(peerId) {
    showError('');
    holding = peerId;
    const conn = conns.get(peerId);
    if (!conn || conn.pc.connectionState !== 'connected' || !conn.sender) {
      holding = null;
      return showError('まだつながっていません。少し待ってからもう一度押してください');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      holding = null;
      return showError('マイクが使えません。ブラウザのアドレスバー左の鍵マークからマイクを「許可」にしてください');
    }
    if (holding !== peerId) { // 許可を待つ間にボタンが離された
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    await conn.sender.replaceTrack(stream.getAudioTracks()[0]);
    talking = { peerId, stream };
    chat.send({ type: 'ptt', to: peerId, on: true });
    setTalkingUi(peerId, true);
  }

  function stopTalk() {
    holding = null;
    if (!talking) return;
    const { peerId, stream } = talking;
    talking = null;
    stream.getTracks().forEach((t) => t.stop());
    const conn = conns.get(peerId);
    if (conn && conn.sender) conn.sender.replaceTrack(null).catch(() => {});
    chat.send({ type: 'ptt', to: peerId, on: false });
    setTalkingUi(peerId, false);
  }

  function setTalkingUi(peerId, on) {
    const btn = document.querySelector('.talk-btn[data-user-id="' + CSS.escape(peerId) + '"]');
    if (btn) btn.classList.toggle('talking', on);
  }

  // ボタンを、会話相手の一覧に差し込む（chat.jsが一覧を描き直すたびに呼ばれる）
  chat.afterRenderPeers = function (peersEl) {
    peersEl.querySelectorAll('.chat-peer').forEach((li) => {
      const peerId = li.dataset.userId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'talk-btn' + (talking && talking.peerId === peerId ? ' talking' : '');
      btn.dataset.userId = peerId;
      btn.textContent = '話す';
      btn.disabled = !chat.isOnline(peerId);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        startTalk(peerId);
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => btn.addEventListener(t, stopTalk));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      li.appendChild(btn);
    });
  };

  // 押しっぱなしの事故を防ぐ: タブを離れた・ページを閉じる時は必ず止める
  window.addEventListener('blur', stopTalk);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTalk(); });
  window.addEventListener('pagehide', stopTalk);

  // chat.jsが先に一覧を描いていた場合に備えて、1回描き直す
  const peersEl = document.getElementById('chat-peers');
  if (peersEl && peersEl.children.length) chat.afterRenderPeers(peersEl);
})();
```

`public/css/style.css` の末尾に追記:

```css
/* ---- 音声 ---- */
.voice-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 13px; }
.voice-enable { padding: 6px 14px; background: var(--primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; }
.voice-enable:disabled { background: #9aa0b4; cursor: default; }
.voice-note { color: var(--text-muted); font-size: 12px; }
.voice-speaking { background: #e8f7ec; color: #1d7a34; border-radius: 8px; padding: 6px 12px; font-size: 13px; margin-bottom: 10px; }
.voice-error { color: #e0245e; font-size: 12px; margin-bottom: 8px; }
.talk-btn { padding: 6px 12px; border: 1px solid var(--primary); background: #fff; color: var(--primary); border-radius: 8px; cursor: pointer; font-size: 13px; touch-action: none; user-select: none; }
.talk-btn.talking { background: #e0245e; border-color: #e0245e; color: #fff; }
.talk-btn:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 3: 画面で確認する（手動）**

`node server.js` を起動し、別プロファイル／シークレットで `chat_home` と `chat_a` にログインする。確認はヘッドホンで行う（スピーカーだとハウリングする）。
1. 両方のホームに音声バーと「話す」ボタンが出ること。相手がオフラインの間は「話す」が押せないこと。
2. 両方で「音声ON」を押し、`chat_home` で `社内ダミーA` の「話す」を押している間だけ、`chat_a` に声が届くこと。離すと止まること。最初のマイク許可ダイアログが出たら許可する。
3. 反対方向（`chat_a` → `chat_home`）も届くこと。
4. 「音声ON」を押していない側には声が鳴らず、「○○さんが話しています（『音声ON』を押すと聞こえます）」と表示されること。
5. 音量スライダーを動かすと音量が変わり、ページを再読み込みしても値が残ること。
6. 話している途中に別のウィンドウへ切り替える（タブを離れる）と、自動で止まること。
7. `chat_a` のタブを再読み込みしても、数秒で再接続し、また「話す」が使えること。
8. `chat_b` もログインした状態で、`chat_home` が `chat_a` と `chat_b` に交互に話せること。`chat_a` に話している声が `chat_b` には届かないこと。
9. 別のPC・別回線での確認は、VPS移行後（TURN設定後）に行う。この段階は同一PC内で確認する。

- [ ] **Step 4: コミットする**

```bash
git add views/partials/chat.ejs public/js/voice.js public/css/style.css
git commit -m "トランシーバー式の音声（話すボタン・音量・受信表示）を追加"
```

---

### Task 7: ドキュメント更新と最終確認

**Files:**
- Modify: `CLAUDE.md`（アーキテクチャ・機能一覧・保留中の項目）

- [ ] **Step 1: CLAUDE.mdを更新する**

「アーキテクチャ・実装パターン」の末尾に追加:

```
- **チャット・音声**: ホーム画面の`partials/chat.ejs`＋`public/js/chat.js`・`voice.js`。
  サーバーは`lib/chatSocket.js`（ws、`/ws/chat`、既存セッションで認証）→`lib/chatHub.js`
  （接続管理・中継）。会話できるのは「在宅フラグ（`users.is_remote`、常に1人）の人 ↔
  その他の各人」のみで、判定は`lib/chatRules.js`の`canPair`に集約している（社内同士は
  サーバー側で拒否）。音声は在宅側が各社内の人へWebRTCを1本ずつ常時接続し、「話す」を
  押している間だけ送信トラックを差し込む（録音・保存はしない）。複数タブで開いた場合、
  音声の接続情報は最新のタブにだけ届く。チャットはホーム画面を開いている間だけ動く。
  TURNは`.env`の`TURN_URL`/`TURN_USER`/`TURN_PASS`で設定（未設定ならSTUNのみ。
  別回線同士で繋がらない場合はTURNが必要）。HTTPS必須（マイク利用のため）。
  VPSでnginx等のリバースプロキシを使う場合は`/ws/chat`にUpgradeヘッダーを通す設定が必要。
  ローカル確認用のダミーアカウントは`node db/seed-chat-dummy.js`（本番では実行不可）。
```

「機能一覧」の末尾（`ユーザー管理・プロフィール（アバター設定）。` の前）に「ホーム画面のチャット・トランシーバー音声（在宅×社内）/ 」を追加する。

「保留中の項目」に追加:

```
- チャット・音声の本番化: VPS移行・独自ドメイン・HTTPS・TURN（coturn）の設定が未実施
  （Render上では同一回線内でのみ音声が確実に動く）
```

「テスト方法」の「自動テストは整備していない。」を、次の内容に置き換える。

```
自動テストは`npm test`（`node:test`、`tests/`配下）。チャットの権限・保存・中継のみ
カバーしている。それ以外は、変更後にローカルで一時サーバーを立て、curlまたは
Playwright（Chromiumは`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）で
実際に操作して確認してから報告する運用にしている。
```
（既存の文章の「自動テストは整備していない。変更後は〜報告する運用にしている。」の部分を上記に差し替える。）

- [ ] **Step 2: 全体を確認する**

Run: `npm test`
Expected: PASS（全テスト）

Task 5・6の手動確認をもう一度、最初から通しで行う（`node db/init.js` → `node db/seed-chat-dummy.js` → `node server.js`）。既存の画面（ホーム・タスク・お知らせ）が従来どおり開くことも確認する。

- [ ] **Step 3: コミットする（pushはしない）**

```bash
git add CLAUDE.md
git commit -m "チャット・音声のドキュメントを追加"
git status
```
Expected: 作業ツリーがクリーン。`git push`は人の承認後に行う。

---

## Self-Review

**Spec coverage**
- 星型・1対1・社内同士不可 → Task 1（`canPair`）・Task 3（サーバー拒否テスト）。
- 在宅フラグ（`is_remote`、常に1人、ユーザー管理で設定、未設定ならチャット欄なし）→ Task 1・Task 4（`remoteConfigured`）・Task 5（未設定なら非表示）。
- テキストチャット（保存・リアルタイム・未読バッジ）→ Task 2・3・5。
- オンライン／オフライン表示 → Task 3（presence）・Task 5（緑の点）。
- 音声（WebRTC直接、押している間だけ、自動受信）→ Task 6。
- 「音声ON」ボタン・音量スライダー・localStorage記憶・PC音量の案内・受信中だけ鳴らす → Task 6。
- 「○○さんが話しています」表示 → Task 6（`renderSpeaking`）。
- 相手がオフラインなら「話す」を無効化 → Task 6（`btn.disabled`）。
- マイク拒否・接続失敗・送信失敗の表示 → Task 5（再接続・エラー表示）・Task 6（`showError`）。
- ホーム画面への配置 → Task 5。
- ダミーアカウントでのテスト・権限の自動テスト → Task 1〜3・5。
- TURNは`.env` → Task 4。VPS・ドメイン・HTTPS設定は範囲外 → Task 7で保留中として記録。

**Spec との差分（要確認として明記）:** 「メッセージ送信失敗時は再送ボタン」は作っていない。送信はWebSocket経由で、失敗時は画面にエラー文を出すだけにした（送信欄の入力は消えるため、再入力が必要）。再送ボタンが必要なら追加タスクにする。

**Placeholder scan:** 「TBD」「あとで」等なし。全ステップにコードまたは具体的な手順がある。

**Type consistency:** `canPair`/`peersOf`/`setRemoteUser`（Task 1）、`saveMessage`/`listMessages`/`markRead`/`unreadCounts`（Task 2）、`createHub().connect/disconnect/handle`（Task 3）、`buildChatState`（Task 4）、`window.estowaChat`のメンバー（Task 5で定義・Task 6で使用: `getState/send/onSignal/onPtt/onPresence/isOnline/onlineCid/afterRenderPeers`）の名前と署名を、各タスク間で一致させた。メッセージ形式（`presence.online`が`{userId: cid}`）も、Task 3とTask 5・6で一致している。

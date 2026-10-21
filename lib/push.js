// プッシュ通知: 端末の登録、種類ごとのオン・オフ、送信
// db は呼び出し側から渡す（テストでは :memory: のDBと、setSender で差し替えた送信処理を使う）
const webpush = require('web-push');
const { unreadTotalSafe } = require('./badge');

// 通知の種類。defaultOn は、設定していない人の初期値
const KINDS = {
  task_added: { label: '自分が担当のタスクが追加されたとき', defaultOn: true },
  task_moved: { label: '自分が担当・作成したタスクのステータスが変わったとき', defaultOn: true },
  chat_new: { label: 'チャットの新着メッセージ（チャットを開いていないとき）', defaultOn: true },
  announcement_new: { label: '新しいお知らせが投稿されたとき', defaultOn: true },
};
const KIND_KEYS = Object.keys(KINDS);

const MAX_TITLE_IN_BODY = 40;

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

function isDisabled() {
  return process.env.PUSH_DISABLED === '1';
}

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return true;
  if (!isConfigured()) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

function publicKey() {
  return isConfigured() ? process.env.VAPID_PUBLIC_KEY : null;
}

// ---- 端末の登録 ----
// 受け取った登録情報が正しい形か（Push APIの subscription.toJSON() の形）
function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  const { endpoint, keys } = sub;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !/^https:\/\//.test(endpoint)) return false;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  return keys.p256dh.length <= 200 && keys.auth.length <= 100;
}

// 同じ端末（endpoint）が別のユーザーで登録されていたら、今のユーザーに付け替える
function saveSubscription(db, userId, sub) {
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

function removeSubscription(db, userId, endpoint) {
  return db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes;
}

function countSubscriptions(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(userId).n;
}

function hasSubscription(db, userId, endpoint) {
  return !!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').get(userId, endpoint);
}

// ---- 種類ごとのオン・オフ ----
function getPrefs(db, userId) {
  const rows = db.prepare('SELECT kind, enabled FROM notification_prefs WHERE user_id = ?').all(userId);
  const saved = Object.fromEntries(rows.map((r) => [r.kind, !!r.enabled]));
  return Object.fromEntries(KIND_KEYS.map((k) => [k, k in saved ? saved[k] : KINDS[k].defaultOn]));
}

function setPrefs(db, userId, enabledByKind) {
  const upsert = db.prepare(
    `INSERT INTO notification_prefs (user_id, kind, enabled) VALUES (?, ?, ?)
     ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled`
  );
  db.transaction(() => {
    for (const k of KIND_KEYS) upsert.run(userId, k, enabledByKind[k] ? 1 : 0);
  })();
}

// ---- 送信先 ----
// 候補（userIds）のうち、端末を登録していて、その種類をオンにしている人。exceptUserId（操作した本人）は除く
function recipientsAmong(db, kind, userIds, exceptUserId = null) {
  const wanted = [...new Set(userIds)].filter((id) => id && id !== exceptUserId);
  if (wanted.length === 0) return [];
  const marks = wanted.map(() => '?').join(',');
  const registered = new Set(
    db.prepare(`SELECT DISTINCT user_id FROM push_subscriptions WHERE user_id IN (${marks})`).all(...wanted).map((r) => r.user_id)
  );
  return wanted.filter((id) => registered.has(id) && getPrefs(db, id)[kind]);
}

function allUserIds(db) {
  return db.prepare('SELECT user_id FROM users').all().map((r) => r.user_id);
}

// ---- 送信 ----
// 実際の送信処理。テストでは setSender() で差し替える
let sender = (subscription, payload) => webpush.sendNotification(subscription, payload, { TTL: 60 * 60 });

function setSender(fn) {
  sender = fn;
}

function clip(text, max) {
  const chars = Array.from(text || '');
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text || '';
}

// 通知の中身。タイトルとステータスだけにとどめる（タスクやお知らせの本文は載せない）
function buildTaskAddedPayload(task) {
  return { title: '新しいタスク', body: clip(task.title, MAX_TITLE_IN_BODY), url: `/tasks/${task.id}`, tag: `task_added-${task.id}` };
}

function buildTaskMovedPayload(task, fromLabel, toLabel) {
  return {
    title: 'タスクが移動しました',
    body: `${clip(task.title, MAX_TITLE_IN_BODY)}（${fromLabel} → ${toLabel}）`,
    url: `/tasks/${task.id}`,
    tag: `task_moved-${task.id}`,
  };
}

// チャットは本文を載せない（誰からか、グループならどのグループか、だけ）
function buildChatPayload(senderName, groupName) {
  let body = 'メッセージがあります';
  if (groupName) body = `${clip(groupName, 20)}に新着メッセージがあります`;
  else if (senderName) body = `${clip(senderName, 20)}さんからメッセージがあります`;
  return { title: 'チャットの新着', body, url: '/', tag: 'chat_new' };
}

function buildAnnouncementPayload(announcement) {
  return {
    title: '新しいお知らせ',
    body: clip(announcement.title, MAX_TITLE_IN_BODY),
    url: `/announcements/${announcement.id}`,
    tag: `announcement_new-${announcement.id}`,
  };
}

// 1人のユーザーの全端末に送る。無効になった端末（404/410）は登録から外す。成功した件数を返す
async function sendToUser(db, userId, payload) {
  if (isDisabled() || !ensureVapid()) return 0;
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  // アイコンの赤い数字（その人の未読の合計）を一緒に送る。数えられないときは付けない
  const badge = payload.badge === undefined ? unreadTotalSafe(db, userId) : payload.badge;
  if (badge !== null && badge !== undefined) payload = { ...payload, badge };
  let sent = 0;
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      } else {
        console.error('[push] 通知の送信に失敗しました:', err && (err.statusCode || err.message));
      }
    }
  }
  return sent;
}

// 候補の中で、その種類を受け取る設定の人に送る。
// 通知の失敗で操作そのものを失敗させないよう、呼ぶ側は待たない。エラーはここで記録して握りつぶす
async function notify(db, kind, candidateUserIds, payload, exceptUserId = null) {
  try {
    let sent = 0;
    for (const userId of recipientsAmong(db, kind, candidateUserIds, exceptUserId)) sent += await sendToUser(db, userId, payload);
    return sent;
  } catch (err) {
    console.error('[push] 通知エラー:', err && err.message);
    return 0;
  }
}

module.exports = {
  KINDS,
  KIND_KEYS,
  isConfigured,
  isDisabled,
  publicKey,
  validateSubscription,
  saveSubscription,
  removeSubscription,
  countSubscriptions,
  hasSubscription,
  getPrefs,
  setPrefs,
  recipientsAmong,
  allUserIds,
  setSender,
  buildTaskAddedPayload,
  buildTaskMovedPayload,
  buildAnnouncementPayload,
  buildChatPayload,
  sendToUser,
  notify,
};

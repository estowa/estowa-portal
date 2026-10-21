// Service Worker。
// 1. ネットにつながらない時に、オフラインの案内を出す（画面のデータは保存しない。古い内容が出る事故を避けるため）
// 2. プッシュ通知を受け取って表示し、押されたらアプリを開く
const CACHE = 'portal-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- プッシュ通知 ----
// サーバーから { title, body, url, tag } が届く。受け取ったら必ず表示する（iPhoneの決まり）
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    Promise.all([
      updateBadge(data.badge),
      self.registration.showNotification(data.title || 'estowaポータル', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: data.tag || undefined,
        data: { url: data.url || '/' },
      }),
    ])
  );
});

// アイコンの赤い数字（未読の合計）を更新する。0なら消す。対応していない端末では何もしない
function updateBadge(count) {
  const nav = self.navigator;
  if (typeof count !== 'number' || !nav || !nav.setAppBadge) return Promise.resolve();
  const op = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge();
  return Promise.resolve(op).catch(() => {});
}

// 通知が押されたら、開いているアプリの画面を前に出して移動する。なければ新しく開く
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if ('focus' in w) {
          return w.focus().then((focused) => (focused && 'navigate' in focused ? focused.navigate(url) : focused));
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// ---- オフラインの案内 ----
// 画面の移動（ページの読み込み）だけを見る。失敗した時だけ、オフラインの案内に差し替える
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => caches.open(CACHE).then((cache) => cache.match(OFFLINE_URL)))
  );
});

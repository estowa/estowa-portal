const { WebSocketServer } = require('ws');
const { createHub } = require('./chatHub');
const push = require('./push');
const chatBus = require('./chatBus');

// ブラウザは必ずOriginを付ける。別サイトのページからの接続（Cookieを悪用したなりすまし）を断る。
// Originがない接続はブラウザ以外なので、Cookie悪用の対象にならず許可する。
function isAllowedOrigin(origin, host) {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch (e) {
    return false;
  }
}

// ws を既存のHTTPサーバーに同居させる。認証は既存のセッション（Cookie）を使う。
function attachChatSocket(server, sessionMiddleware, db) {
  // 受け取る人がチャットを開いていないときだけ、プッシュ通知を送る（本文は載せない）
  const hub = createHub(db, {
    // 着信の画面が見えていない相手には、プッシュ通知で知らせる（名前だけ載せる）
    onCallRing(fromUserId, toUserId) {
      const caller = db.prepare('SELECT display_name FROM users WHERE user_id = ?').get(fromUserId);
      push.notify(db, 'call_incoming', [toUserId], push.buildCallPayload(caller ? caller.display_name : ''), fromUserId);
    },
    // 既読にした端末を後から追えるように記録する（ユーザーID・部屋・端末の種類だけ。本文は記録しない）
    onRead(userId, roomId, socket) {
      console.log(`[chat] 既読 user=${userId} room=${roomId} ua=${socket.ua || '-'}`);
    },
    onOfflineMessage(message, offlineUserIds) {
      const room = db.prepare('SELECT kind, name FROM chat_rooms WHERE id = ?').get(message.room_id);
      push.notify(db, 'chat_new', offlineUserIds, push.buildChatPayload(message.sender_name, room && room.kind === 'group' ? room.name : ''), message.sender_id);
    },
  });
  chatBus.setHub(hub);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/chat') return socket.destroy();
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    sessionMiddleware(req, {}, () => {
      const user = req.session && req.session.user;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.ua = String(req.headers['user-agent'] || '').replace(/\s+/g, ' ').slice(0, 60);
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

module.exports = { attachChatSocket, isAllowedOrigin };

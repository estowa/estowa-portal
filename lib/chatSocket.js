const { WebSocketServer } = require('ws');
const { createHub } = require('./chatHub');

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
  const hub = createHub(db);
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

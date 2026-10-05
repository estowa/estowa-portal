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

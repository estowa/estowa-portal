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

const { canPair } = require('./chatRules');
const store = require('./chatStore');

// 接続の管理と、メッセージ・音声シグナルの中継。
// socketは send(string) を持つ任意のオブジェクト（本番はws、テストは偽物）。
// onOfflineMessage(message, offlineUserIds): 受け取る人がチャット画面を開いていない（接続がない）ときに呼ばれる（プッシュ通知用）
function createHub(db, { onOfflineMessage, onRead } = {}) {
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
  // その部屋を、今まさに画面で開いている接続があるか（見ていない人には、PCを開いていてもプッシュ通知を送る）
  function isViewing(userId, roomId) {
    return [...(sockets.get(userId) || [])].some((s) => s.viewingRoom === roomId);
  }
  function latestCid(userId) {
    const set = sockets.get(userId);
    return set && set.size ? [...set].at(-1).cid : null;
  }

  // オンライン状態は、つながっている全員の分を全員に送る（チャットは全員と話せるため）
  function broadcastPresence() {
    const online = {};
    for (const userId of sockets.keys()) online[userId] = latestCid(userId);
    for (const userId of sockets.keys()) sendToAll(userId, { type: 'presence', online });
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

  // 保存済みのメッセージを、部屋のメンバー全員の全接続へ配る。接続のないメンバーにはプッシュ通知
  function publish(message) {
    const members = store.memberIds(db, message.room_id);
    members.forEach((u) => sendToAll(u, { type: 'chat', message }));
    const offline = members.filter((u) => u !== message.sender_id && !isViewing(u, message.room_id));
    if (offline.length && onOfflineMessage) {
      try {
        onOfflineMessage(message, offline);
      } catch (e) {
        console.error('[chat] 通知エラー:', e.message);
      }
    }
  }

  // 部屋の作成・メンバー変更・名前変更を、関係する人の画面へ知らせる（一覧を取り直してもらう）
  function notifyRooms(userIds) {
    [...new Set(userIds)].forEach((u) => sendToAll(u, { type: 'rooms' }));
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
        let message;
        try {
          message = store.saveMessage(db, msg.room, userId, msg.body);
        } catch (e) {
          return deliver(socket, { type: 'error', code: e.message === 'forbidden' ? 'forbidden' : e.message });
        }
        publish(message);
        return;
      }
      case 'read': {
        if (!store.isMember(db, msg.room, userId)) return forbid();
        // 画面で見ていない端末（隠れたタブ・たたんだチャット）からの既読は受け付けない
        if (socket.viewingRoom !== msg.room) return;
        store.markRead(db, msg.room, userId);
        if (onRead) onRead(userId, msg.room, socket);
        return;
      }
      case 'viewing': {
        // 画面が見えていて、チャットを開いていて、この部屋を表示しているときだけ部屋のid。それ以外はnull
        socket.viewingRoom = Number.isInteger(msg.room) && store.isMember(db, msg.room, userId) ? msg.room : null;
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

  return { connect, disconnect, handle, publish, notifyRooms };
}

module.exports = { createHub };

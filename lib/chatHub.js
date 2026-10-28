const { canPair } = require('./chatRules');
const store = require('./chatStore');

// 接続の管理と、メッセージ・音声シグナルの中継。
// socketは send(string) を持つ任意のオブジェクト（本番はws、テストは偽物）。
// onOfflineMessage(message, offlineUserIds): 受け取る人がチャット画面を開いていない（接続がない）ときに呼ばれる（プッシュ通知用）
const RING_MS = 45 * 1000;          // 呼び出しに出ないときの時間切れ
const MAX_CALL_MS = 30 * 60 * 1000; // 通話の最大時間（切り忘れ防止）

function createHub(db, { onOfflineMessage, onRead, onCallRing, ringMs = RING_MS, maxCallMs = MAX_CALL_MS } = {}) {
  const sockets = new Map(); // user_id -> Set<socket>（追加順。最後が最新の接続）
  const calls = new Set();   // { from, to, state: 'ringing' | 'active', timer }
  let nextCid = 1;

  function deliver(socket, payload) {
    if (socket.readyState !== undefined && socket.readyState !== 1) return;
    socket.send(JSON.stringify(payload));
  }
  function sendToAll(userId, payload) {
    for (const s of sockets.get(userId) || []) deliver(s, payload);
  }
  // 通話の受け口: 「音声ON」を押した画面のうち最新のもの。なければ最新の接続
  function voiceSocket(userId) {
    const list = [...(sockets.get(userId) || [])];
    return [...list].reverse().find((s) => s.voiceReady) || list.at(-1) || null;
  }
  function sendToLatest(userId, payload) {
    const s = voiceSocket(userId);
    if (s) deliver(s, payload);
  }
  // その部屋を、今まさに画面で開いている接続があるか（見ていない人には、PCを開いていてもプッシュ通知を送る）
  function isViewing(userId, roomId) {
    return [...(sockets.get(userId) || [])].some((s) => s.viewingRoom === roomId);
  }
  function latestCid(userId) {
    const s = voiceSocket(userId);
    return s ? s.cid : null;
  }
  function isVoiceVisible(userId) {
    return [...(sockets.get(userId) || [])].some((s) => s.voiceVisible);
  }

  // ---- 通話（呼び出し→応答→終了）。声そのものはサーバーを通らない（WebRTC） ----
  function callOf(userId) {
    for (const c of calls) if (c.from === userId || c.to === userId) return c;
    return null;
  }
  function endCall(c, reason) {
    if (!calls.delete(c)) return;
    clearTimeout(c.timer);
    sendToAll(c.from, { type: 'call', action: 'ended', from: c.to, reason });
    sendToAll(c.to, { type: 'call', action: 'ended', from: c.from, reason });
  }
  function handleCall(userId, socket, msg) {
    const peer = msg.to;
    if (!canPair(db, userId, peer)) return deliver(socket, { type: 'error', code: 'forbidden' });
    const mine = callOf(userId);
    switch (msg.action) {
      case 'invite': {
        if (!(sockets.get(peer) || new Set()).size) {
          return deliver(socket, { type: 'call', action: 'ended', from: peer, reason: 'offline' });
        }
        if (mine || callOf(peer)) return deliver(socket, { type: 'call', action: 'ended', from: peer, reason: 'busy' });
        const c = { from: userId, to: peer, state: 'ringing', timer: null };
        c.timer = setTimeout(() => endCall(c, 'missed'), ringMs);
        c.timer.unref();
        calls.add(c);
        sendToLatest(peer, { type: 'call', action: 'invite', from: userId });
        if (!isVoiceVisible(peer) && onCallRing) {
          try {
            onCallRing(userId, peer);
          } catch (e) {
            console.error('[chat] 着信通知エラー:', e.message);
          }
        }
        return;
      }
      case 'accept': {
        if (!mine || mine.to !== userId || mine.from !== peer || mine.state !== 'ringing') return;
        clearTimeout(mine.timer);
        mine.state = 'active';
        mine.timer = setTimeout(() => endCall(mine, 'limit'), maxCallMs);
        mine.timer.unref();
        sendToLatest(peer, { type: 'call', action: 'accepted', from: userId });
        return;
      }
      case 'decline': {
        if (mine && mine.to === userId && mine.from === peer && mine.state === 'ringing') endCall(mine, 'declined');
        return;
      }
      case 'end': {
        if (mine && (mine.from === peer || mine.to === peer)) endCall(mine, 'ended');
        return;
      }
      default:
        return;
    }
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
    if (set.size === 0) {
      sockets.delete(userId);
      const c = callOf(userId);
      if (c) endCall(c, 'offline');
    }
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

  // 取り消しを、部屋のメンバー全員の全接続へ知らせる（通知は送らない）
  function publishDeleted(roomId, id) {
    store.memberIds(db, roomId).forEach((u) => sendToAll(u, { type: 'chat_deleted', room_id: roomId, id }));
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
      case 'voice': {
        // 通話の画面の状態: 音声ONか・画面が見えているか。受け口の選び方と、着信のプッシュ通知の判断に使う
        socket.voiceReady = !!msg.ready;
        socket.voiceVisible = !!msg.visible;
        broadcastPresence();
        return;
      }
      case 'call': {
        handleCall(userId, socket, msg);
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

  return { connect, disconnect, handle, publish, publishDeleted, notifyRooms };
}

module.exports = { createHub };

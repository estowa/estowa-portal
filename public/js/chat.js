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

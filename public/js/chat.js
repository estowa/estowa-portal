(function () {
  const root = document.getElementById('chat-root');
  if (!root) return;

  const groupsEl = document.getElementById('chat-groups');
  const peersEl = document.getElementById('chat-peers');
  const logEl = document.getElementById('chat-log');
  const titleEl = document.getElementById('chat-title');
  const errorEl = document.getElementById('chat-error');
  const formEl = document.getElementById('chat-form');
  const inputEl = document.getElementById('chat-input');
  const sendEl = document.getElementById('chat-send');
  const fileEl = document.getElementById('chat-file');
  const pickedEl = document.getElementById('chat-picked');
  const totalEl = document.getElementById('chat-total-unread');
  const settingsBtn = document.getElementById('chat-group-settings');
  const newGroupBtn = document.getElementById('chat-new-group');
  const chatBodyEl = document.getElementById('chat-body');

  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.com', '.php', '.js', '.jar', '.app'];
  const ERROR_TEXT = {
    forbidden: 'この会話には送れません',
    empty: 'メッセージが空です',
    too_long: 'メッセージが長すぎます（2000文字まで）',
    too_many_files: `添付は${MAX_FILES}つまでです`,
    name_required: 'グループ名を入力してください',
    name_too_long: 'グループ名が長すぎます（30文字まで）',
    members_required: 'メンバーを1人以上選んでください',
    unknown_member: '選んだ人が見つかりません',
  };

  let state = null;            // /chat/state の内容
  let online = {};             // user_id -> 接続番号
  let active = null;           // 開いている部屋のid
  let activeTitle = '';
  let shown = new Set();       // 画面に出したメッセージid（二重表示の防止）
  let picked = [];             // 添付に選んだファイル
  let ws = null;
  let retry = 0;
  let ready = false;
  const readyHandlers = [];
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
  function errText(code) { return ERROR_TEXT[code] || 'エラーが発生しました'; }
  function sizeText(n) {
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
    return Math.max(1, Math.round(n / 1024)) + 'KB';
  }

  function totalUnread() {
    return state.groups.reduce((n, g) => n + g.unread, 0) + state.dms.reduce((n, d) => n + d.unread, 0);
  }
  function updateUnreadViews() {
    const n = totalUnread();
    document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
    totalEl.textContent = n + '件の未読';
    totalEl.hidden = n === 0;
  }

  // ---- 一覧 ----
  function renderLists() {
    groupsEl.textContent = '';
    if (state.groups.length === 0) groupsEl.appendChild(el('li', 'chat-empty', 'まだありません'));
    state.groups.forEach((g) => {
      const li = el('li', 'chat-peer' + (g.room_id === active ? ' active' : ''));
      const name = el('span', 'chat-peer-name', g.name);
      name.addEventListener('click', () => openRoom(g.room_id, g.name, true));
      li.appendChild(name);
      li.appendChild(el('span', 'chat-count', g.members.length + '人'));
      if (g.unread > 0) li.appendChild(el('span', 'chat-unread', String(g.unread)));
      groupsEl.appendChild(li);
    });
    peersEl.textContent = '';
    state.dms.forEach((d) => {
      const li = el('li', 'chat-peer' + (d.room_id && d.room_id === active ? ' active' : ''));
      li.appendChild(el('span', 'chat-dot' + (online[d.user_id] ? ' on' : '')));
      const name = el('span', 'chat-peer-name', d.display_name);
      name.addEventListener('click', () => openDm(d));
      li.appendChild(name);
      if (d.unread > 0) li.appendChild(el('span', 'chat-unread', String(d.unread)));
      peersEl.appendChild(li);
    });
    updateUnreadViews();
  }

  async function fetchState() {
    const res = await fetch('/chat/state');
    if (!res.ok) return false;
    state = await res.json();
    return true;
  }
  async function refreshState() {
    if (await fetchState()) {
      // 開いている部屋が消えた（グループから抜けた）ら閉じる
      if (active && !state.groups.some((g) => g.room_id === active) && !state.dms.some((d) => d.room_id === active)) closeRoom();
      renderLists();
      renderSettingsButton();
      readyHandlers.forEach((h) => h());
    }
  }

  // ---- メッセージ ----
  function fileNode(f) {
    const url = '/chat/files/' + f.id;
    if (f.is_image) {
      const a = el('a', 'chat-img-link');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      const img = el('img', 'chat-img');
      img.src = url;
      img.alt = f.name;
      img.loading = 'lazy';
      a.appendChild(img);
      return a;
    }
    const a = el('a', 'chat-file', '📄 ' + f.name + '（' + sizeText(f.size) + '）');
    a.href = url;
    a.setAttribute('download', f.name);
    return a;
  }

  function appendMessage(m) {
    if (shown.has(m.id)) return;
    shown.add(m.id);
    const mine = m.sender_id === state.me.user_id;
    const row = el('div', 'chat-msg ' + (mine ? 'mine' : 'theirs'));
    if (!mine && activeIsGroup()) row.appendChild(el('div', 'chat-sender', m.sender_name));
    const bubble = el('div', 'chat-bubble');
    if (m.body) bubble.appendChild(el('div', 'chat-text', m.body));
    (m.files || []).forEach((f) => bubble.appendChild(fileNode(f)));
    row.appendChild(bubble);
    row.appendChild(el('div', 'chat-time', m.created_at));
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function activeIsGroup() {
    return !!state.groups.find((g) => g.room_id === active);
  }

  function closeRoom() {
    active = null;
    sendViewing();
    titleEl.textContent = '相手かグループを選んでください';
    logEl.textContent = '';
    inputEl.disabled = true;
    sendEl.disabled = true;
    settingsBtn.hidden = true;
    clearPicked();
  }

  async function openDm(d) {
    showError('');
    let roomId = d.room_id;
    if (!roomId) {
      const res = await fetch('/chat/dm/' + encodeURIComponent(d.user_id), { method: 'POST' });
      if (!res.ok) return showError('会話を開けませんでした');
      roomId = (await res.json()).room_id;
      d.room_id = roomId;
    }
    openRoom(roomId, d.display_name + ' さんとのチャット', false);
  }

  async function openRoom(roomId, title, isGroup) {
    active = roomId;
    sendViewing();
    activeTitle = isGroup ? 'グループ「' + title + '」' : title;
    titleEl.textContent = activeTitle;
    inputEl.disabled = false;
    sendEl.disabled = false;
    logEl.textContent = '';
    shown = new Set();
    showError('');
    renderSettingsButton();
    const res = await fetch('/chat/rooms/' + roomId + '/messages');
    if (!res.ok) return showError('履歴を読み込めませんでした');
    const { messages } = await res.json();
    if (active !== roomId) return;
    messages.forEach(appendMessage);
    markActiveRead();
    renderLists();
  }

  // サイドバー・アイコンの赤い数字を取り直す（既読・新着の反映を待ってから）
  let badgeTimer = null;
  function refreshBadgeSoon() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      if (window.refreshAppBadge) window.refreshAppBadge();
    }, 600);
  }

  function activeEntry() {
    return state.groups.find((x) => x.room_id === active) || state.dms.find((x) => x.room_id === active) || null;
  }
  function setUnread(roomId, n) {
    const g = state.groups.find((x) => x.room_id === roomId);
    if (g) g.unread = n;
    const d = state.dms.find((x) => x.room_id === roomId);
    if (d) d.unread = n;
  }
  // 画面が見えていて、チャットを開いていて、その部屋を表示しているときだけ「見ている」
  function isViewing() {
    return !!active && !document.hidden && !chatBodyEl.hidden;
  }
  function markActiveRead() {
    if (!isViewing()) return;
    setUnread(active, 0);
    send({ type: 'read', room: active });
    updateUnreadViews();
    refreshBadgeSoon();
  }

  function onChat(m) {
    const mine = m.sender_id === state.me.user_id;
    if (m.room_id === active) {
      appendMessage(m);
      if (mine) return;
      if (isViewing()) return markActiveRead();
      // 見ていない（隠れている・たたんでいる）ときは、未読のまま数える
      setUnread(active, (activeEntry() || { unread: 0 }).unread + 1);
      renderLists();
      refreshBadgeSoon();
      return;
    }
    if (mine) return;
    const known = state.groups.find((g) => g.room_id === m.room_id) || state.dms.find((d) => d.room_id === m.room_id);
    if (known) {
      known.unread += 1;
      renderLists();
      refreshBadgeSoon();
    } else {
      // まだ一覧にない部屋（初めての1対1・追加されたグループ）は、一覧を取り直す
      refreshState().then(refreshBadgeSoon);
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host + '/ws/chat');
    ws.onopen = () => {
      retry = 0;
      showError('');
      sendViewing();
      if (active) { // 切断中の取りこぼしを読み直す（未読の数も、サーバーの値に取り直す）
        refreshState().then(() => {
          const g = state.groups.find((x) => x.room_id === active);
          const d = state.dms.find((x) => x.room_id === active);
          if (g) openRoom(g.room_id, g.name, true);
          else if (d) openRoom(d.room_id, d.display_name + ' さんとのチャット', false);
        });
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'chat') onChat(msg.message);
      else if (msg.type === 'rooms') refreshState();
      else if (msg.type === 'presence') {
        online = msg.online || {};
        renderLists();
        handlers.presence.forEach((h) => h(online));
      } else if (msg.type === 'signal') handlers.signal.forEach((h) => h(msg.from, msg.data));
      else if (msg.type === 'ptt') handlers.ptt.forEach((h) => h(msg.from, msg.on));
      else if (msg.type === 'error') showError(errText(msg.code));
    };
    ws.onclose = () => {
      online = {};
      renderLists();
      handlers.presence.forEach((h) => h(online));
      showError('接続が切れました。再接続しています…');
      retry += 1;
      setTimeout(connect, Math.min(10000, 1000 * retry));
    };
  }

  // 「今この部屋を見ている」ことをサーバーへ伝える。見ていない部屋のメッセージは、PCを開いていてもプッシュ通知が届く
  function sendViewing() {
    const viewing = active && !document.hidden && !chatBodyEl.hidden;
    send({ type: 'viewing', room: viewing ? active : null });
    if (viewing) markActiveRead(); // 隠れていた画面を見た・チャットをひらいた、その時点で既読にする
  }
  document.addEventListener('visibilitychange', sendViewing);
  window.addEventListener('pagehide', () => send({ type: 'viewing', room: null }));
  window.addEventListener('pageshow', sendViewing);
  document.getElementById('chat-toggle').addEventListener('click', () => setTimeout(sendViewing, 0));

  // ---- 添付 ----
  function renderPicked() {
    pickedEl.textContent = '';
    pickedEl.hidden = picked.length === 0;
    picked.forEach((f, i) => {
      const chip = el('span', 'chat-chip', f.name + '（' + sizeText(f.size) + '）');
      const x = el('button', 'chat-chip-x', '×');
      x.type = 'button';
      x.setAttribute('aria-label', f.name + 'を外す');
      x.addEventListener('click', () => { picked.splice(i, 1); renderPicked(); });
      chip.appendChild(x);
      pickedEl.appendChild(chip);
    });
  }
  function clearPicked() { picked = []; fileEl.value = ''; renderPicked(); }

  function addFiles(list) {
    showError('');
    for (const f of Array.from(list)) {
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (BLOCKED_EXT.includes(ext)) { showError(f.name + ' は添付できない種類です'); continue; }
      if (f.size > MAX_FILE_SIZE) { showError(f.name + ' は大きすぎます（1ファイル10MBまで）'); continue; }
      if (picked.length >= MAX_FILES) { showError(ERROR_TEXT.too_many_files); break; }
      picked.push(f);
    }
    fileEl.value = '';
    renderPicked();
  }
  fileEl.addEventListener('change', () => addFiles(fileEl.files));

  // PC: チャット画面へのドラッグ＆ドロップでも添付できる（会話を開いているときだけ）
  const threadEl = document.querySelector('.chat-thread');
  const hint = el('div', 'chat-drop-hint', 'ここにドロップして添付');
  threadEl.appendChild(hint);
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  threadEl.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !active) return;
    e.preventDefault();
    dragDepth += 1;
    threadEl.classList.add('drag-over');
  });
  threadEl.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  threadEl.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) threadEl.classList.remove('drag-over');
  });
  threadEl.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // ブラウザがファイルを開いてしまうのを防ぐ
    dragDepth = 0;
    threadEl.classList.remove('drag-over');
    if (!active) return showError('先に、相手かグループを選んでください');
    addFiles(e.dataTransfer.files);
  });

  // メッセージ欄: Enterは改行（送信は「送信」ボタン）。入力に合わせて高さを広げる
  function fitInput() {
    inputEl.style.height = 'auto';
    const border = inputEl.offsetHeight - inputEl.clientHeight; // 枠線の分（これを足さないと、1行でもスクロールバーが出る）
    inputEl.style.height = Math.min(inputEl.scrollHeight + border, 140) + 'px';
  }
  inputEl.addEventListener('input', fitInput);
  fitInput();

  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = inputEl.value.trim();
    if ((!body && picked.length === 0) || !active) return;
    if (picked.length === 0) {
      send({ type: 'chat', room: active, body });
      inputEl.value = '';
      fitInput();
      return;
    }
    // 添付があるときはHTTPで送る（配信は、サーバーが他の人と自分の画面へ行う）
    const fd = new FormData();
    fd.append('body', body);
    picked.forEach((f) => fd.append('files', f));
    sendEl.disabled = true;
    try {
      const res = await fetch('/chat/rooms/' + active + '/messages', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return showError(data.message || errText(data.error));
      inputEl.value = '';
      fitInput();
      clearPicked();
      showError('');
      if (data.message && data.message.room_id === active) appendMessage(data.message);
    } catch (err) {
      showError('送信できませんでした。通信を確認してください');
    } finally {
      sendEl.disabled = !active;
    }
  });

  // ---- グループの作成・設定 ----
  const dialog = document.getElementById('chat-group-dialog');
  const dialogForm = document.getElementById('chat-group-form');
  const dialogTitle = document.getElementById('chat-group-dialog-title');
  const nameField = document.getElementById('chat-group-name-field');
  const nameInput = document.getElementById('chat-group-name');
  const currentWrap = document.getElementById('chat-group-current-wrap');
  const currentEl = document.getElementById('chat-group-current');
  const membersEl = document.getElementById('chat-group-members');
  const pickLabel = document.getElementById('chat-group-pick-label');
  const dialogError = document.getElementById('chat-group-error');
  const saveBtn = document.getElementById('chat-group-save');
  const leaveBtn = document.getElementById('chat-group-leave');
  let dialogMode = 'create'; // 'create' | 'edit'

  function dialogErr(text) {
    dialogError.textContent = text || '';
    dialogError.hidden = !text;
  }
  function renderMemberChoices(excludeIds) {
    membersEl.textContent = '';
    const candidates = state.dms.filter((d) => !excludeIds.includes(d.user_id));
    if (candidates.length === 0) membersEl.appendChild(el('div', 'chat-empty', '追加できる人がいません'));
    candidates.forEach((d) => {
      const label = el('label', 'chat-check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = d.user_id;
      label.appendChild(box);
      label.appendChild(el('span', '', d.display_name));
      membersEl.appendChild(label);
    });
  }
  function checkedMembers() {
    return Array.from(membersEl.querySelectorAll('input:checked')).map((b) => b.value);
  }

  newGroupBtn.addEventListener('click', () => {
    dialogMode = 'create';
    dialogTitle.textContent = 'グループを作る';
    nameField.hidden = false;
    nameInput.value = '';
    currentWrap.hidden = true;
    leaveBtn.hidden = true;
    pickLabel.textContent = 'メンバーを選ぶ（あなたは自動で入ります）';
    saveBtn.textContent = '作る';
    renderMemberChoices([]);
    dialogErr('');
    dialog.showModal();
  });

  function currentGroup() { return state.groups.find((g) => g.room_id === active) || null; }
  function renderSettingsButton() {
    settingsBtn.hidden = !currentGroup();
  }
  settingsBtn.addEventListener('click', () => {
    const g = currentGroup();
    if (!g) return;
    dialogMode = 'edit';
    dialogTitle.textContent = 'グループの設定';
    nameField.hidden = false;
    nameInput.value = g.name;
    currentWrap.hidden = false;
    currentEl.textContent = g.members.map((m) => m.display_name).join('、');
    leaveBtn.hidden = false;
    pickLabel.textContent = 'メンバーを追加する（追加前の発言も読めます）';
    saveBtn.textContent = '保存';
    renderMemberChoices(g.members.map((m) => m.user_id));
    dialogErr('');
    dialog.showModal();
  });

  async function postJson(url, data) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  }

  dialogForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    dialogErr('');
    const members = checkedMembers();
    if (dialogMode === 'create') {
      const r = await postJson('/chat/groups', { name: nameInput.value, members });
      if (!r.ok) return dialogErr(errText(r.body.error));
      dialog.close();
      await refreshState();
      const g = state.groups.find((x) => x.room_id === r.body.room_id);
      if (g) openRoom(g.room_id, g.name, true);
      return;
    }
    const g = currentGroup();
    if (!g) return dialog.close();
    if (nameInput.value.trim() !== g.name) {
      const r = await postJson('/chat/rooms/' + g.room_id + '/rename', { name: nameInput.value });
      if (!r.ok) return dialogErr(errText(r.body.error));
    }
    if (members.length) {
      const r = await postJson('/chat/rooms/' + g.room_id + '/members', { members });
      if (!r.ok) return dialogErr(errText(r.body.error));
    }
    dialog.close();
    await refreshState();
    const updated = currentGroup();
    if (updated) { activeTitle = 'グループ「' + updated.name + '」'; titleEl.textContent = activeTitle; }
  });

  leaveBtn.addEventListener('click', async () => {
    const g = currentGroup();
    if (!g || !window.confirm('グループ「' + g.name + '」から抜けますか？（抜けると、このグループの発言は読めなくなります）')) return;
    const r = await postJson('/chat/rooms/' + g.room_id + '/leave');
    if (!r.ok) return dialogErr(errText(r.body.error));
    dialog.close();
    closeRoom();
    await refreshState();
  });
  document.getElementById('chat-group-cancel').addEventListener('click', () => dialog.close());

  // 通話（voice.js）が使う窓口
  window.estowaChat = {
    send,
    getState: () => state,
    onReady: (h) => { readyHandlers.push(h); if (ready) h(); },
    onSignal: (h) => handlers.signal.push(h),
    onPtt: (h) => handlers.ptt.push(h),
    onPresence: (h) => handlers.presence.push(h),
    isOnline: (userId) => !!online[userId],
    onlineCid: (userId) => online[userId],
  };

  (async function init() {
    if (!(await fetchState())) return;
    ready = true;
    if (state.dms.length > 0) {
      root.hidden = false;
      renderLists();
    }
    readyHandlers.forEach((h) => h());
    connect();
  })();
})();

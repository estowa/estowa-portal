// 通話（在宅の人 ⇔ 社内の各人の1対1）。
// 「通話する」→相手に着信（着信音・タブの見出し・プッシュ通知）→相手が「応答する」→両方のマイクが開いて、お互いの声が聞こえる→どちらかが終えるまで続く。
// 声はサーバーを通らない（WebRTC）。録音・保存はしない。
(function () {
  const chat = window.estowaChat;
  const enableBtn = document.getElementById('voice-enable');
  if (!chat || !enableBtn) return;

  const root = document.getElementById('voice-root');
  const peersEl = document.getElementById('voice-peers');
  const volumeEl = document.getElementById('voice-volume');
  const noteEl = document.getElementById('voice-note');
  const errorEl = document.getElementById('voice-error');
  const callBox = document.getElementById('voice-call');
  const callText = document.getElementById('voice-call-text');
  const acceptBtn = document.getElementById('voice-accept');
  const declineBtn = document.getElementById('voice-decline');
  const micBtn = document.getElementById('voice-mic');
  const endBtn = document.getElementById('voice-end');

  let audioEnabled = false;
  let audioCtx = null;         // 着信音用
  let call = null;             // { peerId, role: 'caller'|'callee', state: 'calling'|'ringing'|'active', stream, startedAt }
  let notice = '';             // 通話が終わった理由など、少しの間だけ出す文
  let noticeTimer = null;
  let ringTimer = null;
  let titleTimer = null;
  let tickTimer = null;
  let savedTitle = null;
  const conns = new Map();     // peerId -> { pc, cid, audio, sender, pending }

  let volume = 0.8;
  try {
    const saved = parseFloat(localStorage.getItem('estowaVoiceVolume'));
    if (!Number.isNaN(saved)) volume = Math.min(1, Math.max(0, saved));
  } catch (e) { /* localStorageが使えなくても動く */ }
  volumeEl.value = String(Math.round(volume * 100));

  function me() { return chat.getState().me; }
  function voicePeers() { return chat.getState().voicePeers; }
  function isVoicePeer(userId) { return voicePeers().some((p) => p.user_id === userId); }
  function nameOf(userId) {
    const p = voicePeers().find((x) => x.user_id === userId);
    return p ? p.display_name : userId;
  }
  function showError(text) {
    errorEl.textContent = text || '';
    errorEl.hidden = !text;
  }

  // ---- 音声ON（着信音と、相手の声を鳴らすための、ブラウザの許可） ----
  function sendVoiceState() {
    chat.send({ type: 'voice', ready: audioEnabled, visible: !document.hidden });
  }
  function enableAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    if (audioEnabled) return;
    audioEnabled = true;
    enableBtn.textContent = '音声ON済み';
    enableBtn.disabled = true;
    noteEl.textContent = '着信音が鳴ります。PCの音量が小さい／ミュートの場合は、PC側で調整してください。';
    conns.forEach((c) => c.audio.play().catch(() => {}));
    sendVoiceState(); // この画面を、通話の受け口にする
    render();
  }
  enableBtn.addEventListener('click', enableAudio);
  chat.onOpen(sendVoiceState);
  document.addEventListener('visibilitychange', sendVoiceState);

  volumeEl.addEventListener('input', () => {
    volume = Number(volumeEl.value) / 100;
    conns.forEach((c) => { c.audio.volume = volume; });
    try { localStorage.setItem('estowaVoiceVolume', String(volume)); } catch (e) { /* 無視 */ }
  });

  // ---- 着信音・タブの見出し ----
  function beep() {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    [[0, 440], [0.35, 554]].forEach(([offset, freq]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.3 * volume;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t + offset);
      osc.stop(t + offset + 0.28);
    });
  }
  function startRing(name) {
    stopRing();
    beep();
    ringTimer = setInterval(beep, 2200);
    savedTitle = document.title;
    let flip = false;
    titleTimer = setInterval(() => {
      flip = !flip;
      document.title = flip ? `📞 ${name}さんから通話` : savedTitle;
    }, 900);
  }
  function stopRing() {
    clearInterval(ringTimer);
    clearInterval(titleTimer);
    ringTimer = null;
    titleTimer = null;
    if (savedTitle !== null) { document.title = savedTitle; savedTitle = null; }
  }

  // ---- 相手の声の再生: 通話中の相手の声だけ鳴らす ----
  function applyPlayback(peerId) {
    const conn = conns.get(peerId);
    if (!conn) return;
    const playing = !!call && call.state === 'active' && call.peerId === peerId;
    conn.audio.muted = !playing;
    if (playing) conn.audio.play().catch(() => {});
  }

  // ---- WebRTC接続（在宅側が、オンラインの各人へ常時つなぐ。マイクは通話中だけ差し込む） ----
  function closeConn(peerId) {
    const c = conns.get(peerId);
    if (!c) return;
    conns.delete(peerId);
    if (call && call.peerId === peerId) endLocal(null, true);
    try { c.pc.close(); } catch (e) { /* 無視 */ }
    c.audio.srcObject = null;
    c.audio.remove();
  }

  function createConn(peerId, cid, asOfferer) {
    closeConn(peerId);
    const pc = new RTCPeerConnection({ iceServers: chat.getState().iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = true;          // 通話中だけ解除する
    audio.volume = volume;
    audio.dataset.peerId = peerId;
    document.body.appendChild(audio);

    const conn = { pc, cid, audio, sender: null, pending: [] };
    if (asOfferer) conn.sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;

    pc.ontrack = (ev) => {
      audio.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      audio.play().catch(() => {});
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) chat.send({ type: 'signal', to: peerId, data: { candidate: ev.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (conns.get(peerId) !== conn) return;
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closeConn(peerId);
        maybeOffer(peerId);
      }
      renderPeers();
    };
    conns.set(peerId, conn);
    return conn;
  }

  async function maybeOffer(peerId) {
    if (!me().isRemote || !isVoicePeer(peerId) || !chat.isOnline(peerId)) return;
    const cid = chat.onlineCid(peerId);
    const existing = conns.get(peerId);
    if (existing && existing.cid === cid &&
        !['failed', 'closed'].includes(existing.pc.connectionState)) return;
    try {
      const conn = createConn(peerId, cid, true);
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      chat.send({ type: 'signal', to: peerId, data: { sdp: conn.pc.localDescription } });
    } catch (e) {
      showError('通話の準備に失敗しました');
    }
  }

  async function flushPending(conn) {
    for (const cand of conn.pending.splice(0)) {
      try { await conn.pc.addIceCandidate(cand); } catch (e) { /* 古い候補は無視 */ }
    }
  }

  chat.onSignal(async (from, data) => {
    try {
      if (data && data.sdp && data.sdp.type === 'offer') {
        const conn = createConn(from, chat.onlineCid(from), false);
        await conn.pc.setRemoteDescription(data.sdp);
        const transceiver = conn.pc.getTransceivers()[0];
        transceiver.direction = 'sendrecv';
        conn.sender = transceiver.sender;
        await flushPending(conn);
        const answer = await conn.pc.createAnswer();
        await conn.pc.setLocalDescription(answer);
        chat.send({ type: 'signal', to: from, data: { sdp: conn.pc.localDescription } });
      } else if (data && data.sdp && data.sdp.type === 'answer') {
        const conn = conns.get(from);
        if (!conn) return;
        await conn.pc.setRemoteDescription(data.sdp);
        await flushPending(conn);
      } else if (data && data.candidate) {
        const conn = conns.get(from);
        if (!conn) return;
        if (conn.pc.remoteDescription) {
          try { await conn.pc.addIceCandidate(data.candidate); } catch (e) { /* 無視 */ }
        } else {
          conn.pending.push(data.candidate);
        }
      }
    } catch (e) {
      showError('通話の接続に失敗しました');
    }
  });

  chat.onPresence((online) => {
    // 相手がいなくなったら接続を片付ける
    [...conns.keys()].forEach((peerId) => { if (!online[peerId]) closeConn(peerId); });
    // 在宅側は、オンラインの通話相手に接続する（相手の接続番号が変わっていたら作り直す）
    if (me().isRemote) voicePeers().forEach((p) => { if (online[p.user_id]) maybeOffer(p.user_id); });
    renderPeers();
  });

  // ---- マイク ----
  function micErrorText(e) {
    if (e && e.name === 'NotFoundError') return 'マイクが見つかりません。ヘッドセットなどを接続してください';
    if (e && (e.name === 'NotReadableError' || e.name === 'AbortError')) return '他のアプリがマイクを使っているため使えません';
    return 'マイクが使えません。ブラウザのアドレスバー左の設定アイコンから、マイクを「許可」にしてください';
  }
  async function getMic() {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  }
  function attachMic(peerId, stream) {
    const conn = conns.get(peerId);
    if (conn && conn.sender) conn.sender.replaceTrack(stream.getAudioTracks()[0]).catch(() => {});
  }

  // ---- 通話の流れ ----
  const END_TEXT = {
    declined: '通話を断られました',
    missed: '応答がありませんでした',
    offline: '相手がオフラインになりました',
    busy: '相手は別の通話中です',
    limit: '通話時間の上限（30分）に達したため、終了しました',
    ended: '通話が終わりました',
  };

  function showNotice(text) {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; render(); }, 6000);
  }

  // 自分の側の後片付け（マイクを閉じる・着信音を止める・声を止める）
  function endLocal(reason, silent) {
    const c = call;
    call = null;
    stopRing();
    clearInterval(tickTimer);
    tickTimer = null;
    if (c) {
      if (c.stream) c.stream.getTracks().forEach((t) => t.stop());
      const conn = conns.get(c.peerId);
      if (conn && conn.sender) conn.sender.replaceTrack(null).catch(() => {});
      applyPlayback(c.peerId);
      if (!silent && reason) showNotice(END_TEXT[reason] || END_TEXT.ended);
    }
    render();
  }

  async function startCall(peerId) {
    if (call) return;
    showError('');
    const conn = conns.get(peerId);
    if (!conn || conn.pc.connectionState !== 'connected' || !conn.sender) {
      return showError('まだつながっていません。少し待ってからもう一度押してください');
    }
    enableAudio(); // 押した操作で、音声を有効にする
    let stream;
    try {
      stream = await getMic();
    } catch (e) {
      return showError(micErrorText(e));
    }
    if (call) { stream.getTracks().forEach((t) => t.stop()); return; } // 許可を待つ間に着信した
    call = { peerId, role: 'caller', state: 'calling', stream };
    chat.send({ type: 'call', to: peerId, action: 'invite' });
    render();
  }

  async function acceptCall() {
    if (!call || call.state !== 'ringing') return;
    showError('');
    enableAudio(); // 応答の操作で、音声を有効にする
    const peerId = call.peerId;
    let stream;
    try {
      stream = await getMic();
    } catch (e) {
      showError(micErrorText(e));
      chat.send({ type: 'call', to: peerId, action: 'decline' });
      return endLocal(null, true);
    }
    if (!call || call.peerId !== peerId) { stream.getTracks().forEach((t) => t.stop()); return; } // 待つ間に切れた
    stopRing();
    call.stream = stream;
    call.state = 'active';
    call.startedAt = Date.now();
    attachMic(peerId, stream);
    applyPlayback(peerId);
    chat.send({ type: 'call', to: peerId, action: 'accept' });
    startTick();
    render();
  }

  function declineCall() {
    if (!call || call.state !== 'ringing') return;
    chat.send({ type: 'call', to: call.peerId, action: 'decline' });
    endLocal(null, true);
  }

  function endCall() {
    if (!call) return;
    chat.send({ type: 'call', to: call.peerId, action: 'end' });
    endLocal('ended');
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(renderCallText, 1000);
  }

  chat.onCall((msg) => {
    if (msg.action === 'invite') {
      if (call) return chat.send({ type: 'call', to: msg.from, action: 'decline' }); // 別の通話中
      call = { peerId: msg.from, role: 'callee', state: 'ringing' };
      startRing(nameOf(msg.from));
      render();
    } else if (msg.action === 'accepted') {
      if (!call || call.state !== 'calling' || call.peerId !== msg.from) return;
      call.state = 'active';
      call.startedAt = Date.now();
      attachMic(call.peerId, call.stream);
      applyPlayback(call.peerId);
      startTick();
      render();
    } else if (msg.action === 'ended') {
      if (!call || call.peerId !== msg.from) return;
      endLocal(msg.reason);
    }
  });

  acceptBtn.addEventListener('click', acceptCall);
  declineBtn.addEventListener('click', declineCall);
  endBtn.addEventListener('click', endCall);
  micBtn.addEventListener('click', () => {
    if (!call || !call.stream) return;
    const track = call.stream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    renderMic();
  });
  // ページを閉じる時・離れる時は、通話を終える
  window.addEventListener('pagehide', () => {
    if (call) chat.send({ type: 'call', to: call.peerId, action: 'end' });
  });

  // ---- 表示 ----
  function renderCallText() {
    if (!call) { callText.textContent = notice; return; }
    const name = nameOf(call.peerId);
    if (call.state === 'calling') callText.textContent = `${name}さんを呼び出しています…`;
    else if (call.state === 'ringing') {
      callText.textContent = `📞 ${name}さんから通話です` + (audioEnabled ? '' : '（着信音を鳴らすには「音声ON」を押してください）');
    } else {
      const sec = Math.floor((Date.now() - call.startedAt) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      callText.textContent = `${name}さんと通話中　${mm}:${ss}`;
    }
  }
  function renderMic() {
    const track = call && call.stream ? call.stream.getAudioTracks()[0] : null;
    const off = !!track && !track.enabled;
    micBtn.textContent = off ? 'マイクを入れる' : 'マイクを消す';
    micBtn.classList.toggle('on', off);
    micBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
  }
  function renderPeers() {
    const peers = voicePeers();
    root.hidden = peers.length === 0;
    peersEl.textContent = '';
    peers.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'chat-peer';
      const dot = document.createElement('span');
      dot.className = 'chat-dot' + (chat.isOnline(p.user_id) ? ' on' : '');
      const name = document.createElement('span');
      name.className = 'chat-peer-name';
      name.textContent = p.display_name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'talk-btn';
      btn.textContent = '通話する';
      btn.disabled = !!call || !chat.isOnline(p.user_id);
      btn.addEventListener('click', () => startCall(p.user_id));
      li.append(dot, name, btn);
      peersEl.appendChild(li);
    });
  }
  function render() {
    renderPeers();
    renderCallText();
    callBox.hidden = !call && !notice;
    callBox.classList.toggle('ringing', !!call && call.state === 'ringing');
    callBox.classList.toggle('active', !!call && call.state === 'active');
    acceptBtn.hidden = !(call && call.state === 'ringing');
    declineBtn.hidden = !(call && call.state === 'ringing');
    endBtn.hidden = !(call && (call.state === 'calling' || call.state === 'active'));
    endBtn.textContent = call && call.state === 'calling' ? 'やめる' : '通話を終える';
    micBtn.hidden = !(call && call.state === 'active');
    renderMic();
  }

  chat.onReady(() => {
    render();
    if (me().isRemote) voicePeers().forEach((p) => { if (chat.isOnline(p.user_id)) maybeOffer(p.user_id); });
  });
})();

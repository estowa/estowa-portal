(function () {
  const chat = window.estowaChat;
  const enableBtn = document.getElementById('voice-enable');
  if (!chat || !enableBtn) return;

  const volumeEl = document.getElementById('voice-volume');
  const muteBtn = document.getElementById('voice-mute');
  const noteEl = document.getElementById('voice-note');
  const speakingEl = document.getElementById('voice-speaking');
  const errorEl = document.getElementById('voice-error');

  let audioEnabled = false;
  let muted = false;           // 消音: 話しかけられても鳴らさない
  let holding = null;          // 「話す」を押している相手
  let talking = null;          // { peerId, stream }
  const speaking = new Set();  // 今こちらに話しかけている相手
  const conns = new Map();     // peerId -> { pc, cid, audio, sender, pending }

  let volume = 0.8;
  try {
    const saved = parseFloat(localStorage.getItem('estowaVoiceVolume'));
    if (!Number.isNaN(saved)) volume = Math.min(1, Math.max(0, saved));
    muted = localStorage.getItem('estowaVoiceMuted') === '1';
  } catch (e) { /* localStorageが使えなくても動く */ }
  volumeEl.value = String(Math.round(volume * 100));

  function me() { return chat.getState().me; }
  function nameOf(userId) {
    const p = chat.getState().peers.find((x) => x.user_id === userId);
    return p ? p.display_name : userId;
  }
  function showError(text) {
    errorEl.textContent = text || '';
    errorEl.hidden = !text;
  }

  // 相手が話している間だけ、音声ONかつ消音でなければ鳴らす
  function shouldPlay(peerId) {
    return speaking.has(peerId) && audioEnabled && !muted;
  }
  function applyPlayback(peerId) {
    const conn = conns.get(peerId);
    if (!conn) return;
    conn.audio.muted = !shouldPlay(peerId);
    if (!conn.audio.muted) conn.audio.play().catch(() => {});
  }
  function applyAllPlayback() { conns.forEach((c, peerId) => applyPlayback(peerId)); }

  // ---- 音声ON・音量・消音 ----
  enableBtn.addEventListener('click', () => {
    audioEnabled = true;
    enableBtn.textContent = '音声ON済み';
    enableBtn.disabled = true;
    noteEl.textContent = 'PCの音量が小さい／ミュートの場合は、PC側で調整してください。';
    conns.forEach((c) => c.audio.play().catch(() => {}));
    applyAllPlayback();
    renderSpeaking();
  });
  volumeEl.addEventListener('input', () => {
    volume = Number(volumeEl.value) / 100;
    conns.forEach((c) => { c.audio.volume = volume; });
    try { localStorage.setItem('estowaVoiceVolume', String(volume)); } catch (e) { /* 無視 */ }
  });
  function renderMute() {
    muteBtn.textContent = muted ? '消音中（解除）' : '消音';
    muteBtn.classList.toggle('on', muted);
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('estowaVoiceMuted', muted ? '1' : '0'); } catch (e) { /* 無視 */ }
    renderMute();
    applyAllPlayback();
    renderSpeaking();
  });
  renderMute();

  function renderSpeaking() {
    if (speaking.size === 0) { speakingEl.hidden = true; return; }
    const names = [...speaking].map(nameOf).join('、');
    let text = names + ' さんが話しています';
    if (muted) text += '（消音中のため聞こえません）';
    else if (!audioEnabled) text += '（「音声ON」を押すと聞こえます）';
    speakingEl.textContent = text;
    speakingEl.hidden = false;
  }

  // ---- WebRTC接続 ----
  function closeConn(peerId) {
    const c = conns.get(peerId);
    if (!c) return;
    conns.delete(peerId);
    try { c.pc.close(); } catch (e) { /* 無視 */ }
    c.audio.srcObject = null;
    c.audio.remove();
    if (speaking.delete(peerId)) renderSpeaking();
  }

  function createConn(peerId, cid, asOfferer) {
    closeConn(peerId);
    const pc = new RTCPeerConnection({ iceServers: chat.getState().iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = true;          // 相手が話している間だけ解除する
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
    };
    conns.set(peerId, conn);
    return conn;
  }

  async function maybeOffer(peerId) {
    if (!me().isRemote || !chat.isOnline(peerId)) return;
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
    // 在宅側は、オンラインの相手に接続する（相手の接続番号が変わっていたら作り直す）
    if (me().isRemote) Object.keys(online).forEach((peerId) => maybeOffer(peerId));
  });

  // ---- 受信側: 相手が話している間だけ鳴らす ----
  chat.onPtt((from, on) => {
    if (on) speaking.add(from); else speaking.delete(from);
    applyPlayback(from);
    renderSpeaking();
  });

  // ---- 送信側: 「話す」ボタン ----
  async function startTalk(peerId) {
    showError('');
    holding = peerId;
    const conn = conns.get(peerId);
    if (!conn || conn.pc.connectionState !== 'connected' || !conn.sender) {
      holding = null;
      return showError('まだつながっていません。少し待ってからもう一度押してください');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      holding = null;
      return showError('マイクが使えません。ブラウザのアドレスバー左の鍵マークからマイクを「許可」にしてください');
    }
    if (holding !== peerId) { // 許可を待つ間にボタンが離された
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    await conn.sender.replaceTrack(stream.getAudioTracks()[0]);
    talking = { peerId, stream };
    chat.send({ type: 'ptt', to: peerId, on: true });
    setTalkingUi(peerId, true);
  }

  function stopTalk() {
    holding = null;
    if (!talking) return;
    const { peerId, stream } = talking;
    talking = null;
    stream.getTracks().forEach((t) => t.stop());
    const conn = conns.get(peerId);
    if (conn && conn.sender) conn.sender.replaceTrack(null).catch(() => {});
    chat.send({ type: 'ptt', to: peerId, on: false });
    setTalkingUi(peerId, false);
  }

  function setTalkingUi(peerId, on) {
    const btn = document.querySelector('.talk-btn[data-user-id="' + CSS.escape(peerId) + '"]');
    if (btn) btn.classList.toggle('talking', on);
  }

  // ボタンを、会話相手の一覧に差し込む（chat.jsが一覧を描き直すたびに呼ばれる）
  chat.afterRenderPeers = function (peersEl) {
    peersEl.querySelectorAll('.chat-peer').forEach((li) => {
      const peerId = li.dataset.userId;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'talk-btn' + (talking && talking.peerId === peerId ? ' talking' : '');
      btn.dataset.userId = peerId;
      btn.textContent = '話す';
      btn.disabled = !chat.isOnline(peerId);
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        startTalk(peerId);
      });
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      li.appendChild(btn);
    });
  };

  // 押しっぱなしの事故を防ぐ: ボタンは一覧の描き直しで作り直されるため、離したことはwindowで受ける。
  // タブを離れた・ページを閉じる時も必ず止める
  window.addEventListener('pointerup', stopTalk);
  window.addEventListener('pointercancel', stopTalk);
  window.addEventListener('blur', stopTalk);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTalk(); });
  window.addEventListener('pagehide', stopTalk);

  // chat.jsが先に一覧を描いていた場合に備えて、1回描き直す
  const peersEl = document.getElementById('chat-peers');
  if (peersEl && peersEl.children.length) chat.afterRenderPeers(peersEl);
})();

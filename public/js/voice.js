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
  const chipBtn = document.getElementById('voice-chip');
  const ON_KEY = 'estowaVoiceOn'; // 「音声ON」を押したことを、ブラウザを閉じるまで覚える（ページを再読み込みしても、自動でONに戻すため）

  let audioEnabled = false;
  let ringAudio = null;        // 着信音（音声ファイルを繰り返し再生する。背景のタブでも、タイマーに頼らず鳴る）
  let call = null;             // { peerId, role: 'caller'|'callee', state: 'calling'|'ringing'|'active', stream, startedAt }
  let notice = '';             // 通話が終わった理由など、少しの間だけ出す文
  let noticeTimer = null;
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
  function savedOn() {
    try { return sessionStorage.getItem(ON_KEY) === '1'; } catch (e) { return false; }
  }
  function makeRing() {
    ringAudio = new Audio(makeRingUrl());
    ringAudio.loop = true;
    ringAudio.volume = volume;
  }
  // 音声ONの状態にする（画面の表示・通話の受け口・ONの記憶）
  function activateAudio() {
    if (audioEnabled) return;
    audioEnabled = true;
    enableBtn.textContent = '音声ON済み';
    enableBtn.disabled = true;
    noteEl.textContent = '着信音が鳴ります。PCの音量が小さい／ミュートの場合は、PC側で調整してください。';
    try { sessionStorage.setItem(ON_KEY, '1'); } catch (e) { /* 覚えられなくても動く */ }
    conns.forEach((c) => c.audio.play().catch(() => {}));
    sendVoiceState(); // この画面を、通話の受け口にする
    render();
  }
  function enableAudio() {
    if (!ringAudio) { // この操作の中で一度鳴らして止め、あとから自動で鳴らせるようにする（ブラウザの決まり）
      makeRing();
      ringAudio.play().then(() => ringAudio.pause()).catch(() => {});
    }
    activateAudio();
  }
  // ページを開き直したとき、前にONにしていたら、操作なしで戻す。ブラウザに止められたら、バーの案内から押してもらう
  function restoreAudio() {
    if (audioEnabled || !savedOn()) return;
    if (!ringAudio) makeRing();
    ringAudio.play().then(() => { ringAudio.pause(); activateAudio(); }).catch(() => { render(); });
  }
  enableBtn.addEventListener('click', enableAudio);
  chipBtn.addEventListener('click', enableAudio);
  chat.onOpen(sendVoiceState);
  document.addEventListener('visibilitychange', sendVoiceState);

  volumeEl.addEventListener('input', () => {
    volume = Number(volumeEl.value) / 100;
    conns.forEach((c) => { c.audio.volume = volume; });
    if (ringAudio) ringAudio.volume = volume;
    try { localStorage.setItem('estowaVoiceVolume', String(volume)); } catch (e) { /* 無視 */ }
  });

  // ---- 着信音・タブの見出し ----
  // 着信音: 電話の呼び出し音のような「ブルルル、ブルルル」を、3秒ぶんの音声ファイルとして作り、繰り返し再生する
  function makeRingUrl() {
    const rate = 16000;
    const seconds = 3;
    const samples = new Int16Array(rate * seconds);
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate;
      const inBurst = (t < 0.8) || (t >= 1.0 && t < 1.8); // 0.8秒鳴って、0.2秒休み、もう一度。残りは無音
      if (!inBurst) continue;
      const wobble = 0.5 + 0.5 * Math.sin(2 * Math.PI * 20 * t); // 震える感じ
      const v = (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) / 2;
      samples[i] = Math.round(v * (0.55 + 0.45 * wobble) * 0.85 * 32767);
    }
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, samples.length * 2, true);
    new Int16Array(buf, 44).set(samples);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function startRing(name) {
    stopRing();
    if (ringAudio) {
      ringAudio.currentTime = 0;
      ringAudio.volume = volume;
      ringAudio.play().catch(() => {});
    }
    savedTitle = document.title;
    document.title = `📞 ${name}さんから通話`;
    let flip = true;
    titleTimer = setInterval(() => {
      flip = !flip;
      document.title = flip ? `📞 ${name}さんから通話` : savedTitle;
    }, 900);
  }
  function stopRing() {
    if (ringAudio) ringAudio.pause();
    clearInterval(titleTimer);
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
    chipBtn.hidden = audioEnabled || !savedOn();
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

  window.estowaVoiceBusy = () => !!call;

  chat.onReady(() => {
    restoreAudio();
    render();
    if (me().isRemote) voicePeers().forEach((p) => { if (chat.isOnline(p.user_id)) maybeOffer(p.user_id); });
  });
})();

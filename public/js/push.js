// 設定画面: この端末で通知を受け取る／やめる／テスト送信
(function () {
  var panel = document.getElementById('push-panel');
  if (!panel || panel.dataset.configured !== '1') return;

  var message = document.getElementById('push-message');
  var enableBtn = document.getElementById('push-enable');
  var testBtn = document.getElementById('push-test');
  var disableBtn = document.getElementById('push-disable');
  var installLink = document.getElementById('push-install');
  var publicKey = panel.dataset.key;

  function show(el, visible) {
    if (el) el.hidden = !visible;
  }

  function setMessage(text) {
    message.textContent = text;
  }

  // 公開鍵（URL安全なBase64）を、購読に渡す形にする
  function keyToBytes(base64) {
    var padded = (base64 + '===').slice(0, base64.length + ((4 - (base64.length % 4)) % 4));
    var raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) throw new Error(json.error || '失敗しました');
        return json;
      });
    });
  }

  var isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function hideAll() {
    show(enableBtn, false);
    show(testBtn, false);
    show(disableBtn, false);
    show(installLink, false);
  }

  // 今の状態を調べて、画面を合わせる
  function refresh() {
    hideAll();
    if (isIos && !standalone) {
      setMessage('iPhone・iPadでは、ホーム画面に追加したアイコンから開いたときだけ、通知を受け取れます（iOS 16.4以上）。');
      show(installLink, true);
      return Promise.resolve();
    }
    if (!supported) {
      setMessage('このブラウザは、通知に対応していません。');
      return Promise.resolve();
    }
    if (Notification.permission === 'denied') {
      setMessage('この端末では、通知がブロックされています。ブラウザやiPhoneの設定で、このアプリの通知を許可してください。');
      return Promise.resolve();
    }
    return navigator.serviceWorker.ready
      .then(function (reg) {
        return reg.pushManager.getSubscription();
      })
      .then(function (sub) {
        if (!sub) return { subscribed: false };
        return post('/push/status', { endpoint: sub.endpoint });
      })
      .then(function (status) {
        if (status.subscribed) {
          setMessage('この端末は、通知を受け取る設定になっています。');
          show(testBtn, true);
          show(disableBtn, true);
        } else {
          setMessage('この端末は、まだ通知を受け取る設定になっていません。');
          show(enableBtn, true);
        }
      })
      .catch(function () {
        setMessage('通知の状態を確認できませんでした。電波のあるところで、開き直してください。');
      });
  }

  enableBtn.addEventListener('click', function () {
    enableBtn.disabled = true;
    // 許可の確認は、ボタンを押した操作の中で出す必要がある
    Notification.requestPermission()
      .then(function (permission) {
        if (permission !== 'granted') throw new Error('通知が許可されませんでした。');
        return navigator.serviceWorker.ready;
      })
      .then(function (reg) {
        return reg.pushManager.getSubscription().then(function (existing) {
          return existing || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });
        });
      })
      .then(function (sub) {
        return post('/push/subscribe', { subscription: sub.toJSON() });
      })
      .then(function () {
        return refresh();
      })
      .then(function () {
        setMessage('通知を受け取る設定にしました。「テスト通知を送る」で、届くか確かめられます。');
      })
      .catch(function (err) {
        setMessage('設定できませんでした: ' + err.message);
        return refresh().then(function () {
          setMessage('設定できませんでした: ' + err.message);
        });
      })
      .then(function () {
        enableBtn.disabled = false;
      });
  });

  disableBtn.addEventListener('click', function () {
    disableBtn.disabled = true;
    navigator.serviceWorker.ready
      .then(function (reg) {
        return reg.pushManager.getSubscription();
      })
      .then(function (sub) {
        if (!sub) return null;
        return post('/push/unsubscribe', { endpoint: sub.endpoint }).then(function () {
          return sub.unsubscribe();
        });
      })
      .then(function () {
        return refresh();
      })
      .then(function () {
        setMessage('この端末の通知をやめました。');
      })
      .catch(function (err) {
        setMessage('解除できませんでした: ' + err.message);
      })
      .then(function () {
        disableBtn.disabled = false;
      });
  });

  testBtn.addEventListener('click', function () {
    testBtn.disabled = true;
    post('/push/test')
      .then(function (result) {
        setMessage(result.sent > 0 ? 'テスト通知を送りました。数秒で届きます。' : '送れる端末がありませんでした。');
      })
      .catch(function (err) {
        setMessage('送れませんでした: ' + err.message);
      })
      .then(function () {
        testBtn.disabled = false;
      });
  });

  refresh();
})();

// ページ移動を「画面全体の読み込み」でなく、「本文（main）の入れ替え」にする。
// 目的: 通話・チャットの接続（chat.js / voice.js）を、ページを移動しても切らずに持ち続ける。
// - 入れ替えるのは、同じサイト内の通常のリンクと、GETの検索フォームだけ。
// - ダウンロード・別タブ・ログイン画面への転送・うまく入れ替えられないときは、ふつうの移動にする。
// - 保存ボタンなどのPOSTのフォームは、ふつうの移動のまま（通話中なら、ブラウザが確認を出す）。
(function () {
  var main = document.querySelector('main.main');
  var holder = document.getElementById('realtime-holder');
  if (!main || !holder || !history.pushState || !window.fetch) return;

  var seq = 0;
  var currentKey = location.pathname + location.search;
  var SKIP_PREFIX = ['/logout', '/api/', '/chat/files', '/uploads', '/ws', '/badge', '/sw.js', '/login'];
  var FILE_EXT = /\.(pdf|csv|xlsx?|zip|png|jpe?g|gif|webp|svg|docx?|pptx?|txt|ics|webmanifest)$/i;
  // チャット・通話のパネルは、ホームの枠（slot）に入れて見せる。ほかのページでは、画面の外（holder）に置いたまま動かし続ける
  var SLOTS = [['chat-slot', 'chat-root'], ['voice-slot', 'voice-root']];

  function sameOriginUrl(href) {
    try {
      var u = new URL(href, location.href);
      return u.origin === location.origin ? u : null;
    } catch (e) {
      return null;
    }
  }
  function swappable(u) {
    if (FILE_EXT.test(u.pathname)) return false;
    return !SKIP_PREFIX.some(function (p) { return u.pathname === p || u.pathname.indexOf(p.replace(/\/$/, '') + '/') === 0; });
  }
  function full(url) {
    window.location.href = url;
  }

  function park() {
    SLOTS.forEach(function (pair) {
      var node = document.getElementById(pair[1]);
      if (node && node.parentNode !== holder) holder.appendChild(node);
    });
  }
  function mount() {
    SLOTS.forEach(function (pair) {
      var slot = document.getElementById(pair[0]);
      var node = document.getElementById(pair[1]);
      if (slot && node && node.parentNode !== slot) slot.appendChild(node);
    });
  }
  function notifyViewing() {
    if (window.estowaChat && window.estowaChat.onPlacementChange) window.estowaChat.onPlacementChange();
  }

  // 入れ替えた本文の <script> は、そのままでは動かないので、作り直して順番どおりに実行する
  async function runScripts(container) {
    var scripts = Array.prototype.slice.call(container.querySelectorAll('script'));
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var s = document.createElement('script');
      for (var j = 0; j < old.attributes.length; j++) {
        var a = old.attributes[j];
        if (a.name !== 'defer' && a.name !== 'async') s.setAttribute(a.name, a.value);
      }
      if (old.getAttribute('src')) {
        await new Promise(function (resolve) { s.onload = resolve; s.onerror = resolve; old.replaceWith(s); });
      } else {
        s.textContent = old.textContent;
        old.replaceWith(s);
      }
    }
  }

  async function apply(doc, newMain, finalUrl, push) {
    window.__pageScope.clear();
    park();
    main.innerHTML = newMain.innerHTML;
    document.title = doc.title;
    var q = document.querySelector('.topbar-search input');
    var newQ = doc.querySelector('.topbar-search input');
    if (q && newQ) q.value = newQ.value;
    if (push) history.pushState(null, '', finalUrl.pathname + finalUrl.search);
    currentKey = finalUrl.pathname + finalUrl.search;
    mount();
    window.__pageScope.start(true);
    try {
      await runScripts(main);
    } finally {
      window.__pageScope.stop();
    }
    notifyViewing();
    if (window.estowaChat && window.estowaChat.setBaseTitle) window.estowaChat.setBaseTitle(document.title);
    window.scrollTo(0, 0);
    if (window.updateNavActive) window.updateNavActive();
    if (window.refreshAppBadge) window.refreshAppBadge();
    document.body.classList.remove('menu-open');
  }

  async function go(url, push) {
    var my = ++seq;
    try {
      var res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'portal-swap' } });
      if (my !== seq) return;
      var finalUrl = new URL(res.url);
      var type = res.headers.get('content-type') || '';
      // HTMLでない（ダウンロードなど）・ログイン画面へ転送された・別のサイトへ転送された: ふつうの移動にする
      if (type.indexOf('text/html') === -1 || finalUrl.origin !== location.origin || finalUrl.pathname === '/login') return full(url);
      var doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      if (my !== seq) return;
      var newMain = doc.querySelector('main.main');
      if (!newMain || !doc.querySelector('.app-layout')) return full(url);
      await apply(doc, newMain, finalUrl, push);
    } catch (e) {
      if (my === seq) full(url);
    }
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-no-swap')) return;
    var u = sameOriginUrl(a.getAttribute('href'));
    if (!u || !swappable(u) || u.hash) return; // 位置指定（#）つきは、ふつうの移動（:target の表示などが必要なため）
    e.preventDefault();
    go(u.pathname + u.search, true);
  });

  // 検索などのGETフォーム
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (e.defaultPrevented || !(f instanceof HTMLFormElement)) return;
    if ((f.getAttribute('method') || 'get').toLowerCase() !== 'get' || f.hasAttribute('data-no-swap') || (f.target && f.target !== '_self')) return;
    var u = sameOriginUrl(f.getAttribute('action') || location.pathname);
    if (!u || !swappable(u)) return;
    var qs = new URLSearchParams(new FormData(f)).toString();
    e.preventDefault();
    go(u.pathname + (qs ? '?' + qs : ''), true);
  });

  // ブラウザの「戻る・進む」
  window.addEventListener('popstate', function () {
    var key = location.pathname + location.search;
    if (key === currentKey) return; // ページ内の位置（#）だけの変更は、何もしない
    go(key, false);
  });

  // 通話中に、画面全体を読み込み直す操作（再読み込み・POSTのフォーム・タブを閉じる）をしたら、ブラウザに確認を出させる
  window.addEventListener('beforeunload', function (e) {
    if (window.estowaVoiceBusy && window.estowaVoiceBusy()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  mount(); // 最初に開いたページがホームなら、ここでパネルを枠に入れる
  notifyViewing();
})();

// 追加の案内ページ: ホーム画面から開いている時は「追加済み」を出す。
// Androidでは、追加ボタンが使える時だけボタンを出す
(function () {
  var standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var installed = document.getElementById('installed');
  if (standalone && installed) installed.hidden = false;

  var button = document.getElementById('install-button');
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    if (button) button.hidden = false;
  });
  if (button) {
    button.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred = null;
      button.hidden = true;
    });
  }
  window.addEventListener('appinstalled', function () {
    if (button) button.hidden = true;
    if (installed) installed.hidden = false;
  });
})();

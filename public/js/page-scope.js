// ページ移動（nav.js）の準備。ページごとのスクリプトが window / document に付けたイベントを覚えておき、
// 次のページへ移るときにまとめて外す（外さないと、移動のたびに古いページの処理が積み重なる）。
// <head> で最初に読み込む。記録するのは、フッターの最初の stop() までと、ページを入れ替えている間だけ。
// 通話・チャットなど、ずっと動かすものは、記録の対象外（stop() のあとに読み込まれる）。
(function () {
  var tracking = true; // 最初のページの読み込み中は、記録する
  var swapping = false;
  var tracked = [];

  function patch(target) {
    var add = target.addEventListener;
    target.addEventListener = function (type, fn, opts) {
      if (tracking && fn) tracked.push({ target: target, type: type, fn: fn, opts: opts });
      // ページを入れ替えたあとは、「読み込み完了」のイベントはもう起きないので、すぐに実行する
      if (swapping && typeof fn === 'function' && (type === 'DOMContentLoaded' || type === 'load')) {
        setTimeout(function () { fn.call(target, new Event(type)); }, 0);
        return;
      }
      return add.apply(this, arguments);
    };
  }
  patch(window);
  patch(document);

  window.__pageScope = {
    start: function (isSwap) { tracking = true; swapping = !!isSwap; },
    stop: function () { tracking = false; swapping = false; },
    clear: function () {
      tracked.forEach(function (e) { e.target.removeEventListener(e.type, e.fn, e.opts); });
      tracked = [];
    },
  };
})();

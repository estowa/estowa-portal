// ナレッジ記事の編集画面: ボタンで見出し・太字・リスト・表・リンク・枠を入れる。プレビューも切り替えられる。
(function () {
  var ta = document.getElementById('kb-body');
  if (!ta) return;
  var toolbar = document.getElementById('kb-toolbar');
  var previewBox = document.getElementById('kb-preview');
  var previewBtn = document.getElementById('kb-preview-toggle');

  function sel() { return { s: ta.selectionStart, e: ta.selectionEnd, v: ta.value }; }

  function setText(v, selStart, selEnd) {
    ta.value = v;
    ta.focus();
    ta.setSelectionRange(selStart, selEnd);
  }

  // 選択範囲を、前後の記号で囲む(選択がなければ、見本の文字を入れて選んだ状態にする)
  function wrap(before, after, placeholder) {
    var c = sel();
    var picked = c.v.slice(c.s, c.e) || placeholder;
    var out = c.v.slice(0, c.s) + before + picked + after + c.v.slice(c.e);
    setText(out, c.s + before.length, c.s + before.length + picked.length);
  }

  // 選択範囲を含む行の先頭に、記号を付ける
  function prefixLines(makePrefix) {
    var c = sel();
    var lineStart = c.v.lastIndexOf('\n', c.s - 1) + 1;
    var lineEndIdx = c.v.indexOf('\n', c.e);
    var lineEnd = lineEndIdx === -1 ? c.v.length : lineEndIdx;
    var block = c.v.slice(lineStart, lineEnd) || '項目';
    var n = 0;
    var changed = block.split('\n').map(function (line) {
      if (line.trim() === '') return line;
      n += 1;
      return makePrefix(n) + line;
    }).join('\n');
    setText(c.v.slice(0, lineStart) + changed + c.v.slice(lineEnd), lineStart, lineStart + changed.length);
  }

  // 前後に空行を入れて、まとまりを差し込む
  function insertBlock(text) {
    var c = sel();
    var head = c.v.slice(0, c.s);
    var tail = c.v.slice(c.e);
    var lead = head.length === 0 || head.endsWith('\n\n') ? '' : (head.endsWith('\n') ? '\n' : '\n\n');
    var trail = tail.startsWith('\n\n') ? '' : (tail.startsWith('\n') ? '\n' : '\n\n');
    var out = head + lead + text + trail + tail;
    var pos = (head + lead).length;
    setText(out, pos, pos + text.length);
  }

  function askNumber(message, def) {
    var v = window.prompt(message, String(def));
    if (v === null) return null;
    var n = parseInt(v, 10);
    return n >= 1 && n <= 20 ? n : def;
  }

  var actions = {
    heading: function () { prefixLines(function () { return '## '; }); },
    sub: function () { prefixLines(function () { return '### '; }); },
    bold: function () { wrap('**', '**', '太字にする文字'); },
    ul: function () { prefixLines(function () { return '- '; }); },
    ol: function () { prefixLines(function (n) { return n + '. '; }); },
    table: function () {
      var rows = askNumber('行の数（見出し行を除く）', 2);
      if (rows === null) return;
      var cols = askNumber('列の数', 3);
      if (cols === null) return;
      var head = [], sep = [], body = [];
      for (var i = 1; i <= cols; i++) { head.push('見出し' + i); sep.push('---'); }
      for (var r = 0; r < rows; r++) {
        var cells = [];
        for (var j = 0; j < cols; j++) cells.push('　');
        body.push('| ' + cells.join(' | ') + ' |');
      }
      insertBlock('| ' + head.join(' | ') + ' |\n| ' + sep.join(' | ') + ' |\n' + body.join('\n'));
    },
    link: function () {
      var url = window.prompt('リンク先のURL（https:// から）', 'https://');
      if (!url || url === 'https://') return;
      var c = sel();
      var text = c.v.slice(c.s, c.e) || 'リンクの文字';
      var md = '[' + text + '](' + url.trim() + ')';
      setText(c.v.slice(0, c.s) + md + c.v.slice(c.e), c.s + 1, c.s + 1 + text.length);
    },
    callout: function (name) {
      var c = sel();
      var picked = c.v.slice(c.s, c.e) || '内容を入力';
      insertBlock(':::' + name + '\n' + picked + '\n:::');
    },
  };

  toolbar.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-act]');
    if (!btn || btn === previewBtn) return;
    ev.preventDefault();
    var act = actions[btn.getAttribute('data-act')];
    if (act) act(btn.getAttribute('data-name'));
  });

  // ---- プレビュー ----
  var previewing = false;
  function tocHtml(toc) {
    if (!toc || toc.length === 0) return '';
    var items = toc.map(function (t) {
      var a = document.createElement('a');
      a.href = '#' + t.id;
      a.textContent = t.text;
      return '<li class="toc-l' + t.level + '">' + a.outerHTML + '</li>';
    }).join('');
    return '<nav class="kb-toc"><div class="kb-toc-title">目次</div><ul>' + items + '</ul></nav>';
  }

  function setPreview(on) {
    previewing = on;
    previewBtn.textContent = on ? '編集に戻る' : 'プレビュー';
    previewBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    ta.hidden = on;
    previewBox.hidden = !on;
    toolbar.querySelectorAll('button[data-act]').forEach(function (b) { if (b !== previewBtn) b.disabled = on; });
  }

  previewBtn.addEventListener('click', function () {
    if (previewing) { setPreview(false); return; }
    previewBox.innerHTML = '<div class="empty-note">読み込み中…</div>';
    setPreview(true);
    fetch('/knowledge/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: ta.value }),
    })
      .then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); })
      .then(function (d) {
        previewBox.innerHTML = d.html.trim() === '' ? '<div class="empty-note">本文がまだありません。</div>' : tocHtml(d.toc) + d.html;
      })
      .catch(function () {
        previewBox.innerHTML = '<div class="error-text">プレビューを表示できませんでした。ログインし直してから、もう一度お試しください。</div>';
      });
  });
})();

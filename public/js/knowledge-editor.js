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

  // 選択範囲を、前後の記号で囲む。選択がなければ記号だけを入れて、その間にカーソルを置く。
  function wrap(before, after) {
    var c = sel();
    var picked = c.v.slice(c.s, c.e);
    var out = c.v.slice(0, c.s) + before + picked + after + c.v.slice(c.e);
    var caret = picked ? c.s + before.length + picked.length + after.length : c.s + before.length;
    setText(out, caret, caret);
  }

  // 選択範囲を含む行の先頭に、記号を付ける。
  // 空の行なら記号だけを入れて、その直後にカーソルを置く(すぐ書き出せる)。
  function prefixLines(makePrefix) {
    var c = sel();
    var lineStart = c.v.lastIndexOf('\n', c.s - 1) + 1;
    var lineEndIdx = c.v.indexOf('\n', c.e);
    var lineEnd = lineEndIdx === -1 ? c.v.length : lineEndIdx;
    var block = c.v.slice(lineStart, lineEnd);
    if (block.trim() === '') {
      var p = makePrefix(1);
      setText(c.v.slice(0, lineStart) + p + c.v.slice(lineEnd), lineStart + p.length, lineStart + p.length);
      return;
    }
    var n = 0;
    var changed = block.split('\n').map(function (line) {
      if (line.trim() === '') return line;
      n += 1;
      return makePrefix(n) + line;
    }).join('\n');
    var end = lineStart + changed.length;
    setText(c.v.slice(0, lineStart) + changed + c.v.slice(lineEnd), end, end);
  }

  // 前後に空行を入れて、まとまりを差し込む
  // caretOffset を渡すと、まとまりの先頭からその位置にカーソルを置く(渡さなければ全体を選ぶ)
  function insertBlock(text, caretOffset) {
    var c = sel();
    var head = c.v.slice(0, c.s);
    var tail = c.v.slice(c.e);
    var lead = head.length === 0 || head.endsWith('\n\n') ? '' : (head.endsWith('\n') ? '\n' : '\n\n');
    var trail = tail.startsWith('\n\n') ? '' : (tail.startsWith('\n') ? '\n' : '\n\n');
    var out = head + lead + text + trail + tail;
    var pos = (head + lead).length;
    if (typeof caretOffset === 'number') setText(out, pos + caretOffset, pos + caretOffset);
    else setText(out, pos, pos + text.length);
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
    bold: function () { wrap('**', '**'); },
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
      url = url.trim();
      var c = sel();
      var text = c.v.slice(c.s, c.e);
      // 文字を選んでいなければ、リンクに表示する文字を聞く（空のままなら、URLをそのまま表示する）
      if (!text) {
        var typed = window.prompt('リンクに表示する文字（空のままなら、URLを表示します）', '');
        if (typed === null) return;
        text = typed.trim() || url;
      }
      var md = '[' + text + '](' + url + ')';
      var caret = c.s + md.length;
      setText(c.v.slice(0, c.s) + md + c.v.slice(c.e), caret, caret);
    },
    callout: function (name) {
      var c = sel();
      var picked = c.v.slice(c.s, c.e);
      var head = ':::' + name + '\n' + picked;
      // 選択がなければ枠の中の空行に、あれば選んだ文字の後ろにカーソルを置く
      insertBlock(head + '\n:::', head.length);
    },
  };

  toolbar.addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-act]');
    if (!btn || btn === previewBtn) return;
    ev.preventDefault();
    var act = actions[btn.getAttribute('data-act')];
    if (act) act(btn.getAttribute('data-name'));
  });

  // 番号リスト・箇条書きの続き書き。IMEで変換中のEnter（確定）には反応しない
  ta.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    var c = sel();
    if (c.s !== c.e) return;
    var lineStart = c.v.lastIndexOf('\n', c.s - 1) + 1;
    var lineEndIdx = c.v.indexOf('\n', c.s);
    var lineEnd = lineEndIdx === -1 ? c.v.length : lineEndIdx;
    var m = c.v.slice(lineStart, lineEnd).match(/^(\s*)(\d+\.|[-*])[ \t]+(.*)$/);
    if (!m) return;
    // カーソルが記号より前（行の先頭付近）にあるときは、ふつうの改行にする
    if (c.s < lineStart + m[1].length + m[2].length + 1) return;
    ev.preventDefault();
    if (m[3].trim() === '') { // 中身が空の項目でEnter: 記号を消し、空行を1つ入れて、リストを終える（空行がないと、次の行が前の項目の続きになる）
      setText(c.v.slice(0, lineStart) + '\n' + c.v.slice(lineEnd), lineStart + 1, lineStart + 1);
      return;
    }
    var next = /^\d+\.$/.test(m[2]) ? (parseInt(m[2], 10) + 1) + '. ' : m[2] + ' ';
    var ins = '\n' + m[1] + next;
    setText(c.v.slice(0, c.s) + ins + c.v.slice(c.s), c.s + ins.length, c.s + ins.length);
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

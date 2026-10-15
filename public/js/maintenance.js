// サイト保守の一覧: 絞り込みチップと、列見出しによる並べ替え。
(function () {
  var table = document.getElementById('mt-table');
  if (!table) return;
  var body = table.tBodies[0];
  var rows = Array.prototype.slice.call(body.rows);
  var chips = document.querySelectorAll('.mt-chip');
  var count = document.getElementById('mt-count');
  var current = { filter: 'all', value: '' };

  function matches(row) {
    if (current.filter === 'urgent') return row.getAttribute('data-level') === 'urgent';
    if (current.filter === 'expiring') return row.getAttribute('data-expiring') === '1';
    if (current.filter === 'server') return row.getAttribute('data-server') === current.value;
    return true;
  }

  function applyFilter() {
    var shown = 0;
    rows.forEach(function (row) {
      var ok = matches(row);
      row.hidden = !ok;
      if (ok) shown += 1;
    });
    count.textContent = shown + '件を表示';
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
      chip.setAttribute('aria-pressed', 'true');
      current = { filter: chip.getAttribute('data-filter'), value: chip.getAttribute('data-value') || '' };
      applyFilter();
    });
  });

  // 列の並べ替え: 同じ列をもう一度押すと、逆順になる
  var keyIndex = { name: 0, status: 1, ssl: 2, domain: 3, backup: 4, inspect: 5 };
  var sorted = { key: null, dir: 1 };

  function cellValue(row, idx) {
    return row.cells[idx].getAttribute('data-sort-value') || '';
  }

  table.querySelectorAll('.mt-sort').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var key = btn.getAttribute('data-sort');
      var idx = keyIndex[key];
      sorted.dir = sorted.key === key ? -sorted.dir : 1;
      sorted.key = key;
      var numeric = key === 'status';
      rows.sort(function (a, b) {
        var x = cellValue(a, idx), y = cellValue(b, idx);
        var cmp = numeric ? Number(x) - Number(y) : x.localeCompare(y, 'ja');
        return cmp * sorted.dir;
      });
      rows.forEach(function (row) { body.appendChild(row); });
      table.querySelectorAll('th').forEach(function (th) { th.removeAttribute('aria-sort'); });
      btn.parentNode.setAttribute('aria-sort', sorted.dir === 1 ? 'ascending' : 'descending');
    });
  });
})();

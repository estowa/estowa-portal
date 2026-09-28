// ファイル添付欄のドラッグ&ドロップ対応
// .dropzone 内に <input type="file"> と(任意で) .dropzone-filelist を置くと動作する
// タスクのスライドインパネルなど、後からHTMLを差し込む場合は
// window.initDropzones(挿入した要素) を呼び出すと同じ処理を適用できる
function initDropzones(root) {
  (root || document).querySelectorAll('.dropzone').forEach((zone) => {
    if (zone.dataset.dropzoneInit === '1') return; // 二重初期化防止
    zone.dataset.dropzoneInit = '1';

    const input = zone.querySelector('input[type=file]');
    if (!input) return;
    const fileListEl = zone.querySelector('.dropzone-filelist');

    function renderFileNames() {
      if (!fileListEl) return;
      const files = Array.from(input.files || []);
      fileListEl.textContent = files.length ? `選択中: ${files.map((f) => f.name).join('、')}` : '';
    }

    input.addEventListener('change', renderFileNames);

    ['dragenter', 'dragover'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('dragover');
      });
    });
    zone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return;
      try {
        const merged = new DataTransfer();
        Array.from(input.files || []).forEach((f) => merged.items.add(f));
        Array.from(dt.files).forEach((f) => merged.items.add(f));
        input.files = merged.files;
      } catch (err) {
        // DataTransferのコンストラクタが使えないブラウザ向けフォールバック
        input.files = dt.files;
      }
      renderFileNames();
    });
  });
}
window.initDropzones = initDropzones;
document.addEventListener('DOMContentLoaded', () => initDropzones(document));

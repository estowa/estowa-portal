const fs = require('fs');
const path = require('path');

// 添付ファイル（画像・PDFなど、すべて）は、メッセージから15日たったら自動で削除する（メッセージの文字は残す）
const ATTACHMENT_KEEP_DAYS = 15;
const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;

// 期限を過ぎた添付の実体を消し、削除済みとして記録する（行は残して、画面に「削除されました」と出す）。消した件数を返す
function purgeOldAttachments(db, dir, days = ATTACHMENT_KEEP_DAYS) {
  const rows = db
    .prepare(
      `SELECT f.id, f.stored_name FROM chat_files f JOIN chat_msgs m ON m.id = f.msg_id
       WHERE f.deleted_at IS NULL AND m.created_at < datetime('now', ?)`
    )
    .all(`-${days} days`);
  const mark = db.prepare("UPDATE chat_files SET deleted_at = datetime('now') WHERE id = ?");
  const base = path.resolve(dir);
  for (const r of rows) {
    // 置き場の外は消さない（保存名は自分で作った名前だが、念のため）
    const target = path.resolve(base, path.basename(r.stored_name));
    if (path.dirname(target) === base) {
      try {
        fs.unlinkSync(target);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          console.error('[chat] 添付の削除に失敗:', e.message);
          continue; // 消せなかったものは記録せず、次回やり直す
        }
      }
    }
    mark.run(r.id);
  }
  return rows.length;
}

// 起動1分後と6時間おきに実行する。CHAT_CLEANUP_DISABLED=1 で止められる
function startScheduler(db, dir) {
  const run = () => {
    try {
      const n = purgeOldAttachments(db, dir);
      if (n > 0) console.log(`[chat] 期限切れの添付を${n}件削除しました`);
    } catch (e) {
      console.error('[chat] 添付の自動削除でエラー:', e.message);
    }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, RUN_INTERVAL_MS).unref();
}

module.exports = { ATTACHMENT_KEEP_DAYS, purgeOldAttachments, startScheduler };

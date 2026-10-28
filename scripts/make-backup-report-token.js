// PCのバックアップ取得結果を受け取る口（POST /api/maintenance/backup-report）用の、専用トークンを作る。
// 作ったトークンは、画面には出さず、.env に直接追記する（すでにあれば何もしない）。
// 実行: node scripts/make-backup-report-token.js
// PC側（estowa_ai の .env）へは、本人がこのサーバーの .env から値を写す。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (/^BACKUP_REPORT_TOKEN=.+/m.test(current)) {
  console.log('BACKUP_REPORT_TOKEN は、すでに .env にあります（変更していません）');
} else {
  const token = crypto.randomBytes(32).toString('hex');
  const line = `BACKUP_REPORT_TOKEN=${token}\n`;
  const cleaned = current.replace(/^BACKUP_REPORT_TOKEN=\s*$\n?/m, '');
  fs.writeFileSync(envPath, cleaned + (cleaned && !cleaned.endsWith('\n') ? '\n' : '') + line);
  console.log('BACKUP_REPORT_TOKEN を .env に追記しました（値は表示しません）。反映するには、サービスを再起動してください');
}

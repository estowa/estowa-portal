// プッシュ通知用の鍵（VAPID）を作って表示する。出力を .env に貼る（ファイルには保存しない）
// 実行: node scripts/make-vapid-keys.js
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:実在の連絡先のメールアドレス');

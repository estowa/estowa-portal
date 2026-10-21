const path = require('path');

// チャットの添付の置き場。公開フォルダ（public/）の外に置き、ダウンロードは部屋のメンバーだけに許す
const CHAT_FILES_DIR = path.join(__dirname, '..', 'db', 'chat-files');

module.exports = { CHAT_FILES_DIR };

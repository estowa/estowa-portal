// メール送信ユーティリティ(SMTP設定は環境変数から読み込む)
// 未設定の場合は送信をスキップし、コンソールに警告を出すだけにする
// (ローカル開発やSMTP未設定のデプロイでもアプリ自体は落ちないようにするため)

const nodemailer = require('nodemailer');

let transporter = null;
let warned = false;

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === 'true', // 465の場合はtrue、587などはfalse(STARTTLS)
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

// 会社の公開URL(メール本文内のリンク生成に使用)
function getBaseUrl() {
  return process.env.APP_BASE_URL || 'https://estowa-portal.onrender.com';
}

// to: メールアドレスの配列(空・null・重複は自動で除去)
async function sendMail({ to, subject, text, html }) {
  const recipients = Array.from(new Set((to || []).filter(Boolean)));
  if (recipients.length === 0) return;

  const t = getTransporter();
  if (!t) {
    if (!warned) {
      console.warn('[mailer] SMTP未設定のためメール送信をスキップしました(SMTP_HOST/SMTP_USER/SMTP_PASSを設定してください)');
      warned = true;
    }
    return;
  }

  try {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: recipients.join(','),
      subject,
      text,
      html,
    });
  } catch (err) {
    console.error('[mailer] メール送信に失敗しました:', err.message);
  }
}

module.exports = { sendMail, isConfigured, getBaseUrl };

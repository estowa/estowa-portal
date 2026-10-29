// セッションの署名に使う秘密鍵。.env の SESSION_SECRET から読む。
// 本番（APP_BASE_URL が https）で未設定のまま、誰でも知っている開発用の固定値で動いてしまうのを防ぐため、起動を止める

const DEV_SECRET = 'estowa-portal-dev-secret';

function resolveSessionSecret(env = process.env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (/^https:/i.test(env.APP_BASE_URL || '')) {
    throw new Error('SESSION_SECRET が未設定です。本番では .env に設定してください');
  }
  return DEV_SECRET;
}

module.exports = { resolveSessionSecret, DEV_SECRET };

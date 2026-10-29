// ログインの失敗が続いたとき、しばらくログインを止める（パスワードの総当たり対策）。
// 「同じID」と「同じ接続元」の両方で数える。メモリ上だけで持つので、再起動すると消える
//
// 注意: nginxの背後では、trust proxy を設定するまで接続元は全員同じ（127.0.0.1）に見える。
// そのため接続元の上限はIDの上限よりずっと緩くしてある

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_USER = 10;
const MAX_FAILS_PER_IP = 50;

function createLoginThrottle({ now = () => Date.now() } = {}) {
  const fails = new Map(); // キー → 失敗した時刻の並び

  function recent(key) {
    const t = now();
    const list = (fails.get(key) || []).filter((x) => t - x < WINDOW_MS);
    if (list.length) fails.set(key, list);
    else fails.delete(key);
    return list;
  }

  const userKey = (userId) => 'u:' + String(userId || '').trim().toLowerCase().slice(0, 100);
  const ipKey = (ip) => 'ip:' + String(ip || '');

  return {
    // ログインを試させてよいか
    isBlocked(userId, ip) {
      return recent(userKey(userId)).length >= MAX_FAILS_PER_USER || recent(ipKey(ip)).length >= MAX_FAILS_PER_IP;
    },
    recordFailure(userId, ip) {
      const t = now();
      for (const key of [userKey(userId), ipKey(ip)]) {
        const list = recent(key);
        list.push(t);
        fails.set(key, list);
      }
    },
    // ログインできたら、そのIDの失敗は忘れる
    recordSuccess(userId) {
      fails.delete(userKey(userId));
    },
    // 古い記録を捨てる（メモリを増やし続けないため）
    sweep() {
      for (const key of [...fails.keys()]) recent(key);
    },
  };
}

module.exports = { createLoginThrottle, WINDOW_MS, MAX_FAILS_PER_USER, MAX_FAILS_PER_IP };

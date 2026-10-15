// サイトのURLを検証して、同じサイトが同じ文字列になるようにそろえる。
// 認証情報つきのURL・http(s)以外・ホスト名がおかしいものは断る。

function normalizeSiteUrl(input) {
  let s = String(input || '').replace(/　/g, ' ').trim();
  if (!s) throw new Error('URLを入力してください');

  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) throw new Error('URLは http:// か https:// で始めてください');
  if (!scheme) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch (e) {
    throw new Error('URLの形式が正しくありません');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URLは http:// か https:// で始めてください');
  if (u.username || u.password) throw new Error('URLにIDやパスワードは含められません');
  if (!u.hostname || !u.hostname.includes('.')) throw new Error('URLの形式が正しくありません');

  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}/`;
}

module.exports = { normalizeSiteUrl };

// 「まとめて追加」の入力（1行1サイト）を読む。
// 形式: 名前,URL,サーバー名,種別（カンマかタブ区切り。サーバー名・種別は省略可。種別は「自社」か「受託」）

const { normalizeSiteUrl } = require('./siteUrl');

const MAX_LINES = 200;
const TYPE_MAP = { 自社: 'own', own: 'own', 受託: 'client', client: 'client' };

function parseBulk(text, existingUrls = []) {
  const existing = new Set(existingUrls);
  const seen = new Set();
  const rows = [];
  const errors = [];
  let counted = 0;

  String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/　/g, ' ').trim();
      if (!line || line.startsWith('#')) return;

      counted += 1;
      if (counted > MAX_LINES) {
        if (counted === MAX_LINES + 1) errors.push({ line: i + 1, text: '', message: `一度に追加できるのは${MAX_LINES}件までです` });
        return;
      }

      const [name, urlRaw, server = '', typeRaw = ''] = line.split(/\t|,/).map((s) => s.trim());
      const fail = (message) => errors.push({ line: i + 1, text: raw, message });

      if (!name || !urlRaw) return fail('名前とURLを入れてください');
      let url;
      try {
        url = normalizeSiteUrl(urlRaw);
      } catch (e) {
        return fail(e.message);
      }
      if (typeRaw && !TYPE_MAP[typeRaw]) return fail('種別は「自社」か「受託」で入れてください');
      if (existing.has(url) || seen.has(url)) return fail('すでに登録されているURLです');

      seen.add(url);
      rows.push({ line: i + 1, name, url, server_name: server, client_type: TYPE_MAP[typeRaw] || 'client' });
    });

  return { rows, errors };
}

module.exports = { parseBulk, MAX_LINES };

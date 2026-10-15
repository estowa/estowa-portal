const test = require('node:test');
const assert = require('node:assert');
const { parseBulk } = require('../lib/maintenanceImport');

test('1行1サイト。カンマ・タブどちらの区切りでも読める。種別は省略すると受託', () => {
  const r = parseBulk('estowa.jp,estowa.jp,ss256422,自社\nNAO\tnao-asobiba.com\tss170071\n', []);
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.rows.map((x) => [x.name, x.url, x.server_name, x.client_type]), [
    ['estowa.jp', 'https://estowa.jp/', 'ss256422', 'own'],
    ['NAO', 'https://nao-asobiba.com/', 'ss170071', 'client'],
  ]);
});

test('空行と # で始まる行は無視する。行番号は元の行を指す', () => {
  const r = parseBulk('# メモ\n\nA,a.example.com\nB,\n', []);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.errors[0].line, 4);
});

test('URL不正・種別不正・重複（取り込み内／登録済み）は、行ごとにエラーにして、他の行は通す', () => {
  const r = parseBulk(
    ['A,a.example.com', 'B,ftp://b.example.com', 'C,c.example.com,s1,謎', 'D,a.example.com', 'E,e.example.com'].join('\n'),
    ['https://e.example.com/']
  );
  assert.deepStrictEqual(r.rows.map((x) => x.name), ['A']);
  assert.deepStrictEqual(r.errors.map((e) => e.line), [2, 3, 4, 5]);
  assert.match(r.errors[3].message, /登録/);
});

test('全角スペースや全角カンマ以外の混在でも崩れない。名前だけの行はエラー', () => {
  const r = parseBulk('名前だけ\n　A　,　a.example.com　', []);
  assert.strictEqual(r.rows[0].name, 'A');
  assert.strictEqual(r.errors[0].line, 1);
});

test('一度に追加できるのは200件まで。超えた分は、1件のエラーにまとめる', () => {
  const text = Array.from({ length: 205 }, (_, i) => `S${i},s${i}.example.com`).join('\n');
  const r = parseBulk(text, []);
  assert.strictEqual(r.rows.length, 200);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /200件/);
});

test('空の入力は、行もエラーもなし', () => {
  assert.deepStrictEqual(parseBulk('', []), { rows: [], errors: [] });
  assert.deepStrictEqual(parseBulk(null, []), { rows: [], errors: [] });
});

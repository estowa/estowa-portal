# estowa-portal

estowa（デザイン会社）の社内ポータルアプリ。Node.js / Express / EJS / better-sqlite3。
GitHub (`estowa/estowa-portal`) → 本番はConoHa VPS（`https://portal.estowa.com`）。
（2026-10-05にRenderからVPSへ移行。Renderは旧環境で、使わない。）

依頼者はエンジニアではない（iPadのSafariなどブラウザから指示することが多い）。
専門用語を避け、変更内容と確認方法を日本語で分かりやすく伝えること。

## セットアップ（ローカル開発）

```
npm install        # postinstallでdb/init.jsが自動実行され、db/estowa.dbが作られる
node server.js      # http://localhost:3000
```

初期管理者: `admin` / `estowa2026`（ログイン後に変更を促す仕組みあり）。

メール通知（タスク更新時）を使う場合は `.env.example` を参考に `.env` を用意する
（SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS / MAIL_FROM / APP_BASE_URL）。
本番は2026-10-09から稼働中（netowlのSMTP、`portal@estowa.jp`、587番・STARTTLS）。
`@estowa.jp`からGmailへ転送されると迷惑メールに入ることがある（estowa.jpにDKIM・DMARCなし。netowlへ問い合わせ予定）。

## デプロイ

**本番はConoHa VPS（Ubuntu 24.04、`https://portal.estowa.com`）。VPSへは自動デプロイされない。**
変更の流れ: ローカルで確認 → `git push origin main` → VPSで反映（人の承認を得てから行う）。

VPSでの反映手順（`ssh deploy@160.251.181.171`、鍵ログインのみ）:
```
cd ~/estowa-portal
git pull
npm install                          # 毎回実行する（DBの項目追加=マイグレーションも、ここで自動実行される）
sudo systemctl restart estowa-portal
```
- DBとアップロード（`db/*.db`、`public/uploads/`）はGit管理外なので、`git pull`では消えない。
- 本番のDB・`.env`は、VPS上にだけある。**ローカルから本番へ上書きしない。**
- ログ確認: `journalctl -u estowa-portal -n 100`
- 構成: Node（systemd常駐）＋ nginx（HTTPS、`/ws/chat`のUpgrade設定済み）＋ coturn（TURN）。
- バックアップ: サーバー内に毎日3時（`~/backup/`、14日分）、PCへ毎日9時にコピー
  （`scripts/backup-vps.ps1`はestowa_ai側）。
- 設定・手順の詳細は、estowa_aiリポジトリの`docs/vps-setup.md`を参照。
- `git push origin main`をすると、旧環境のRenderにも自動で反映されるが、Renderは使わない
  （無料プランのためデプロイのたびにデータが消える）。

## ローカルでDBをリセットする時の手順（重要）

better-sqlite3はWALモードを使うため、サーバープロセスを止めずに`db/estowa.db`を
消すと不整合が起きることがある。必ず以下の順で行う。

1. `node server.js` のプロセスを完全に停止し、`ps aux | grep node` で残っていないか確認
2. `rm -f db/estowa.db db/estowa.db-wal db/estowa.db-shm db/sessions.db`
3. `node db/init.js` を実行し、テーブルが作られたことを直接クエリして確認
4. そのあとで `node server.js` を起動

## アーキテクチャ・実装パターン

- **スライドインパネル**: タスク管理・アイディアの新規登録/編集は、一覧ページ右から
  スライドインするパネルで行う。一覧の裏にあるURL（`/tasks/new`など）に対し、JS側が
  `X-Requested-With: fetch` ヘッダー付きでfetchし、サーバーはヘッダーの有無で
  「ヘッダー・フッターなしの断片HTML」か「通常のフルページ」かを出し分けている
  （各routesファイルの`isFetch(req)`ヘルパー参照）。フォーム送信も同じ仕組みで
  fetch経由にし、ページ遷移なく結果を反映する。
- **ネストした`<form>`は厳禁**: 添付ファイルの削除ボタンなどを、タイトル編集用の
  メイン`<form>`の中にネストして置くと、HTMLパース仕様上ブラウザがネストした
  `<form>`タグを無視し、削除ボタンを押すとメインフォーム（保存）が送信されて
  しまうという不具合が過去に実際に発生した（お知らせ編集・ナレッジ編集で発生し
  修正済み）。添付ファイル一覧の削除フォームは必ずメインフォームの外側（別の
  `.panel`など）に置くこと。
- **ファイル添付の文字化け対策**: multer/busboyはmultipartのファイル名ヘッダーを
  デフォルトでlatin1として解釈するため、日本語ファイル名が文字化けする。
  `lib/uploads.js`の`createUploader()`内`fileFilter`で
  `Buffer.from(file.originalname, 'latin1').toString('utf8')`により補正している。
  既存の文字化け済みデータは`db/init.js`の`repairMojibake()`が起動時に自動修復する
  （対象: task_attachments, announcement_attachments, knowledge_attachments,
  idea_attachments）。新しい添付機能を追加する場合も同じ`createUploader()`を
  使えば自動的にこの対策が効く。
- **JST時刻**: SQLiteには`datetime('now')`でUTCが保存される。表示・比較時は
  `lib/jst.js`のヘルパー（`formatJst`, `nowJstDateTimeStr`, `toJstParts`,
  `nowJstYearMonth`）を必ず使うこと（生のUTC文字列をそのまま表示すると9時間ずれる）。
- **EC売上CSVインポート** (`routes/sales.js`): 受注管理システムROBOTINの出力は
  Shift_JIS(CP932)。`decodeCsvBuffer()`がUTF-8として読めない場合に自動でCP932に
  フォールバックする。モールの判定は「店舗ID」列から`STORE_ID_TO_MALL`で変換
  （296:楽天 / 1070:ヤフー / 4646736:Qoo10 / 7588758:カウシェ / 15056676:メルカリ /
  8669150:ギフトモール）。未知の店舗IDは`店舗ID:xxxx`として取り込み、データを
  取りこぼさない。
- **カテゴリの色分け**: 外注先リスト(`lib/vendorCategories.js`)・ナレッジ共有
  (`lib/knowledgeCategories.js`)は固定カテゴリ一覧+色のペア定義を持ち、
  `colorForCategory()`でバッジ色を決める。アイディアストックはあえて固定リストに
  せず、都度自由入力（候補はdatalistで過去のカテゴリを表示）にしている。
- **リンク色**: クリックできるタイトルは`.link-title`クラス（`var(--primary)`色）
  で統一している。新しい一覧を作る際もこれに合わせる。
- **チャット・音声**: ホーム画面の`partials/chat.ejs`＋`public/js/chat.js`・`voice.js`。
  サーバーは`lib/chatSocket.js`（ws、`/ws/chat`、既存セッションで認証）→`lib/chatHub.js`
  （接続管理・中継）。会話できるのは「在宅フラグ（`users.is_remote`、常に1人）の人 ↔
  その他の各人」のみで、判定は`lib/chatRules.js`の`canPair`に集約している（社内同士は
  サーバー側で拒否）。音声は在宅側が各社内の人へWebRTCを1本ずつ常時接続し、「話す」を
  クリックで話し始め、もう一度クリックで終わる間だけ送信トラックを差し込む（5分で自動停止。
  録音・保存はしない）。受信音声は相手が話して
  いる間だけ鳴らし、「消音」で話しかけられても鳴らさない設定もできる。複数タブで開いた
  場合、音声の接続情報は最新のタブにだけ届く。チャットはホーム画面を開いている間だけ動く。
  TURNは`.env`の`TURN_URL`/`TURN_USER`/`TURN_PASS`で設定（未設定ならSTUNのみ。
  別回線同士で繋がらない場合はTURNが必要）。HTTPS必須（マイク利用のため）。
  VPSでnginx等のリバースプロキシを使う場合は`/ws/chat`にUpgradeヘッダーを通す設定が必要。
  ローカル確認用のダミーアカウントは`node db/seed-chat-dummy.js`（本番では実行不可）。
- **サイト保守（自動確認）**: `lib/siteCheckRunner.js` が、起動1分後と6時間おきに、登録サイトのURLへ外から1回アクセスし、応答・応答時間・SSL証明書の期限を保存する（ドメイン期限は、取れていれば20時間ごと・取れていなければ1時間ごとに、1件ずつ順に取得。`.com`/`.net` は登録元Verisignの公開RDAPへ直接、`.jp` は日本レジストリ（JPRS）のWHOIS、その他は rdap.org へ、ドメイン名だけを送る。rdap.org は短時間に続けると429で断るため、`.com`/`.net` では使わない。`guidebook.jp` など他社の共有ドメインは問い合わせない＝`DOMAIN_LOOKUP_SKIP`）。本文は保存しない。内部アドレス（127.x・10.x・169.254.x・::1 など）と、そこへの転送には、接続しない（`lib/siteChecker.js` の `isBlockedAddress` / `safeLookup`）。`allowPrivate` はテスト専用で、本番のコードから渡さない。ログインが必要な情報（更新状況・バックアップ日）は取得せず、「点検記録」の手入力から出す。メンバーも閲覧できるため、運用状況だけを置き、侵入経路・不審ファイルの詳細・アカウント情報・個人情報は書かない。`SITE_CHECK_DISABLED=1` で、定期確認を止められる。

- **PWA・プッシュ通知**（2026-10-21追加）: `public/manifest.webmanifest`・`public/sw.js`（通知の受信とオフライン案内。画面のデータは保存しない）・`public/icons/`。全ページの`partials/header.ejs`で読み込み、`partials/footer.ejs`でService Workerを登録。通知の中身・送信は`lib/push.js`（`db`を引数で受ける。`notify(db, 種類, 候補ユーザー, 中身, 除く本人)`）、テーブルは`lib/pushSchema.js`（起動時と`db/init.js`で作成）、設定ページは`/notifications`（`routes/push.js`）、ホーム画面への追加の案内は`/install`。通知の種類: タスク追加（担当者へ）・タスクのステータス変更（担当者+作成者へ）・新着お知らせ（全員へ）・チャット新着（相手がチャットを開いていないときだけ、本文は載せず「誰から」だけ）。いずれも操作した本人には送らず、各自が種類ごとにオン・オフできる（初期は全部オン）。鍵（VAPID）は`.env`の`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`（`node scripts/make-vapid-keys.js`で作る。ローカルと本番で別々）。`PUSH_DISABLED=1`で送信を止められる。iPhoneはホーム画面に追加したアイコンから開いたときだけ通知が届く。通知の送信失敗で、元の操作（タスク保存など）は失敗させない。
- **アイコンの赤い数字（バッジ）**（2026-10-21追加）: `lib/badge.js`が、その人の未読の合計（未読のお知らせ＋未読のチャット＋自分が担当で未完了の新着タスク）を数える。新着タスク＝まだ詳細を開いていない、または開いたあとに他の人が更新したもの（`task_seen`テーブル。`GET /tasks/:id`で記録。導入時に、今ある担当タスクは「見た」扱いにした）。通知には`badge`として件数を付けて送り（`lib/push.js`の`sendToUser`）、`public/sw.js`の`updateBadge`が`setAppBadge`で更新。ページ表示時と、アプリに戻ったとき（`GET /badge`）にも更新（`partials/footer.ejs`）。チャットを読んだ直後は、次の表示まで数字が遅れる。対応していない端末では何もしない。ポータル画面の中の目印（同日追加）: サイドバー（スマホは下のメニュー）の「ホーム」（チャット未読）・「タスク管理」（新着タスク）・「お知らせ」（未読）に赤い丸と件数（`partials/header.ejs`の`.nav-badge`）、ボードの新着タスクのカードに赤い点（`.unread-dot`。`routes/tasks.js`が`unreadTaskIds`を渡す）。`window.refreshAppBadge()`（`partials/footer.ejs`）が`GET /badge`（内訳つき）で、アイコンの数字とサイドバーの件数をまとめて取り直す。タスクのパネルを開いたとき・チャットで既読にしたとき・チャットの新着が届いたときに呼ぶ。

## 機能一覧（2026年10月時点）

ホーム（KPI・お知らせ・自分のタスク・勤怠・イベントカレンダー）/ タスク管理
（カンバン+カレンダー、複数担当者、添付、コメント、締切超過を赤字表示）/ お知らせ
（添付・既読管理）/ ナレッジ共有（Markdown記事・検索・カテゴリ色分け・添付）/
アイディアストック（スライドパネルで素早く登録、カテゴリ自由入力、添付）/
外注先リスト（カテゴリ別色分け）/ 共有シートリンク集 / 商品粗利表（表計算、Excel
インポート/エクスポート）/ EC売上ダッシュボード（ROBOTIN CSV取り込み、モール別
集計）/ 勤怠（個人の出退勤打刻、管理者向けメンバー別CSVダウンロード）/
ホーム画面のチャット・トランシーバー音声（在宅×社内、音量・消音）/ 全体検索（ヘッダーの窓。`lib/search.js`、`/search`）/ サイト保守ダッシュボード（管理しているWordPressサイトの稼働・SSL期限・ドメイン期限・バックアップ・点検を一覧。`routes/maintenance.js`、`lib/maintenance*.js`・`lib/siteChecker.js`。自動確認は外から見える情報だけで、サイトの認証情報は持たない。閲覧は全員・編集は管理者のみ）/ ユーザー管理・プロフィール（アバター設定）。

## 保留中の項目

- グッズ受注・印刷手配管理（カンバン）: 要望待ちで保留
- チャット・音声: VPS・HTTPS・TURN（coturn）で本番稼働。音声は2026-10-06に実機で確認済み
  （テスト用ダミーアカウントは削除済み）。同じアカウントで画面（タブ）を複数開くと、接続の
  申し込みが重なって通話が失敗する（設計上の制限）。複数の画面でも壊れないようにする修正は未実施

## テスト方法

自動テストは`npm test`（`node:test`、`tests/`配下）。チャットの権限・保存・中継のみ
カバーしている。それ以外は、変更後にローカルで一時サーバーを立て、curlまたは
Playwright（Chromiumは`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）で
実際に操作して確認してから報告する運用にしている。

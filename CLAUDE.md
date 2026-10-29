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

初期管理者: ID `admin`。初期パスワードは固定ではなく、`node db/init.js`（`npm install`のpostinstallも含む）が管理者を作った
その一度だけ、実行画面にランダムな値が表示される（見逃したら、DBをリセットして作り直す）。`.env`の`ADMIN_INITIAL_PASSWORD`で指定もできる。
ログイン後、管理者画面で必ず変更する。

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

- **スライドインパネル**: タスク管理の新規登録/編集は（アイディアは2026-10-29にナレッジと同じ専用ページへ変更）、一覧ページ右から
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
- **EC売上（発送月・税込）**（2026-10-28改修・本番反映済み）: 画面は`routes/sales.js`＋`views/sales/index.ejs`、処理は`lib/ecSales.js`、テーブルは`lib/ecSchema.js`（`ec_order_items`＝注文明細、`ec_products`＝商品コード一覧、`ec_monthly_mall`＝過去分のモール別月次売上）。**閲覧も取り込みも、ログインしている全員ができる**。(1)売上CSV（新仕様。2026年10月中旬〜。Shift_JISで自動判定）は、**受注番号がキー**で同じ注文は上書き（二重計上しない）。発送月は空欄で自動: 画面で指定があればそれ、なければファイル名の「11月発送分」、なければ受注日のいちばん多い月（ファイル全体で1つ。前月末の注文が混ざっても行ごとには分けない）。その月に過去分（月次）もあると、取り込み結果に警告を出す。**運用（2026-10-28決定）: 10月までは過去分（月次）、11月発送分から新CSV。**列は名前で選んで読む（受注番号・店舗名・商品コード・請求金額。店舗名で判定できなければ店舗IDで`STORE_ID_TO_MALL`）ため、個人情報の列は読まず保存もしない。0円の注文は件数に含む。(2)商品コード一覧（商品番号・商品名）は、アップのたびに**全部入れ替え**。商品別は商品コード別で、表示は商品名（一覧にないコードは「未登録」と警告）。(3)過去分CSV（月・モール・税込売上）は同じ月・モールを上書き。**同じ月に明細と過去分があれば明細を使う**（`mallTotalsForMonth`）。昨対比は昨年同月が基本で、`cmp`（1〜5）で2〜5年前も選べる。商品別の昨対は、比較年にも明細がある月だけ（2027年10月から）。旧`sales_orders`は残し（氏名・送付先の列は2026-10-29に本番から削除済み。削除前のDBは`~/backup/estowa-before-drop-*.db`と日次バックアップ14日分に残る）、`db/init.js`が月×モールの集計だけを`ec_monthly_mall`へ一度写す（既存の月・モールは上書きしない）。ホームの「今月のEC売上」も、今月（JST）の発送分の合計に変更。商品別は初期状態でたたみ（`<details class="ec-fold">`）、商品名のクリックでモール別の個数・売上がその場で開く。個数はCSVの「数量」列の合計（`ec_order_items.quantity`。空は1）。1つの注文に複数の商品行があるため、行のキーは「受注番号#明細ID」（明細IDの列がなければ受注番号のみ）。広告・販促は`ec_ads`（モール・期間・タイトル・内容・価格〔自由入力〕）で、選んだ月と重なるものを表示し、追加・編集・削除はログインしていれば誰でも（`POST /sales/ads`、`/sales/ads/:id`、`/sales/ads/:id/delete`）。
- **締切の色**（2026-10-29追加）: タスクボードのカードの締切は、過ぎたら赤（`due-overdue`）、24時間以内は橙（`due-soon`）。判定は`lib/taskDue.js`の`dueState`（完了済み・締切なしは色なし）。
- **タスク管理ページの配色**（2026-10-29）: ページ背景は白（`body:has(#tasks-board-root)`でこのページだけ）、列はグレー（`--bg`）、カードは白（担当者アイコンは白い縁なしで30px）。完了の列（`data-status="done"`）のカードは透過（opacity 0.55、ホバーで0.85）。CSSは`style.css`の末尾。
- **タスクカードの日時表示**（2026-10-29）: 開始（時間は任意）と締切を「開始 …」「締切 …」の2行で出す。当日は「今日 時間」、翌日は「明日 時間」、それ以外は日付（時間があれば付ける）。開始がなければ開始の行は出さない。開始が今日・明日のときは緑（`.when-near`）。締切は赤・橙の警告色が優先。判定は`lib/taskDate.js`の`formatWhen`（JSTの今日と比べる）。
- **カテゴリの色分け**: 外注先リスト(`lib/vendorCategories.js`)・ナレッジ共有
  (`lib/knowledgeCategories.js`)は固定カテゴリ一覧+色のペア定義を持ち、
  `colorForCategory()`でバッジ色を決める。アイディア
  (`lib/ideaCategories.js`)も固定3カテゴリ(ビジネス・ツール・メモ、2026-10-29に自由入力から変更。範囲外の値はメモにする)。
- **リンク色**: クリックできるタイトルは`.link-title`クラス（`var(--primary)`色）
  で統一している。新しい一覧を作る際もこれに合わせる。
- **チャット**（2026-10-21に全面改訂）: ホーム画面の`partials/chat.ejs`＋`public/js/chat.js`。**社内の全員が、全員と1対1で話せ、グループも作れ、ファイル・画像を添付できる**（在宅かどうかは関係ない）。テーブルは`lib/chatSchema.js`（`chat_rooms`＝部屋（`kind`は`dm`/`group`）、`chat_members`＝メンバーと既読位置（`last_read_id`）、`chat_msgs`、`chat_files`）。保存・権限は`lib/chatStore.js`に集約（メンバーでない人は、送信・履歴・添付の取得すべて拒否）。1対1の部屋は、初めて開いたときに作る（`dm_key`で同じ2人は同じ部屋）。**自分宛ての「自分（メモ）」**（2026-10-27追加）: 一覧の先頭に出る、自分だけの部屋（メンバーは自分1人。`getOrCreateDm`に同じ人を2回渡すと作られる）。他の人・管理者には見えず、通知・未読にもならない。添付も他の会話と同じく15日で消える（文字は残る）。**送信の取り消し**（2026-10-28追加・本番反映済み）: 自分が送ったメッセージだけ、本人が「取り消す」で消せる（管理者も他人の分は不可・時間制限なし。1対1・グループ・自分のメモすべて）。`POST /chat/messages/:id/delete`→`chatStore.deleteMessage`が本文を空にして`chat_msgs.deleted_at`を記録し、添付は`chat_files.deleted_at`を付けて実体も消す。取り消し後は跡を残さず、画面から消える（一覧にも出さない。`listMessages`は取り消し済みを除く）。部屋の全員の全接続へ`{type:'chat_deleted', room_id, id}`を配る（`chatHub.publishDeleted`。プッシュ通知は送らない）。取り消したものは未読に数えない。送信済みのプッシュ通知（本文なし）と、VPSのバックアップ（14日分）に残った取り消し前の内容は消せない。グループは**誰でも作れ**、メンバーなら誰でも追加・名前変更でき、抜けるのは本人だけ（追加された人は追加前の発言も読めるが、未読にはしない）。未読は「部屋の既読位置より後の、他人の発言」の数で、自分の発言では既読にならない。旧`chat_messages`は消さずに残し、起動時に1対1の部屋へ一度だけ引き継ぐ（未読の位置も保つ）。WebSocket（`lib/chatSocket.js`→`lib/chatHub.js`）は、文字の送信（`{type:'chat', room, body}`）・既読（`{type:'read', room}`）・オンライン状態（つながっている全員）・部屋の変更通知（`rooms`）・通話の中継を担う。添付つきの送信はHTTP（`POST /chat/rooms/:id/messages`、multipart、1ファイル10MB・5つまで、`lib/uploads.js`の拒否拡張子あり）で行い、保存後に`lib/chatBus.js`経由でハブが配る。添付の実体は`db/chat-files/`（`public/`の外・Git管理外）に置き、`GET /chat/files/:id`で部屋のメンバーだけに渡す（画像png/jpg/gif/webpとPDFは開いて見られ、それ以外は保存。`?download=1`で画像・PDFも保存。`nosniff`つき、画像にはCSPつき。PDFはCSPのsandboxを付けるとブラウザの表示が動かないため付けない）。**添付ファイル（画像・PDFなどすべて）は、メッセージから15日たつと自動削除**（`lib/chatCleanup.js`。起動1分後と6時間おき。実体のファイルだけを消し、メッセージの文字は残す。画面には「15日たったので削除されました」と出る。`chat_files.deleted_at`に記録。`CHAT_CLEANUP_DISABLED=1`で止められる。**VPSのバックアップ（14日分）には、削除前の添付が残る**）。**本番のバックアップ（`~/backup.sh`）は`public/uploads`と`db/estowa.db`だけなので、`db/chat-files/`を足す必要がある**。プッシュ通知は、接続のない人だけに送り、本文は載せない（1対1は「○○さんから」、グループは「グループ名に新着」）。
- **通話**（チャットとは別のパネル。`partials/voice.ejs`＋`public/js/voice.js`）: 会話できるのは「在宅フラグ（`users.is_remote`、常に1人）の人 ↔ その他の各人」のみで、判定は`lib/chatRules.js`の`canPair`（社内同士はサーバー側で拒否）。通話の相手一覧は`/chat/state`の`voicePeers`。通話は「呼び出し→応答→通話」の電話方式（2026-10-21に、トランシーバー方式から変更）: 「通話する」で相手に着信が届き、相手が「応答する」を押すと、両方のマイクが開いてお互いの声が聞こえる（相手の許可なくマイクは開かない）。どちらかが「通話を終える」まで続く（30分で自動終了。45秒応答がなければ不在。相手がオフライン・ページを閉じても終了。話し中は`busy`）。通話の状態はサーバー（`lib/chatHub.js`の`calls`）が持ち、メッセージは`{type:'call', to, action:'invite'|'accept'|'decline'|'end'}`・返りは`invite`/`accepted`/`ended`（`reason`: declined/missed/offline/busy/ended/limit）。声は、在宅側が各社内の人へWebRTCを1本ずつ常時接続しておき、通話中だけ両側のマイクを差し込んで再生する（録音・保存はしない）。着信は、着信音（「音声ON」を押した画面だけ。3秒の音声ファイルをその場で生成して繰り返し再生する。タイマーに頼らないので、背景のタブでも止まりにくい。2026-10-27に、WebAudioのタイマー方式から変更）・タブの見出しの点滅・応答ボタンで知らせ、画面が見えていない相手にはプッシュ通知（種類`call_incoming`）も送る。**通話の受け口は、「音声ON」を押した画面のうち最新のもの**（`{type:'voice', ready, visible}`で伝える。なければ最新の接続）で、複数の画面・端末を開いても通話が混ざらない（以前の制限を解消）。ホーム以外のページでは接続がないため着信音は鳴らず、プッシュ通知で知らせる。旧トランシーバー方式の`ptt`はサーバーに残っているが、画面は使わない。 TURNは`.env`の`TURN_URL`/`TURN_USER`/`TURN_PASS`で設定（未設定ならSTUNのみ。別回線同士で繋がらない場合はTURNが必要）。HTTPS必須（マイク利用のため）。VPSでnginx等のリバースプロキシを使う場合は`/ws/chat`にUpgradeヘッダーを通す設定が必要。nginxの`client_max_body_size`は20m設定済み（10MBの添付が通る）。ローカル確認用のダミーアカウントは`node db/seed-chat-dummy.js`（本番では実行不可）。
- **タスクボードの並べ替え・タッチ操作**（2026-10-28追加）: 列の中でカードをドラッグして順序を入れ替えられ、別の列へも置いた位置に入る（`POST /tasks/:id/place`＝`status`と`before_id`〔置いた位置のすぐ下のカード。空なら末尾〕。`lib/taskOrder.js`の`placeTask`が、その列の全タスクに`tasks.sort_order`を1,2,3…と付け直す。並びは全員共通、ボード〔社内全体/プロジェクト〕ごと）。並べ替えていないタスク（新規など）は`sort_order`がNULLで、列の一番上に出て、その中は従来どおり締切日順（`TASK_ORDER_SQL`）。ドラッグはPointer Eventsの自前実装で、**要素をDOM内で動かすとポインタの捕捉が外れる**ため、動かすたびに`setPointerCapture`し直している。タッチ・ペンは、カード右端の「つまみ」（`.kanban-grip`、`(hover:none),(pointer:coarse)`の端末だけ表示）からだけドラッグでき、カードの他の部分は指でスクロールできる（以前はカード全体が`touch-action:none`で、タブレット横置きで縦スクロールしづらかった）。マウスはカード全体でドラッグ。列・画面の端に近づくと自動スクロール。ボードのカード内の担当者アイコンは24px（他画面は従来のまま）。
- **ページ移動の「本文の入れ替え」と、通話・チャットの常駐**（2026-10-28追加・本番反映済み）: 通話しながら他のページを見られるよう、同じサイト内のリンクと検索（GETフォーム）は、画面全体を読み込み直さず`<main class="main">`の中身だけを入れ替える（`public/js/nav.js`。URL・戻る・タイトル・サイドバーの選択は更新。ダウンロード・別タブ・`#`つき・ログイン画面への転送・失敗時は、ふつうの移動。`data-no-swap`を付けると入れ替えない）。**POSTのフォームはふつうの移動**（通話中は`beforeunload`でブラウザが確認を出す）。入れ替えた本文の`<script>`は`nav.js`が作り直して順に実行する。ページ側のスクリプトが`window`/`document`に付けたイベントは、`<head>`で読む`public/js/page-scope.js`が記録して次の移動で外す（`DOMContentLoaded`/`load`は入れ替え中はすぐ実行）。**ページのスクリプトは、`window`・`document`に付けたイベントがその仕組みで外れる前提で書く（トップレベルの`const`/`let`は再実行でエラーになるのでIIFEで包む）**。チャット・通話の本体（`partials/chat.ejs`・`partials/voice.ejs`と`chat.js`・`voice.js`）は、全ページ共通の`partials/footer.ejs`の`#realtime-holder`に置き、ホームだけ`home.ejs`の枠（`#chat-slot`・`#voice-slot`、CSSは`display: contents`）へ`nav.js`が移し入れする（ほかのページでは画面の外で動かし続ける＝接続・WebRTC・通話が切れない）。チャットは枠に入っているときだけ「見ている」扱い（`chat.js`の`panelVisible`）で、離れている間に届いたものは未読に数える。通話の表示（呼び出し・着信・通話中・エラー）は、全ページ下部の通話バー`#voice-callbar`（footer.ejs）に出る（ホームの通話パネルには「音声ON」・音量・相手一覧だけ）。「音声ON」は`sessionStorage`（`estowaVoiceOn`）に覚え、再読み込み後は自動で戻す（ブラウザに止められたら、バーの「音声ON」ボタンを押してもらう）。`window.estowaVoiceBusy()`が通話中かを返す。
- **サイト保守（自動確認）**: `lib/siteCheckRunner.js` が、起動1分後と6時間おきに、登録サイトのURLへ外から1回アクセスし、応答・応答時間・SSL証明書の期限を保存する（ドメイン期限は、取れていれば20時間ごと・取れていなければ1時間ごとに、1件ずつ順に取得。`.com`/`.net` は登録元Verisignの公開RDAPへ直接、`.jp` は日本レジストリ（JPRS）のWHOIS、その他は rdap.org へ、ドメイン名だけを送る。rdap.org は短時間に続けると429で断るため、`.com`/`.net` では使わない。`guidebook.jp` など他社の共有ドメインは問い合わせない＝`DOMAIN_LOOKUP_SKIP`）。本文は保存しない。内部アドレス（127.x・10.x・169.254.x・::1 など）と、そこへの転送には、接続しない（`lib/siteChecker.js` の `isBlockedAddress` / `safeLookup`）。`allowPrivate` はテスト専用で、本番のコードから渡さない。ログインが必要な情報（更新状況・バックアップ日）は取得せず、「点検記録」の手入力から出す。メンバーも閲覧できるため、運用状況だけを置き、侵入経路・不審ファイルの詳細・アカウント情報・個人情報は書かない。`SITE_CHECK_DISABLED=1` で、定期確認を止められる。

- **サイト保守へのPCバックアップ取得結果の反映**（2026-10-28追加・本番反映済み）: PC（estowa_aiの`backup_pull.py`）が取得した結果を、`POST /api/maintenance/backup-report`（`routes/maintenanceBackupApi.js`）が受ける。ログインではなく、`.env`の`BACKUP_REPORT_TOKEN`（`Authorization: Bearer …`。未設定なら503、違えば401。`node scripts/make-backup-report-token.js`が`.env`へ直接追記し、値は表示しない。PC側へは本人が写す）。本文は`{results:[{url, ok, date:'YYYY-MM-DD', size_bytes, error}]}`（100KB・100件まで）。`error`は`connect/auth/verify/size/other`のどれかだけ（これ以外は`other`。自由な文章・ファイル名・パスは受け取らない）。サイトは登録URLと照合し（`normalizeSiteUrl`）、登録のないものは無視して件数だけ返す（`{ok, recorded, failed, ignored}`）。成功は`maintenance_logs`（kind=バックアップ、`created_by='auto:pc-backup'`、noteは「PC取得 ○MB」）に追加し、同じサイト・日付は更新する。結果は`maintenance_sites.pc_report_at/ok/error`、`pc_backup_size`にも保存（最後の結果）。失敗は警告（`pc_backup_failed`）、結果が14日以上届かないと警告（`pc_backup_silent`。一度も届いていないサイトは対象外。`LIMITS.PC_BACKUP_SILENT_DAYS`）。一覧は「PC取得済み・サイズ」「PC取得に失敗」、詳細は「PC取得」の行に出す。処理は`lib/maintenanceBackupReport.js`。
- **PWA・プッシュ通知**（2026-10-21追加）: `public/manifest.webmanifest`・`public/sw.js`（通知の受信とオフライン案内。画面のデータは保存しない）・`public/icons/`。全ページの`partials/header.ejs`で読み込み、`partials/footer.ejs`でService Workerを登録。通知の中身・送信は`lib/push.js`（`db`を引数で受ける。`notify(db, 種類, 候補ユーザー, 中身, 除く本人)`）、テーブルは`lib/pushSchema.js`（起動時と`db/init.js`で作成）、設定ページは`/notifications`（`routes/push.js`）、ホーム画面への追加の案内は`/install`。通知の種類: タスク追加（担当者へ）・タスクのステータス変更（担当者+作成者へ）・新着お知らせ（全員へ）・チャット新着（相手がチャットを開いていないときだけ、本文は載せず「誰から」だけ）。いずれも操作した本人には送らず、各自が種類ごとにオン・オフできる（初期は全部オン）。鍵（VAPID）は`.env`の`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`（`node scripts/make-vapid-keys.js`で作る。ローカルと本番で別々）。`PUSH_DISABLED=1`で送信を止められる。iPhoneはホーム画面に追加したアイコンから開いたときだけ通知が届く。通知の送信失敗で、元の操作（タスク保存など）は失敗させない。
- **アイコンの赤い数字（バッジ）**（2026-10-21追加）: `lib/badge.js`が、その人の未読の合計（未読のお知らせ＋未読のチャット＋自分が担当で未完了の新着タスク）を数える。新着タスク＝まだ詳細を開いていない、または開いたあとに他の人が更新したもの（`task_seen`テーブル。`GET /tasks/:id`で記録。導入時に、今ある担当タスクは「見た」扱いにした）。通知には`badge`として件数を付けて送り（`lib/push.js`の`sendToUser`）、`public/sw.js`の`updateBadge`が`setAppBadge`で更新。ページ表示時と、アプリに戻ったとき（`GET /badge`）にも更新（`partials/footer.ejs`）。チャットを読んだ直後は、次の表示まで数字が遅れる。対応していない端末では何もしない。ポータル画面の中の目印（同日追加）: サイドバー（スマホは下のメニュー）の「ホーム」（チャット未読）・「タスク管理」（新着タスク）・「お知らせ」（未読）に赤い丸と件数（`partials/header.ejs`の`.nav-badge`）、ボードの新着タスクのカードに赤い点（`.unread-dot`。`routes/tasks.js`が`unreadTaskIds`を渡す）。`window.refreshAppBadge()`（`partials/footer.ejs`）が`GET /badge`（内訳つき）で、アイコンの数字とサイドバーの件数をまとめて取り直す。タスクのパネルを開いたとき・チャットで既読にしたとき・チャットの新着が届いたときに呼ぶ。

## 機能一覧（2026年10月時点）

ホーム（KPI・お知らせ・自分のタスク・勤怠・イベントカレンダー）/ タスク管理
（カンバン+カレンダー、複数担当者、添付、コメント、締切超過を赤字表示）/ お知らせ
（添付・既読管理）/ ナレッジ共有（Markdown記事・検索・カテゴリ色分け・添付）/
アイディアストック（スライドパネルで素早く登録、カテゴリ自由入力、添付）/
外注先リスト（カテゴリ別色分け）/ 共有シートリンク集 / 商品粗利表（表計算、Excel
インポート/エクスポート）/ EC売上ダッシュボード（発送月別・税込。モール別／商品別／昨対比、CSV取り込みは全員可）/ 勤怠（個人の出退勤打刻、管理者向けメンバー別CSVダウンロード）/
ホーム画面のチャット（全員との1対1・グループ・添付）と、別パネルの通話（在宅×社内の電話方式。着信音・応答・通話中の表示、音量・マイクの消音）/ 全体検索（ヘッダーの窓。タスク・お知らせ・ナレッジ・アイディア・外注先が対象〔外注先は社名・用途・備考・URL。連絡先は対象外。結果から`/vendors#vendor-ID`の該当行へ〕。`lib/search.js`、`/search`）/ サイト保守ダッシュボード（管理しているWordPressサイトの稼働・SSL期限・ドメイン期限・バックアップ・点検を一覧。`routes/maintenance.js`、`lib/maintenance*.js`・`lib/siteChecker.js`。自動確認は外から見える情報だけで、サイトの認証情報は持たない。閲覧は全員・編集は管理者のみ）/ ユーザー管理・プロフィール（アバター設定）。

## 保留中の項目

- グッズ受注・印刷手配管理（カンバン）: 要望待ちで保留
- チャット・音声: VPS・HTTPS・TURN（coturn）で本番稼働。音声は2026-10-06に実機で確認済み
  （テスト用ダミーアカウントは削除済み）。同じアカウントで画面（タブ）を複数開くと、接続の
  申し込みが重なって通話が失敗する（設計上の制限）。複数の画面でも壊れないようにする修正は未実施

## テスト方法

自動テストは`npm test`（`node:test`、`tests/`配下）。チャットの保存・権限・中継（`chatStore`/`chatHub`など）のみ
カバーしている。それ以外は、変更後にローカルで一時サーバーを立て、curlまたは
Playwright（Chromiumは`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）で
実際に操作して確認してから報告する運用にしている。

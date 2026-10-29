require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SessionStore = require('./lib/sessionStore');
const { sameOriginGuard } = require('./lib/sameOrigin');
const { applyFreshUser } = require('./lib/sessionUser');
const { resolveSessionSecret } = require('./lib/sessionSecret');
const { securityHeaders } = require('./lib/securityHeaders');
const { createUploadGuard } = require('./lib/uploadGuard');
const { setUploadHeaders } = require('./lib/uploadHeaders');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const homeRoutes = require('./routes/home');
const attendanceRoutes = require('./routes/attendance');
const taskRoutes = require('./routes/tasks');
const announcementRoutes = require('./routes/announcements');
const salesRoutes = require('./routes/sales');
const eventRoutes = require('./routes/events');
const vendorRoutes = require('./routes/vendors');
const sheetLinkRoutes = require('./routes/sheetLinks');
const sheetRoutes = require('./routes/sheets');
const knowledgeRoutes = require('./routes/knowledge');
const ideaRoutes = require('./routes/ideas');
const profileRoutes = require('./routes/profile');
const chatRoutes = require('./routes/chat');
const searchRoutes = require('./routes/search');
const { createMaintenanceRouter } = require('./routes/maintenance');
const { ensureMaintenanceSchema } = require('./lib/maintenanceSchema');
const { startScheduler } = require('./lib/siteCheckRunner');
const { formatJst } = require('./lib/jst');
const { linkify } = require('./lib/linkify');
const { attachChatSocket } = require('./lib/chatSocket');
const db = require('./db/connection');
const { avatarFor } = require('./lib/avatar');

const app = express();
// 全ビューで使う、イベントの種類(色分け)の定義
const { EVENT_CATEGORY_DEFS, categoryClass } = require('./lib/eventCategories');
app.locals.eventCategories = EVENT_CATEGORY_DEFS;
app.locals.eventCategoryClass = categoryClass;
const PORT = process.env.PORT || 3000;

// 本番はnginxの背後にある（X-Forwarded-Proto / X-Forwarded-For を1段だけ信用する）。
// これで HTTPS かどうかと、本当の接続元が分かる
app.set('trust proxy', 1);

app.use(securityHeaders);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// PCのバックアップ取得の結果の受け口（トークン認証。専用のJSON解析を持つので、全体のbody解析より先に置く）
app.use('/api/maintenance', require('./routes/maintenanceBackupApi').createBackupApiRouter(db));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// 他のサイトからの書き込み操作(CSRF)を断る。バックアップ受付APIは上で別に処理済み
app.use(sameOriginGuard);
const UPLOADS_ROOT = path.join(__dirname, 'public', 'uploads');
// 添付・アバターは、ログイン中の人にだけ渡す（セッションは下で定義するので、呼ばれた時点で参照する）
app.use('/uploads', (req, res, next) => sessionMiddleware(req, res, next), createUploadGuard(db));
app.use(
  express.static(path.join(__dirname, 'public'), {
    // Service Workerと設定ファイルは、更新がすぐ届くようにキャッシュさせない
    setHeaders(res, filePath) {
      setUploadHeaders(res, filePath, UPLOADS_ROOT);
      const name = path.basename(filePath);
      if (name === 'sw.js') {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
      } else if (name === 'manifest.webmanifest' || name === 'offline.html') {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

const sessionMiddleware = session({
  store: new SessionStore({ file: path.join(__dirname, 'db', 'sessions.db') }),
  secret: resolveSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
    httpOnly: true,
    sameSite: 'lax', // 他のサイトからの書き込み操作にはCookieを付けない
    secure: 'auto', // HTTPSで開いているときだけ secure を付ける（ローカルのhttpでも動くように）
  },
});
app.use(sessionMiddleware);

// 全ビューでログインユーザー情報を使えるようにする
// (アイコン設定はログイン後に変わりうるため、セッションではなくDBから都度取得する)
app.use((req, res, next) => {
  if (req.session.user) {
    const fresh = db
      .prepare('SELECT id, user_id, display_name, role, avatar_emoji, avatar_color, avatar_image FROM users WHERE user_id = ?')
      .get(req.session.user.user_id);
    // 権限の変更・ユーザーの削除を、残っているセッションにも反映する(削除済みならログアウト扱い)
    if (applyFreshUser(req.session, fresh)) {
      res.locals.currentUser = fresh;
      res.locals.currentUserAvatar = avatarFor(fresh);
    } else {
      res.locals.currentUser = null;
      res.locals.currentUserAvatar = null;
    }
  } else {
    res.locals.currentUser = null;
    res.locals.currentUserAvatar = null;
  }
  // DBのUTC日時を、画面では日本時間で表示する
  res.locals.formatJst = formatJst;
  res.locals.linkify = linkify;
  // ホーム画面アイコンの赤い数字。画面の最後（フッター）で数えるので、開いたお知らせ・タスクは含まれない
  res.locals.unreadBreakdown = () => (req.session.user ? require('./lib/badge').unreadBreakdownSafe(db, req.session.user.user_id) : null);
  res.locals.unreadBadge = () => (req.session.user ? require('./lib/badge').unreadTotalSafe(db, req.session.user.user_id) : null);
  next();
});

app.use(authRoutes);
app.use(userRoutes);
app.use(profileRoutes);
app.use(homeRoutes);
app.use(attendanceRoutes);
app.use(taskRoutes);
app.use(announcementRoutes);
app.use(salesRoutes);
app.use(eventRoutes);
app.use(vendorRoutes);
app.use(sheetLinkRoutes);
app.use(sheetRoutes);
app.use(knowledgeRoutes);
app.use(ideaRoutes);
app.use(chatRoutes);
app.use(require('./routes/push'));
app.use(require('./routes/install'));
app.use(searchRoutes);
ensureMaintenanceSchema(db);
require('./lib/pushSchema').ensurePushSchema(db);
require('./lib/ecSchema').ensureEcSchema(db);
app.use(createMaintenanceRouter(db));

app.use((req, res) => {
  res.status(404).render('error', { message: 'ページが見つかりません', user: req.session.user });
});

const server = app.listen(PORT, () => {
  console.log(`estowa社内ポータル起動: http://localhost:${PORT}`);
});
attachChatSocket(server, sessionMiddleware, db);
// 添付ファイルは15日で自動削除（起動1分後と6時間おき）。CHAT_CLEANUP_DISABLED=1 で止められる
if (process.env.CHAT_CLEANUP_DISABLED !== '1') require('./lib/chatCleanup').startScheduler(db, require('./lib/chatFiles').CHAT_FILES_DIR);
// サイト保守の自動確認（起動1分後と6時間おき）。SITE_CHECK_DISABLED=1 で止められる
if (process.env.SITE_CHECK_DISABLED !== '1') startScheduler(db);

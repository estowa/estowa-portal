require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

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

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  express.static(path.join(__dirname, 'public'), {
    // Service Workerと設定ファイルは、更新がすぐ届くようにキャッシュさせない
    setHeaders(res, filePath) {
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
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'db') }),
  secret: process.env.SESSION_SECRET || 'estowa-portal-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
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
    res.locals.currentUser = fresh || req.session.user;
    res.locals.currentUserAvatar = avatarFor(res.locals.currentUser);
  } else {
    res.locals.currentUser = null;
    res.locals.currentUserAvatar = null;
  }
  // DBのUTC日時を、画面では日本時間で表示する
  res.locals.formatJst = formatJst;
  res.locals.linkify = linkify;
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
app.use(createMaintenanceRouter(db));

app.use((req, res) => {
  res.status(404).render('error', { message: 'ページが見つかりません', user: req.session.user });
});

const server = app.listen(PORT, () => {
  console.log(`estowa社内ポータル起動: http://localhost:${PORT}`);
});
attachChatSocket(server, sessionMiddleware, db);
// サイト保守の自動確認（起動1分後と6時間おき）。SITE_CHECK_DISABLED=1 で止められる
if (process.env.SITE_CHECK_DISABLED !== '1') startScheduler(db);

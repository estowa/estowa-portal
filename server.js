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
const vendorRoutes = require('./routes/vendors');
const sheetLinkRoutes = require('./routes/sheetLinks');
const sheetRoutes = require('./routes/sheets');
const knowledgeRoutes = require('./routes/knowledge');
const profileRoutes = require('./routes/profile');
const db = require('./db/connection');
const { avatarFor } = require('./lib/avatar');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'db') }),
    secret: process.env.SESSION_SECRET || 'estowa-portal-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
    },
  })
);

// 全ビューでログインユーザー情報を使えるようにする
// (アイコン設定はログイン後に変わりうるため、セッションではなくDBから都度取得する)
app.use((req, res, next) => {
  if (req.session.user) {
    const fresh = db
      .prepare('SELECT id, user_id, display_name, role, avatar_emoji, avatar_color FROM users WHERE user_id = ?')
      .get(req.session.user.user_id);
    res.locals.currentUser = fresh || req.session.user;
    res.locals.currentUserAvatar = avatarFor(res.locals.currentUser);
  } else {
    res.locals.currentUser = null;
    res.locals.currentUserAvatar = null;
  }
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
app.use(vendorRoutes);
app.use(sheetLinkRoutes);
app.use(sheetRoutes);
app.use(knowledgeRoutes);

app.use((req, res) => {
  res.status(404).render('error', { message: 'ページが見つかりません', user: req.session.user });
});

app.listen(PORT, () => {
  console.log(`estowa社内ポータル起動: http://localhost:${PORT}`);
});

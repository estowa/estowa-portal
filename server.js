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
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

app.use(authRoutes);
app.use(userRoutes);
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

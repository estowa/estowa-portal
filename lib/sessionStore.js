// ログイン状態の保存先。better-sqlite3 で動かす（sqlite3 パッケージを使わないため）。
// テーブル形式は connect-sqlite3 と同じ（sid, expired, sess）なので、既存のログイン状態をそのまま引き継げる
const Database = require('better-sqlite3');
const session = require('express-session');

const ONE_DAY = 24 * 60 * 60 * 1000;

class SessionStore extends session.Store {
  constructor({ file, table = 'sessions' }) {
    super();
    this.table = table;
    this.db = new Database(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (sid PRIMARY KEY, expired, sess)`);
    this.cleanup();
    setInterval(() => this.cleanup(), ONE_DAY).unref();
  }

  cleanup() {
    this.db.prepare(`DELETE FROM ${this.table} WHERE ? > expired`).run(Date.now());
  }

  get(sid, cb) {
    try {
      const row = this.db
        .prepare(`SELECT sess FROM ${this.table} WHERE sid = ? AND ? <= expired`)
        .get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie && sess.cookie.maxAge;
      const expired = Date.now() + (maxAge || ONE_DAY);
      this.db
        .prepare(`INSERT OR REPLACE INTO ${this.table} VALUES (?, ?, ?)`)
        .run(sid, expired, JSON.stringify(sess));
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare(`DELETE FROM ${this.table} WHERE sid = ?`).run(sid);
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      if (sess && sess.cookie && sess.cookie.expires) {
        this.db
          .prepare(`UPDATE ${this.table} SET expired = ? WHERE sid = ? AND ? <= expired`)
          .run(new Date(sess.cookie.expires).getTime(), sid, Date.now());
      }
      if (cb) cb(null);
    } catch (e) {
      if (cb) cb(e);
    }
  }
}

module.exports = SessionStore;

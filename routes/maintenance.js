const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const store = require('../lib/maintenanceStore');
const { parseBulk } = require('../lib/maintenanceImport');
const { runChecks } = require('../lib/siteCheckRunner');
const { nowJstDateStr } = require('../lib/jst');
const fmt = require('../lib/maintenanceView');

const CHECK_COOLDOWN_MS = 30 * 1000;
const NOTICES = {
  checked: '確認しました。',
  wait: '直前に確認したばかりです。30秒ほど待ってから、もう一度押してください。',
  added: 'サイトを追加しました。',
  saved: '保存しました。',
  deleted: 'サイトを削除しました。',
};

function createMaintenanceRouter(db, { runChecksFn = runChecks, nowFn = () => Date.now() } = {}) {
  const router = express.Router();
  const admin = [requireLogin, requireAdmin];
  const notFound = (req, res) =>
    res.status(404).render('error', { message: 'サイトが見つかりません', user: req.session.user });
  const noticeOf = (req) => NOTICES[req.query.notice] || null;
  const emptyForm = { name: '', url: '', server_name: '', client_type: 'client', is_wordpress: 1, domain_expires_manual: '', memo: '' };

  // 確認中のサイト（二重に実行しない）
  const inFlight = new Set();

  // 追加したサイトの最初の確認を、待たずに始める（失敗しても、追加には影響させない）
  function kickFirstCheck(siteIds) {
    if (siteIds.length === 0) return;
    try {
      const p = runChecksFn(db, { siteIds });
      if (p && typeof p.catch === 'function') p.catch((e) => console.error('[サイト確認] 最初の確認に失敗しました:', e.message));
    } catch (e) {
      console.error('[サイト確認] 最初の確認を始められませんでした:', e.message);
    }
  }

  // ---- 一覧 ----
  router.get('/maintenance', requireLogin, (req, res) => {
    const rows = store.sortOverview(store.overview(db, nowJstDateStr()));
    const servers = [...new Set(rows.map((r) => r.site.server_name).filter(Boolean))].sort();
    let notice = noticeOf(req);
    if (req.query.notice === 'added' && Number(req.query.n) > 0) notice = `${Number(req.query.n)}件のサイトを追加しました。`;
    res.render('maintenance/list', { rows, servers, summary: store.summarize(rows, nowFn()), notice, fmt });
  });

  // ---- 追加・まとめて追加（/:id より先に定義する）----
  router.get('/maintenance/new', admin, (req, res) => {
    res.render('maintenance/form', { site: null, values: emptyForm, error: null });
  });

  router.post('/maintenance', admin, (req, res) => {
    const values = { ...req.body, is_wordpress: req.body.is_wordpress === '1' ? 1 : 0 };
    try {
      const newId = store.addSite(db, { ...values, created_by: req.session.user.user_id });
      kickFirstCheck([newId]);
      res.redirect('/maintenance?notice=added');
    } catch (e) {
      res.render('maintenance/form', { site: null, values, error: e.message });
    }
  });

  router.get('/maintenance/bulk', admin, (req, res) => {
    res.render('maintenance/bulk', { text: '', preview: null, error: null });
  });

  router.post('/maintenance/bulk', admin, (req, res) => {
    const text = String(req.body.text || '');
    const parsed = parseBulk(text, store.listSites(db).map((s) => s.url));
    if (req.body.confirm !== '1') return res.render('maintenance/bulk', { text, preview: parsed, error: null });
    try {
      const newIds = db.transaction(() =>
        parsed.rows.map((r) => store.addSite(db, { ...r, is_wordpress: 1, created_by: req.session.user.user_id })))();
      kickFirstCheck(newIds);
      return res.redirect(`/maintenance?notice=added&n=${parsed.rows.length}`);
    } catch (e) {
      return res.render('maintenance/bulk', { text, preview: parsed, error: e.message });
    }
  });

  // ---- 詳細 ----
  router.get('/maintenance/:id', requireLogin, (req, res) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? store.getRow(db, id, nowJstDateStr()) : null;
    if (!row) return notFound(req, res);
    res.render('maintenance/detail', {
      row, checks: store.listChecks(db, id, 30), logs: store.listLogs(db, id), kinds: store.LOG_KINDS,
      today: nowJstDateStr(), notice: noticeOf(req), logError: null, logValues: null, fmt,
    });
  });

  // ---- 編集・削除 ----
  router.get('/maintenance/:id/edit', admin, (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    res.render('maintenance/form', { site, values: { ...site, domain_expires_manual: site.domain_expires_manual || '' }, error: null });
  });

  router.post('/maintenance/:id', admin, (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    const values = { ...req.body, is_wordpress: req.body.is_wordpress === '1' ? 1 : 0 };
    try {
      store.updateSite(db, site.id, values);
      res.redirect(`/maintenance/${site.id}?notice=saved`);
    } catch (e) {
      res.render('maintenance/form', { site, values, error: e.message });
    }
  });

  router.post('/maintenance/:id/delete', admin, (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    store.deleteSite(db, site.id);
    res.redirect('/maintenance?notice=deleted');
  });

  // ---- 今すぐ確認（1サイトにつき30秒に1回まで）----
  router.post('/maintenance/:id/check', admin, async (req, res) => {
    const site = store.getSite(db, Number(req.params.id));
    if (!site) return notFound(req, res);
    const last = store.latestChecks(db, site.id, 1)[0];
    const justChecked = last && nowFn() - Date.parse(String(last.checked_at).replace(' ', 'T') + 'Z') < CHECK_COOLDOWN_MS;
    if (justChecked || inFlight.has(site.id)) return res.redirect(`/maintenance/${site.id}?notice=wait`);
    inFlight.add(site.id);
    try {
      await runChecksFn(db, { siteIds: [site.id] });
    } finally {
      inFlight.delete(site.id);
    }
    return res.redirect(`/maintenance/${site.id}?notice=checked`);
  });

  // ---- 点検記録 ----
  router.post('/maintenance/:id/logs', admin, (req, res) => {
    const id = Number(req.params.id);
    if (!store.getSite(db, id)) return notFound(req, res);
    try {
      store.addLog(db, id, { ...req.body, created_by: req.session.user.user_id });
      res.redirect(`/maintenance/${id}`);
    } catch (e) {
      res.render('maintenance/detail', {
        row: store.getRow(db, id, nowJstDateStr()), checks: store.listChecks(db, id, 30), logs: store.listLogs(db, id),
        kinds: store.LOG_KINDS, today: nowJstDateStr(), notice: null, logError: e.message, logValues: req.body, fmt,
      });
    }
  });

  router.post('/maintenance/:id/logs/:logId/delete', admin, (req, res) => {
    const id = Number(req.params.id);
    store.deleteLog(db, Number(req.params.logId), id);
    res.redirect(`/maintenance/${id}`);
  });

  return router;
}

module.exports = { createMaintenanceRouter };

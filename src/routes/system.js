'use strict';
const express = require('express');
const { all, get, run, setting, setSetting, DEFAULT_SETTINGS } = require('../db');
const { audit, nowIso, HttpError } = require('../util');
const { requireRole } = require('../perm');
const { notify, processEmailQueue } = require('../notify');
const { runAlertChecks } = require('../alerts');

const router = express.Router();
// Non-numeric settings edited on their own pages (daily task auto-send time: /tasks)
const TEXT_SETTINGS = ['daily_dispatch_time'];

router.get('/notifications', (req, res) => {
  const rows = all('SELECT * FROM notifications WHERE employee_id = ? ORDER BY id DESC LIMIT 200', req.user.id);
  res.render('notifications', { rows });
});
router.post('/notifications/read-all', (req, res) => {
  run('UPDATE notifications SET read_at = ? WHERE employee_id = ? AND read_at IS NULL', nowIso(), req.user.id);
  res.redirect('/notifications');
});
// Opening an alert marks it read and follows its link
router.get('/notifications/:id', (req, res) => {
  const n = get('SELECT * FROM notifications WHERE id = ? AND employee_id = ?', Number(req.params.id), req.user.id);
  if (!n) throw new HttpError(404, 'Not found');
  if (!n.read_at) run('UPDATE notifications SET read_at = ? WHERE id = ?', nowIso(), n.id);
  res.redirect(n.link && n.link.startsWith('/') ? n.link : '/notifications');
});
router.get('/api/unread', (req, res) => {
  res.json({ unread: res.locals.unread, latest: get('SELECT id, title, severity FROM notifications WHERE employee_id = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1', req.user.id) || null });
});

router.get('/outbox', requireRole('admin', 'auditor'), (req, res) => {
  const rows = all('SELECT id, to_email, to_name, subject, status, attempts, error, created_at, sent_at FROM emails ORDER BY id DESC LIMIT 300');
  res.render('outbox', { rows });
});
router.get('/outbox/:id', requireRole('admin', 'auditor'), (req, res) => {
  const m = get('SELECT html FROM emails WHERE id = ?', Number(req.params.id));
  if (!m) throw new HttpError(404, 'Not found');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type('html').send(m.html);
});

router.get('/audit', requireRole('admin', 'auditor'), (req, res) => {
  const cond = [], p = [];
  if (req.query.entity) { cond.push('a.entity = ?'); p.push(req.query.entity); }
  if (req.query.action) { cond.push('a.action = ?'); p.push(req.query.action); }
  if (req.query.q) { cond.push('(a.entity_id LIKE ? OR e.employee_no LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const rows = all(`SELECT a.*, e.employee_no, e.name_ar, e.name_en FROM audit_log a LEFT JOIN employees e ON e.id = a.employee_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 300`, ...p);
  res.render('audit', {
    rows,
    entities: all('SELECT DISTINCT entity FROM audit_log ORDER BY entity').map((r) => r.entity),
    actions: all('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action),
  });
});

router.get('/settings', requireRole('admin'), (req, res) => {
  const values = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((k) => !TEXT_SETTINGS.includes(k)).map((k) => [k, setting(k)]));
  const seq = get("SELECT value FROM sequences WHERE name = 'wo'");
  res.render('settings', { values, seq: seq ? seq.value : 0, queue: all('SELECT status, COUNT(*) n FROM emails GROUP BY status') });
});
router.post('/settings', requireRole('admin'), (req, res) => {
  const before = {}, after = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (req.body[k] == null || TEXT_SETTINGS.includes(k)) continue;
    const v = Number(req.body[k]);
    if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `${k}: invalid`);
    before[k] = setting(k);
    after[k] = String(v);
    setSetting(k, v);
  }
  audit(req, 'update', 'settings', null, before, after);
  res.flash('success', res.locals.t('saved'));
  res.redirect('/settings');
});
router.post('/settings/test-email', requireRole('admin'), async (req, res, next) => {
  try {
    const to = (req.body.to || '').trim();
    if (!to) throw new HttpError(400, 'Email required');
    run('INSERT INTO emails(to_email, subject, html) VALUES (?,?,?)', to, 'رسالة تجريبية / Test email',
      require('../notify').emailHtml({ title: 'رسالة تجريبية / Test email', body: 'إعدادات البريد تعمل.\nMail settings are working.' }));
    await processEmailQueue();
    res.flash('success', 'Queued / تمت الإضافة للطابور');
    res.redirect('/outbox');
  } catch (e) { next(e); }
});
router.post('/settings/run-alerts', requireRole('admin'), async (req, res) => {
  const n = runAlertChecks();
  await processEmailQueue();
  res.flash('success', `Alerts raised: ${n}`);
  res.redirect('/settings');
});
router.post('/settings/broadcast', requireRole('admin', 'hr', 'safety'), (req, res) => {
  const { title, body, audience } = req.body;
  if (!title) throw new HttpError(400, 'Title required');
  const ids = all(`SELECT id FROM employees WHERE status = 'active'${audience && audience !== 'all' ? ' AND role = ?' : ''}`, ...(audience && audience !== 'all' ? [audience] : [])).map((r) => r.id);
  notify(ids, { type: 'broadcast', severity: 'info', title, body });
  audit(req, 'broadcast', 'notification', null, null, { title, audience, recipients: ids.length });
  res.flash('success', `Sent to ${ids.length}`);
  res.redirect('/settings');
});

module.exports = router;

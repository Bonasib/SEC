'use strict';
const express = require('express');
const { all, get, setting, setSetting } = require('../db');
const { HttpError, todayRiyadh, audit } = require('../util');
const { sections } = require('../org');
const T = require('../tasks');

const router = express.Router();
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const ensure = (req, res) => { if (!T.canDispatch(req.user)) throw new HttpError(403, res.locals.t('forbidden')); };
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function pageData(req, extra = {}) {
  const q = { ...req.query, ...(extra.query || {}) };
  const day = isDay(q.day) ? q.day : todayRiyadh();
  const to = isDay(q.to) && q.to > day ? q.to : '';
  const manager = T.canDispatch(req.user);
  const a = T.agenda({ day, to, section: q.section, status: q.status, priority: q.priority, assignee: q.assignee, q: q.q, sort: q.sort, kinds: q.kinds }, manager ? null : req.user);
  const people = new Set();
  a.tasks.forEach((t) => t.people.forEach((p) => people.add(p.id)));
  a.wos.forEach((w) => w.people.forEach((p) => people.add(p.id)));
  return {
    day, to, agenda: a, manager, q,
    stats: {
      tasks: a.tasks.length, open: a.tasks.filter((t) => t.status === 'open').length, done: a.tasks.filter((t) => t.status === 'done').length,
      wos: a.wos.length, people: people.size, urgent: a.tasks.filter((t) => t.priority === 'urgent' && t.status === 'open').length,
    },
    sections: sections(), PRIORITIES: T.PRIORITIES, STATUSES: T.STATUSES,
    employees: manager ? all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.email, e.phone, e.section_id, s.code section_code FROM employees e
      LEFT JOIN org_units s ON s.id = e.section_id WHERE e.status = 'active' ORDER BY e.employee_no`) : [],
    history: manager ? T.history(15) : [], autoTime: setting('daily_dispatch_time') || '',
    prev: addDays(day, -1), next: addDays(day, 1), today: todayRiyadh(),
    preview: null, sent: null, form: {}, editTask: null,
    ...extra,
  };
}

router.get('/tasks', (req, res) => res.render('tasks', pageData(req)));

function createDays(b) {
  const first = String(b.task_date || '').slice(0, 10);
  const until = isDay(b.repeat_until) && b.repeat_until > first ? b.repeat_until : first;
  const days = [];
  for (let d = first; d <= until && days.length < 92; d = addDays(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay(); // 5 = Friday, 6 = Saturday
    if (b.skip_weekend === '1' && d !== first && (dow === 5 || dow === 6)) continue;
    days.push(d);
  }
  return days;
}

router.post('/tasks', (req, res) => {
  ensure(req, res);
  const days = createDays(req.body);
  if (!days.length) throw new HttpError(400, 'Task date is required / تاريخ المهمة مطلوب');
  const warnings = [];
  for (const d of days) warnings.push(...T.save({ ...req.body, task_date: d }, req).warnings);
  res.flash(warnings.length ? 'warning' : 'success', `${res.locals.t('saved')} (${days.length})${warnings.length ? '\n' + [...new Set(warnings)].join('\n') : ''}`);
  res.redirect(`/tasks?day=${days[0]}`);
});

router.get('/tasks/:id(\\d+)/edit', (req, res) => {
  ensure(req, res);
  const t = get('SELECT t.*, w.wo_number FROM tasks t LEFT JOIN work_orders w ON w.id = t.wo_id WHERE t.id = ?', Number(req.params.id));
  if (!t) throw new HttpError(404, res.locals.t('not_found'));
  t.assignee_ids = all('SELECT employee_id FROM task_assignees WHERE task_id = ?', t.id).map((r) => r.employee_id);
  res.render('tasks', pageData(req, { editTask: t, query: { day: t.task_date } }));
});

router.post('/tasks/:id(\\d+)', (req, res) => {
  ensure(req, res);
  const r = T.save(req.body, req, Number(req.params.id));
  res.flash(r.warnings.length ? 'warning' : 'success', res.locals.t('saved') + (r.warnings.length ? '\n' + r.warnings.join('\n') : ''));
  res.redirect(`/tasks?day=${req.body.task_date}`);
});

router.post('/tasks/:id(\\d+)/status', (req, res) => {
  const t = T.setStatus(Number(req.params.id), req.body.status, req);
  res.redirect(`/tasks?day=${t.task_date}`);
});

function dispatchOpts(b) {
  return {
    day: isDay(b.day) ? b.day : todayRiyadh(), to: isDay(b.to) ? b.to : '',
    mode: b.mode === 'selected' ? 'selected' : 'each',
    taskIds: toArr(b.task_ids).map(Number).filter(Boolean), woIds: toArr(b.wo_ids).map(Number).filter(Boolean),
    recipientIds: toArr(b.recipient_ids).map(Number).filter(Boolean), externalEmails: T.parseEmails(b.external_emails),
    message: String(b.message || '').trim().slice(0, 1000) || null,
  };
}

router.post('/tasks/dispatch', (req, res) => {
  ensure(req, res);
  const opts = dispatchOpts(req.body);
  if (req.body.action === 'all') {
    // One click: every open task and active work order of the day(s) to each assigned person
    const a = T.agenda({ day: opts.day, to: opts.to });
    Object.assign(opts, { mode: 'each', taskIds: a.tasks.filter((t) => t.status === 'open').map((t) => t.id), woIds: a.wos.map((w) => w.id) });
  }
  const query = { day: opts.day, to: opts.to };
  if (req.body.action === 'preview') {
    const preview = T.buildMessages(opts);
    return res.render('tasks', pageData(req, { preview, form: req.body, query }));
  }
  const sent = T.dispatch(opts, req);
  res.render('tasks', pageData(req, { sent, query }));
});

router.post('/tasks/auto', (req, res) => {
  if (req.user.role !== 'admin') throw new HttpError(403, res.locals.t('forbidden'));
  const v = req.body.enabled === '1' && /^\d{2}:\d{2}$/.test(req.body.time || '') ? req.body.time : '';
  audit(req, 'update', 'settings', 'daily_dispatch_time', { daily_dispatch_time: setting('daily_dispatch_time') }, { daily_dispatch_time: v });
  setSetting('daily_dispatch_time', v);
  res.flash('success', res.locals.t('saved'));
  res.redirect('/tasks#auto');
});

module.exports = router;

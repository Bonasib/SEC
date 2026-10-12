'use strict';
const express = require('express');
const { all, get } = require('../db');
const { HttpError, todayRiyadh } = require('../util');
const { sections } = require('../org');
const { can } = require('../access');
const T = require('../training');

const router = express.Router();
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const canManage = (req) => can(req.user, 'training.manage') === true;

function courseFromBody(b) {
  return {
    code: (b.code || '').trim(), title_ar: (b.title_ar || '').trim(), title_en: (b.title_en || '').trim(), scope: b.scope, category: b.category,
    country: (b.country || '').trim(), city: (b.city || '').trim(), provider: (b.provider || '').trim(), mode: b.mode === 'remote' ? 'remote' : 'in_person',
    start_date: b.start_date, end_date: b.end_date, hours: Number(b.hours) || null, language: b.language || null,
    capacity: Number(b.capacity) || null, cost: Number(b.cost) || null, status: ['planned', 'completed', 'cancelled'].includes(b.status) ? b.status : 'planned',
  };
}

const COURSE_SORT = { date: 'c.start_date', title: 'c.title_en', category: 'c.category', city: 'c.city', status: 'c.status', hours: 'c.hours' };
function courseFilters(q) {
  const c = [], p = [];
  if (q.category) { c.push('c.category = ?'); p.push(q.category); }
  if (q.status) { c.push('c.status = ?'); p.push(q.status); }
  if (q.mode) { c.push('c.mode = ?'); p.push(q.mode); }
  if (q.q) { c.push('(c.code LIKE ? OR c.title_ar LIKE ? OR c.title_en LIKE ? OR c.provider LIKE ? OR c.city LIKE ? OR c.country LIKE ?)'); p.push(...Array(6).fill(`%${q.q}%`)); }
  return { sql: c.map((x) => 'AND ' + x).join(' '), params: p };
}

router.get('/training', (req, res) => {
  const extra = courseFilters(req.query);
  const year = Number(req.query.year) || Number(todayRiyadh().slice(0, 4));
  const scope = ['local', 'international'].includes(req.query.scope) ? req.query.scope : null;
  const courses = all(`SELECT c.*, (SELECT COUNT(*) FROM course_attendees a WHERE a.course_id = c.id AND a.attendance <> 'cancelled') enrolled,
      (SELECT COUNT(*) FROM course_attendees a WHERE a.course_id = c.id AND a.attendance = 'attended') attended,
      (SELECT COUNT(*) FROM course_attendees a WHERE a.course_id = c.id AND a.result = 'pass') passed
    FROM courses c WHERE substr(c.start_date,1,4) = ? ${scope ? 'AND c.scope = ?' : ''} ${extra.sql} ORDER BY c.scope DESC, ${COURSE_SORT[req.query.sort] || 'c.start_date'} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'}`, String(year), ...(scope ? [scope] : []), ...extra.params);
  const attendees = all(`SELECT a.*, e.employee_no, e.name_ar, e.name_en, s.code section_code FROM course_attendees a JOIN employees e ON e.id = a.employee_id
    LEFT JOIN org_units s ON s.id = e.section_id JOIN courses c ON c.id = a.course_id WHERE substr(c.start_date,1,4) = ? AND a.attendance <> 'cancelled' ORDER BY e.employee_no`, String(year));
  const byCourse = {};
  attendees.forEach((a) => (byCourse[a.course_id] = byCourse[a.course_id] || []).push(a));
  res.render('training', {
    year, scope, courses, byCourse, stats: T.stats(year), today: todayRiyadh(), canManage: canManage(req),
    suggestions: can(req.user, 'plans.view') === true || canManage(req) ? T.suggestions() : [],
    CATEGORIES: T.CATEGORIES, years: all('SELECT DISTINCT substr(start_date,1,4) y FROM courses ORDER BY y DESC').map((r) => Number(r.y)),
  });
});

router.get('/training/:id(\\d+)', (req, res) => {
  const c = get('SELECT * FROM courses WHERE id = ?', Number(req.params.id));
  if (!c) throw new HttpError(404, 'Not found');
  const attendees = all(`SELECT a.*, e.employee_no, e.name_ar, e.name_en, e.job_title_en, s.code section_code, r.name_ar reg_ar FROM course_attendees a
    JOIN employees e ON e.id = a.employee_id LEFT JOIN org_units s ON s.id = e.section_id LEFT JOIN employees r ON r.id = a.registered_by WHERE a.course_id = ? ORDER BY a.attendance = 'cancelled', e.employee_no`, c.id);
  const suggested = T.suggestions({ limit: 200 }).filter((s) => s.courses.some((x) => x.id === c.id));
  res.render('training_course', {
    c, attendees, suggested, canManage: canManage(req), CATEGORIES: T.CATEGORIES, ATTENDANCE: T.ATTENDANCE, days: T.daysOf(c), place: T.placeOf(c),
    employees: all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, s.code section_code FROM employees e LEFT JOIN org_units s ON s.id = e.section_id
      WHERE e.status = 'active' AND e.id NOT IN (SELECT employee_id FROM course_attendees WHERE course_id = ? AND attendance <> 'cancelled') ORDER BY e.employee_no`, c.id),
    sections: sections(),
  });
});

router.post('/training', (req, res) => {
  if (!canManage(req)) throw new HttpError(403, res.locals.t('forbidden'));
  const id = T.saveCourse(courseFromBody(req.body), req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/training/${id}`);
});
router.post('/training/:id(\\d+)', (req, res) => {
  if (!canManage(req)) throw new HttpError(403, res.locals.t('forbidden'));
  const id = Number(req.params.id);
  if (!get('SELECT 1 FROM courses WHERE id = ?', id)) throw new HttpError(404, 'Not found');
  T.saveCourse(courseFromBody(req.body), req, id);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/training/${id}`);
});
router.post('/training/:id(\\d+)/register', (req, res) => {
  if (!canManage(req)) throw new HttpError(403, res.locals.t('forbidden'));
  const n = T.register(Number(req.params.id), toArr(req.body.employee_ids), req.body.role, req);
  res.flash('success', `${n} ✓`);
  res.redirect(req.body.back === 'list' ? '/training#suggestions' : `/training/${req.params.id}#attendees`);
});
router.post('/training/attendees/:aid(\\d+)', (req, res) => {
  if (!canManage(req)) throw new HttpError(403, res.locals.t('forbidden'));
  const a = get('SELECT course_id FROM course_attendees WHERE id = ?', Number(req.params.aid));
  if (!a) throw new HttpError(404, 'Not found');
  T.updateAttendee(Number(req.params.aid), req.body, req);
  res.redirect(`/training/${a.course_id}#attendees`);
});

module.exports = router;

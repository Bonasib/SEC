'use strict';
const express = require('express');
const { all, get } = require('../db');
const { HttpError, todayRiyadh } = require('../util');
const { sections } = require('../org');
const { can } = require('../access');
const PL = require('../plans');

const router = express.Router();
const canView = (req, plan) => can(req.user, 'plans.view') === true || (plan && (plan.employee_id === req.user.id || plan.coach_id === req.user.id));

router.get('/plans', (req, res) => {
  const all_ = can(req.user, 'plans.view') === true;
  const cond = [], p = [];
  if (req.query.status) { cond.push('pl.status = ?'); p.push(req.query.status); }
  if (!all_) { cond.push('(pl.employee_id = ? OR pl.coach_id = ?)'); p.push(req.user.id, req.user.id); }
  const rows = all(`SELECT pl.*, e.employee_no, e.name_ar, e.name_en, e.job_title_en, s.code section_code, c.name_ar coach_ar, c.name_en coach_en,
      (SELECT COUNT(*) FROM plan_reviews r WHERE r.plan_id = pl.id) reviews,
      (SELECT rating FROM plan_reviews r WHERE r.plan_id = pl.id ORDER BY r.year DESC LIMIT 1) last_rating
    FROM improvement_plans pl JOIN employees e ON e.id = pl.employee_id LEFT JOIN org_units s ON s.id = e.section_id LEFT JOIN employees c ON c.id = pl.coach_id
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY pl.status = 'transfer_recommended' DESC, pl.status = 'active' DESC, pl.start_year, e.employee_no`, ...p);
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) n FROM improvement_plans GROUP BY status').map((r) => [r.status, r.n]));
  res.render('plans', { rows, counts, year: Number(todayRiyadh().slice(0, 4)), canRun: PL.DECIDERS.includes(req.user.role) || req.user.role === 'admin', PLAN_YEARS: PL.PLAN_YEARS });
});

router.get('/plans/:id(\\d+)', (req, res) => {
  const plan = get(`SELECT pl.*, e.employee_no, e.name_ar, e.name_en, e.job_title_en, e.section_id, s.code section_code, s.name_ar s_ar, s.name_en s_en, c.name_ar coach_ar, c.name_en coach_en, t.code to_code, t.name_ar to_ar, t.name_en to_en
    FROM improvement_plans pl JOIN employees e ON e.id = pl.employee_id LEFT JOIN org_units s ON s.id = e.section_id LEFT JOIN employees c ON c.id = pl.coach_id LEFT JOIN org_units t ON t.id = pl.transfer_to_section_id WHERE pl.id = ?`, Number(req.params.id));
  if (!plan) throw new HttpError(404, 'Not found');
  if (!canView(req, plan)) throw new HttpError(403, res.locals.t('forbidden'));
  const sug = require('../training').suggestions({ limit: 500 }).find((x) => x.id === plan.employee_id);
  res.render('plan', {
    plan, PLAN_YEARS: PL.PLAN_YEARS,
    reviews: all('SELECT * FROM plan_reviews WHERE plan_id = ? ORDER BY year', plan.id),
    courses: all(`SELECT c.*, a.attendance, a.result FROM course_attendees a JOIN courses c ON c.id = a.course_id WHERE a.employee_id = ? AND c.start_date >= ? ORDER BY c.start_date`, plan.employee_id, `${plan.start_year}-01-01`),
    suggested: sug ? sug.courses : [],
    sections: sections().filter((s) => s.id !== plan.section_id),
    coaches: all("SELECT id, employee_no, name_ar, name_en FROM employees WHERE status = 'active' AND role IN ('section_head','team_leader','division_manager') ORDER BY employee_no"),
    canDecide: PL.DECIDERS.includes(req.user.role), canEdit: PL.DECIDERS.includes(req.user.role) || plan.coach_id === req.user.id || req.user.role === 'admin',
  });
});

router.post('/plans/run', (req, res) => {
  if (!PL.DECIDERS.includes(req.user.role) && req.user.role !== 'admin') throw new HttpError(403, res.locals.t('forbidden'));
  const year = Number(req.body.year);
  if (!year || year > Number(todayRiyadh().slice(0, 4))) throw new HttpError(400, 'Invalid year');
  const r = PL.annualReview(year, req);
  res.flash('success', `${year}: +${r.created} · ${res.locals.t('pl_improved')} ${r.improved} · ${res.locals.t('pl_active')} ${r.continued} · ${res.locals.t('pl_transfer_recommended')} ${r.transfer}`);
  res.redirect('/plans');
});
router.post('/plans/:id(\\d+)', (req, res) => {
  PL.updatePlan(Number(req.params.id), { goals: req.body.goals, actions: req.body.actions, coachId: req.body.coach_id }, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/plans/${req.params.id}`);
});
router.post('/plans/:id(\\d+)/transfer', (req, res) => {
  PL.confirmTransfer(Number(req.params.id), { sectionId: req.body.section_id, decisionNo: (req.body.decision_no || '').trim() }, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/plans/${req.params.id}`);
});
router.post('/plans/:id(\\d+)/extend', (req, res) => {
  PL.extendPlan(Number(req.params.id), (req.body.note || '').trim(), req);
  res.redirect(`/plans/${req.params.id}`);
});
router.post('/plans/:id(\\d+)/close', (req, res) => {
  PL.closePlan(Number(req.params.id), (req.body.note || '').trim(), req);
  res.redirect(`/plans/${req.params.id}`);
});

module.exports = router;

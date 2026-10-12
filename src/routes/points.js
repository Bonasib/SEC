'use strict';
const express = require('express');
const { all, get, run } = require('../db');
const { audit, HttpError } = require('../util');
const { sections } = require('../org');
const { requireRole } = require('../perm');
const P = require('../points');
const { exportWorkbook } = require('../importexport');

const router = express.Router();
const VIEW_ALL = ['hr', 'admin', 'auditor', 'safety', 'section_head', 'division_manager', 'department_manager', 'sector_head', 'foreman', 'team_leader'];
const viewAll = (user) => require('../access').can(user, 'points.view_all') === true;
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

router.get('/points', (req, res) => {
  const year = Number(req.query.year) || P.currentYear();
  const canViewAll = viewAll(req.user);
  const board = P.leaderboard(year, { sectionId: canViewAll ? Number(req.query.section) || null : null });
  const me = board.rows.find((r) => r.id === req.user.id) || P.standing(req.user.id, year);
  const pending = all(`SELECT p.*, r.name_ar rule_ar, r.name_en rule_en, e.employee_no, e.name_ar, e.name_en, q.name_ar req_ar, q.name_en req_en
    FROM point_transactions p JOIN point_rules r ON r.code = p.rule_code JOIN employees e ON e.id = p.employee_id LEFT JOIN employees q ON q.id = p.requested_by
    WHERE p.status = 'pending' ORDER BY p.id`);
  res.render('points', {
    year, board, me, canViewAll, sections: sections(),
    pending: P.APPROVERS.includes(req.user.role) ? pending : pending.filter((p) => p.requested_by === req.user.id),
    canDecide: P.APPROVERS.includes(req.user.role), canRequest: P.REQUESTERS.includes(req.user.role), canConfigure: ['admin', 'hr'].includes(req.user.role),
    rules: all('SELECT * FROM point_rules ORDER BY auto DESC, points DESC'),
    employees: all("SELECT id, employee_no, name_ar, name_en FROM employees WHERE status = 'active' AND role NOT IN ('admin','auditor') ORDER BY employee_no"),
    years: all('SELECT DISTINCT year FROM point_transactions ORDER BY year DESC').map((r) => r.year),
    myStatement: P.statement(req.user.id, year),
  });
});

router.get('/points/employee/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id !== req.user.id && !viewAll(req.user)) throw new HttpError(403, res.locals.t('forbidden'));
  const e = get('SELECT e.*, s.code section_code FROM employees e LEFT JOIN org_units s ON s.id = e.section_id WHERE e.id = ?', id);
  if (!e) throw new HttpError(404, 'Not found');
  const year = Number(req.query.year) || P.currentYear();
  res.render('points_employee', { e, year, st: P.standing(id, year), rows: P.statement(id, year), opening: P.opening(), self: id === req.user.id, canReverse: ['hr', 'department_manager', 'sector_head'].includes(req.user.role) });
});

router.get('/points/export', async (req, res, next) => {
  try {
    if (!viewAll(req.user)) throw new HttpError(403, res.locals.t('forbidden'));
    const year = Number(req.query.year) || P.currentYear();
    const b = P.leaderboard(year);
    const rows = b.rows.map((r) => ({ rank: r.rank || '', employee_no: r.employee_no, name: r.name_ar, section: r.section_code || '', opening: b.opening, change: r.delta, balance: r.balance, rating: r.rating || (r.below ? 'below_opening' : 'not_eligible'), awarded: r.awarded ? 'yes' : 'no' }));
    const tx = all(`SELECT e.employee_no, p.year, p.rule_code, p.points, p.reference, p.reason, p.status, p.requested_at, p.decided_at FROM point_transactions p JOIN employees e ON e.id = p.employee_id WHERE p.year = ? ORDER BY p.id`, year);
    audit(req, 'export', 'points', year, null, { rows: rows.length });
    const wb = await exportWorkbook([['leaderboard', rows], ['transactions', tx]]);
    res.attachment(`points_${year}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.post('/points', (req, res) => {
  const ids = P.request({ employeeIds: toArr(req.body.employee_ids), ruleCode: req.body.rule_code, reference: req.body.reference, reason: (req.body.reason || '').trim() }, req);
  res.flash('success', `${ids.length} → ${res.locals.t('ps_pending')}`);
  res.redirect('/points#pending');
});
router.post('/points/:id/decide', (req, res) => {
  P.decide(Number(req.params.id), req.body.decision !== 'rejected', (req.body.comment || '').trim(), req);
  res.redirect('/points#pending');
});
router.post('/points/:id/reverse', (req, res) => {
  const p = get('SELECT employee_id FROM point_transactions WHERE id = ?', Number(req.params.id));
  P.reverse(Number(req.params.id), (req.body.reason || '').trim(), req);
  res.redirect(`/points/employee/${p.employee_id}`);
});
router.post('/points/:id/appeal', (req, res) => {
  P.appeal(Number(req.params.id), (req.body.reason || '').trim(), req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/points/employee/${req.user.id}`);
});

router.post('/points/rules', requireRole('admin', 'hr'), (req, res) => {
  const before = { rules: all('SELECT code, points, active FROM point_rules'), tiers: P.tierSizes() };
  for (const r of all('SELECT * FROM point_rules WHERE code <> ?', 'reversal')) {
    const pts = Number(req.body[`points_${r.code}`]);
    if (!Number.isInteger(pts)) throw new HttpError(400, `${r.code}: invalid`);
    run('UPDATE point_rules SET points = ?, active = ? WHERE code = ?', pts, req.body[`active_${r.code}`] ? 1 : 0, r.code);
  }
  P.setTierSizes(['tier_0', 'tier_1', 'tier_2', 'tier_3'].map((k) => req.body[k]));
  const open = Number(req.body.opening);
  if (Number.isInteger(open) && open >= 0) require('../db').setSetting('points_opening_balance', open);
  audit(req, 'update', 'point_rules', null, before, { rules: all('SELECT code, points, active FROM point_rules'), tiers: P.tierSizes(), opening: open });
  res.flash('success', res.locals.t('saved'));
  res.redirect('/points#rules');
});

module.exports = router;

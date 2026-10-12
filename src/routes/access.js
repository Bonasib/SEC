'use strict';
const express = require('express');
const { all, get } = require('../db');
const { HttpError, localToUtc, nowIso } = require('../util');
const { sections } = require('../org');
const A = require('../access');

const router = express.Router();
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ROLE_ORDER = ['employee', 'team_leader', 'foreman', 'section_head', 'division_manager', 'department_manager', 'sector_head', 'hr', 'safety', 'warehouse', 'auditor', 'admin'];

router.get('/permissions', (req, res) => {
  if (!['hr', 'admin', 'auditor'].includes(req.user.role)) throw new HttpError(403, res.locals.t('forbidden'));
  const now = nowIso();
  const grants = all(`SELECT g.*, e.employee_no, e.name_ar, e.name_en, e.role, s.code section_code, b.name_ar by_ar, b.name_en by_en, r.name_ar rev_ar
    FROM user_permissions g JOIN employees e ON e.id = g.employee_id LEFT JOIN org_units s ON s.id = g.section_id
    LEFT JOIN employees b ON b.id = g.granted_by LEFT JOIN employees r ON r.id = g.revoked_by ORDER BY g.id DESC`);
  grants.forEach((g) => { g.state = g.revoked_at ? 'revoked' : g.expires_at && g.expires_at <= now ? 'expired' : 'active'; });
  res.render('permissions', {
    grants, PERMISSIONS: A.PERMISSIONS, ROLE_DEFAULTS: A.ROLE_DEFAULTS, ROLE_ORDER, sections: sections(), canGrant: A.GRANTERS.includes(req.user.role),
    employees: all("SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.role, s.code section_code FROM employees e LEFT JOIN org_units s ON s.id = e.section_id WHERE e.status = 'active' ORDER BY e.employee_no"),
  });
});

router.post('/permissions', (req, res) => {
  const n = A.grant({
    employeeIds: toArr(req.body.employee_ids), permission: req.body.permission, sectionId: Number(req.body.section_id) || null,
    expiresAt: req.body.expires_at ? localToUtc(req.body.expires_at + 'T23:59') : null, note: req.body.note,
  }, req);
  res.flash('success', `${n} ✓`);
  res.redirect('/permissions');
});

router.post('/permissions/:id(\\d+)/revoke', (req, res) => {
  A.revoke(Number(req.params.id), req);
  res.redirect('/permissions');
});

// ---------- activity feed: every update and modification on work orders ----------
const WO_ENTITIES = ['work_order', 'wo_photo', 'material_line', 'material_reservation'];
router.get('/activity', (req, res) => {
  const scope = A.can(req.user, 'wo.view_history');
  if (!scope) throw new HttpError(403, res.locals.t('forbidden'));
  const cond = [`a.entity IN (${WO_ENTITIES.map(() => '?').join(',')})`, "a.action NOT IN ('export','import_preview')"];
  const p = [...WO_ENTITIES];
  if (Array.isArray(scope)) { cond.push(`w.section_id IN (${scope.map(() => '?').join(',')})`); p.push(...scope); }
  if (req.query.q) { cond.push('w.wo_number LIKE ?'); p.push(`%${req.query.q.trim().toUpperCase()}%`); }
  if (req.query.section) { cond.push('w.section_id = ?'); p.push(Number(req.query.section)); }
  if (req.query.kind) { cond.push('a.action = ?'); p.push(req.query.kind); }
  const rows = all(`SELECT a.*, e.employee_no, e.name_ar, e.name_en, w.id wo_id, w.wo_number, w.title, w.status wo_status, s.code section_code
    FROM audit_log a JOIN work_orders w ON w.wo_number = CASE WHEN instr(a.entity_id, ':') > 0 THEN substr(a.entity_id, 1, instr(a.entity_id, ':') - 1) ELSE a.entity_id END
    LEFT JOIN employees e ON e.id = a.employee_id LEFT JOIN org_units s ON s.id = w.section_id
    WHERE ${cond.join(' AND ')} ORDER BY a.id DESC LIMIT 250`, ...p);
  res.render('activity', {
    rows, sections: Array.isArray(scope) ? sections().filter((s) => scope.includes(s.id)) : sections(),
    kinds: all(`SELECT DISTINCT action FROM audit_log WHERE entity IN (${WO_ENTITIES.map(() => '?').join(',')}) ORDER BY action`, ...WO_ENTITIES).map((r) => r.action),
    scoped: Array.isArray(scope),
  });
});

module.exports = router;

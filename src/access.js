'use strict';
// Fine-grained permissions: each role has defaults, and HR/admin can grant extra
// permissions to individual employees (optionally limited to one section and/or until a date).
const { all, get, run } = require('./db');
const { nowIso, audit, HttpError } = require('./util');
const { notify } = require('./notify');

const PERMISSIONS = {
  'wo.view_all': ['عرض جميع أوامر العمل وحالتها', 'View all work orders and their status'],
  'wo.view_history': ['عرض تحديثات وتعديلات أوامر العمل (السجل)', 'View work order updates & modifications (history)'],
  'calendar.view_all': ['عرض تقويم جميع الفرق', 'View every team calendar'],
  'travel.view_all': ['عرض مهام السفر لجميع الموظفين', 'View travel assignments of all employees'],
  'points.view_all': ['عرض ترتيب النقاط لجميع الموظفين', 'View the points leaderboard'],
  'training.manage': ['إدارة الدورات التدريبية والتسجيل', 'Manage training courses & registrations'],
  'plans.view': ['عرض خطط التحسين', 'View improvement plans'],
  'fleet.manage': ['إدارة أسطول المركبات', 'Manage the vehicle fleet'],
  'employees.manage': ['إضافة وتعديل الموظفين', 'Add and edit employees'],
  'materials.manage': ['إدارة المواد والعدد والمعدات والمخزون', 'Manage materials, tools, equipment & stock'],
  'tasks.dispatch': ['إنشاء المهام اليومية وإرسالها', 'Create and send daily tasks'],
};

const MANAGERS = ['section_head', 'division_manager', 'department_manager', 'sector_head'];
const ROLE_DEFAULTS = {
  'wo.view_all': [...MANAGERS, 'team_leader', 'foreman', 'hr', 'safety', 'warehouse', 'admin', 'auditor'],
  'wo.view_history': [...MANAGERS, 'foreman', 'hr', 'admin', 'auditor'],
  'calendar.view_all': [...MANAGERS, 'hr', 'safety', 'admin', 'auditor'],
  'travel.view_all': [...MANAGERS, 'team_leader', 'foreman', 'hr', 'admin', 'auditor'],
  'points.view_all': [...MANAGERS, 'team_leader', 'foreman', 'hr', 'safety', 'admin', 'auditor'],
  'training.manage': ['hr', 'admin'],
  'plans.view': [...MANAGERS, 'hr', 'admin', 'auditor'],
  'fleet.manage': ['admin', 'safety'],
  'employees.manage': ['hr', 'admin'],
  'materials.manage': ['warehouse', 'admin'],
  'tasks.dispatch': [...MANAGERS, 'team_leader', 'foreman', 'admin'],
};
const GRANTERS = ['hr', 'admin'];

function activeGrants(employeeId, permission) {
  return all(`SELECT * FROM user_permissions WHERE employee_id = ? AND permission = ? AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > ?)`, employeeId, permission, nowIso());
}

/**
 * Does the user hold a permission? With sectionId, a section-scoped grant must match it.
 * Returns true, false, or (when sectionId is omitted) the list of section ids for scoped-only grants.
 */
function can(user, permission, sectionId) {
  if (!user) return false;
  if ((ROLE_DEFAULTS[permission] || []).includes(user.role)) return true;
  const grants = activeGrants(user.id, permission);
  if (!grants.length) return false;
  if (grants.some((g) => !g.section_id)) return true;
  if (sectionId !== undefined) return grants.some((g) => g.section_id === sectionId);
  return grants.map((g) => g.section_id);
}

// SQL condition limiting work orders to what the user may see
function woScope(user) {
  const v = can(user, 'wo.view_all');
  if (v === true) return { sql: '', params: [] };
  const parts = ['w.id IN (SELECT wo_id FROM wo_participants WHERE employee_id = ?)', 'w.team_leader_id = ?'];
  const params = [user.id, user.id];
  if (Array.isArray(v) && v.length) { parts.push(`w.section_id IN (${v.map(() => '?').join(',')})`); params.push(...v); }
  return { sql: `(${parts.join(' OR ')})`, params };
}

// Same scope as an inline SQL fragment (all values are integer ids) for aggregate queries
function woScopeLiteral(user) {
  const sc = woScope(user);
  if (!sc.sql) return '';
  let i = 0;
  return ' AND ' + sc.sql.replace(/\?/g, () => String(Number(sc.params[i++])));
}

function grant({ employeeIds, permission, sectionId, expiresAt, note }, req) {
  if (!GRANTERS.includes(req.user.role)) throw new HttpError(403, 'Only HR or the administrator can grant permissions / الصلاحية لدى الموارد البشرية أو مشغل النظام');
  if (!PERMISSIONS[permission]) throw new HttpError(400, 'Unknown permission');
  const ids = [...new Set((employeeIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'Choose at least one employee / اختر موظفًا');
  const [ar, en] = PERMISSIONS[permission];
  const sec = sectionId ? get('SELECT * FROM org_units WHERE id = ?', sectionId) : null;
  for (const id of ids) {
    const r = run('INSERT INTO user_permissions(employee_id, permission, section_id, expires_at, granted_by, note) VALUES (?,?,?,?,?,?)',
      id, permission, sectionId || null, expiresAt || null, req.user.id, note || null);
    audit(req, 'grant', 'permission', r.lastInsertRowid, null, { employee_id: id, permission, section_id: sectionId || null, expires_at: expiresAt || null });
  }
  notify(ids, {
    type: 'permission_granted', title: `صلاحية جديدة: ${ar} / New permission: ${en}`,
    body: `${sec ? `${sec.name_ar} / ${sec.name_en}` : 'جميع الأقسام / All sections'}${expiresAt ? `\nحتى / until ${expiresAt.slice(0, 10)}` : ''}`,
    link: permission.startsWith('wo.') ? '/activity' : '/',
  });
  return ids.length;
}

function revoke(id, req) {
  if (!GRANTERS.includes(req.user.role)) throw new HttpError(403, 'Forbidden');
  const g = get('SELECT * FROM user_permissions WHERE id = ?', id);
  if (!g || g.revoked_at) throw new HttpError(400, 'Not active');
  run('UPDATE user_permissions SET revoked_at = ?, revoked_by = ? WHERE id = ?', nowIso(), req.user.id, id);
  audit(req, 'revoke', 'permission', id, g, { revoked: true });
  const [ar, en] = PERMISSIONS[g.permission] || [g.permission, g.permission];
  notify([g.employee_id], { type: 'permission_revoked', email: false, title: `أُلغيت صلاحية: ${ar} / Permission revoked: ${en}`, body: '' });
}

module.exports = { PERMISSIONS, ROLE_DEFAULTS, GRANTERS, can, woScope, woScopeLiteral, grant, revoke, activeGrants };

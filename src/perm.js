'use strict';
const { get } = require('./db');
const { HttpError, nowIso } = require('./util');
const { officialsAt } = require('./org');

const MANAGERS = ['section_head', 'division_manager', 'department_manager', 'sector_head'];
const WO_CREATORS = ['team_leader', 'foreman', ...MANAGERS, 'admin'];
// Roles that may open the employee directory and other people's profiles
const PEOPLE_VIEW = ['hr', 'admin', 'auditor', 'team_leader', 'foreman', 'safety', ...MANAGERS];

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, res.locals.t('forbidden')));

const isParticipant = (wo, user) => !!get('SELECT 1 FROM wo_participants WHERE wo_id = ? AND employee_id = ?', wo.id, user.id);

function canViewWO(wo, user) {
  if (isParticipant(wo, user) || wo.team_leader_id === user.id) return true;
  return require('./access').can(user, 'wo.view_all', wo.section_id) === true;
}

// Execution data (photos, results, used materials): the team and the responsible managers.
function canWorkOnWO(wo, user) {
  if (isParticipant(wo, user) || wo.team_leader_id === user.id) return true;
  const o = officialsAt(wo.section_id, nowIso());
  return ['section_head', 'division_manager'].some((k) => o[k]?.employee_id === user.id);
}

function canManageWO(wo, user) {
  if (user.role === 'admin' || wo.team_leader_id === user.id || wo.created_by === user.id) return true;
  const o = officialsAt(wo.section_id, nowIso());
  return MANAGERS.some((k) => o[k]?.employee_id === user.id);
}

module.exports = { requireRole, canViewWO, canWorkOnWO, canManageWO, isParticipant, WO_CREATORS, MANAGERS, PEOPLE_VIEW };

'use strict';
const { get, all } = require('./db');

const POSITION_BY_LEVEL = {
  section: 'section_head',
  division: 'division_manager',
  department: 'department_manager',
  sector: 'sector_head',
};

// Who held the manager position of a unit at a moment: an active acting
// assignment wins over the permanent manager.
function holderAt(unitId, atIso) {
  const unit = get('SELECT * FROM org_units WHERE id = ?', unitId);
  if (!unit) return null;
  const acting = get(
    `SELECT a.*, e.name_ar, e.name_en, e.employee_no FROM acting_assignments a
     JOIN employees e ON e.id = a.acting_employee_id
     WHERE a.unit_id = ? AND a.cancelled = 0 AND a.start_at <= ? AND a.end_at >= ?
     ORDER BY a.start_at DESC LIMIT 1`, unitId, atIso, atIso);
  if (acting) {
    return { employee_id: acting.acting_employee_id, employee_no: acting.employee_no, name_ar: acting.name_ar, name_en: acting.name_en, acting: true, decision_no: acting.decision_no, unit_code: unit.code };
  }
  if (!unit.manager_id) return { employee_id: null, unit_code: unit.code, acting: false };
  const e = get('SELECT id, employee_no, name_ar, name_en FROM employees WHERE id = ?', unit.manager_id);
  return { employee_id: e.id, employee_no: e.employee_no, name_ar: e.name_ar, name_en: e.name_en, acting: false, unit_code: unit.code };
}

// Snapshot of section head, division, department and sector managers at a moment.
function officialsAt(sectionId, atIso) {
  const out = {};
  let unit = sectionId ? get('SELECT * FROM org_units WHERE id = ?', sectionId) : null;
  while (unit) {
    const pos = POSITION_BY_LEVEL[unit.level];
    if (pos) out[pos] = holderAt(unit.id, atIso);
    unit = unit.parent_id ? get('SELECT * FROM org_units WHERE id = ?', unit.parent_id) : null;
  }
  return out;
}

function unitPath(unitId) {
  const parts = [];
  let u = unitId ? get('SELECT * FROM org_units WHERE id = ?', unitId) : null;
  while (u) { parts.unshift(u); u = u.parent_id ? get('SELECT * FROM org_units WHERE id = ?', u.parent_id) : null; }
  return parts;
}

const sections = () => all("SELECT * FROM org_units WHERE level = 'section' ORDER BY code");

module.exports = { holderAt, officialsAt, unitPath, sections, POSITION_BY_LEVEL };

'use strict';
const express = require('express');
const { all, get, run } = require('../db');
const { audit, HttpError, localToUtc, hashPassword, todayRiyadh, nowIso } = require('../util');
const { sections, unitPath, officialsAt } = require('../org');
const { requireRole, MANAGERS } = require('../perm');
const { ROLES, LEAVE_TYPES, MODE_TYPES, MODES } = require('../entities');
const { notify } = require('../notify');
const W = require('../workorders');

const router = express.Router();
const PEOPLE_VIEW = ['hr', 'admin', 'auditor', 'team_leader', 'safety', ...MANAGERS];

router.get('/employees', requireRole(...PEOPLE_VIEW), (req, res) => {
  const cond = [], p = [];
  if (req.query.section) { cond.push('e.section_id = ?'); p.push(Number(req.query.section)); }
  if (req.query.role) { cond.push('e.role = ?'); p.push(req.query.role); }
  if (req.query.q) { cond.push('(e.employee_no LIKE ? OR e.name_ar LIKE ? OR e.name_en LIKE ? OR e.job_title_en LIKE ?)'); p.push(...Array(4).fill(`%${req.query.q}%`)); }
  const today = todayRiyadh();
  const rows = all(`SELECT e.*, s.code section_code,
      (SELECT type FROM leaves l WHERE l.employee_id = e.id AND l.status='approved' AND l.start_date <= ? AND l.end_date >= ? LIMIT 1) leave_today,
      (SELECT COUNT(*) FROM wo_participants x JOIN work_orders w ON w.id = x.wo_id WHERE x.employee_id = e.id AND w.status = 'in_progress') busy
    FROM employees e LEFT JOIN org_units s ON s.id = e.section_id ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY e.employee_no`, today, today, ...p);
  const pts = Object.fromEntries(require('../points').leaderboard().rows.map((r) => [r.id, r]));
  res.render('employees', { rows, sections: sections(), ROLES, pts, canManage: canManagePeople(req.user) });
});

router.get('/employees/:id(\\d+)', (req, res) => {
  const e = get('SELECT e.*, s.code section_code FROM employees e LEFT JOIN org_units s ON s.id = e.section_id WHERE e.id = ?', Number(req.params.id));
  if (!e) throw new HttpError(404, 'Not found');
  if (e.id !== req.user.id && !PEOPLE_VIEW.includes(req.user.role)) throw new HttpError(403, res.locals.t('forbidden'));
  const year = todayRiyadh().slice(0, 4);
  const dist = Object.fromEntries(['A', 'B', 'C'].map((c) => [c, W.distanceCounts([e.id], c, year)[0].count]));
  const stats = get(`SELECT COUNT(*) total, SUM(w.status='closed') closed, SUM(w.priority IN ('C1','C2','C3','C4')) critical, SUM(w.overnight) overnight,
      ROUND(SUM(w.distance_km)) km, ROUND(SUM(w.travel_hours),1) travel
    FROM wo_participants p JOIN work_orders w ON w.id = p.wo_id WHERE p.employee_id = ? AND w.status <> 'cancelled' AND substr(w.planned_start,1,4) = ?`, e.id, year);
  const photoRate = get(`SELECT COUNT(*) n, SUM(EXISTS(SELECT 1 FROM wo_photos f WHERE f.wo_id = w.id AND f.stage='before') AND EXISTS(SELECT 1 FROM wo_photos f WHERE f.wo_id = w.id AND f.stage='after')) ok
    FROM wo_participants p JOIN work_orders w ON w.id = p.wo_id WHERE p.employee_id = ? AND w.status = 'closed'`, e.id);
  res.render('employee', {
    e, dist, stats, photoRate, year, ROLES, sections: sections(),
    path_: unitPath(e.section_id), officials: e.section_id ? officialsAt(e.section_id, nowIso()) : {},
    leaves: all('SELECT * FROM leaves WHERE employee_id = ? ORDER BY start_date DESC LIMIT 20', e.id),
    wos: all('SELECT w.* FROM wo_participants p JOIN work_orders w ON w.id = p.wo_id WHERE p.employee_id = ? ORDER BY w.id DESC LIMIT 30', e.id),
    canEdit: canManagePeople(req.user), self: e.id === req.user.id, pts: require('../points').standing(e.id),
  });
});

// ----- employee directory: add / edit -----
const EMPLOYMENT_TYPES = ['permanent', 'contract', 'secondment', 'trainee'];
const SHIFTS = ['day', 'rotating', 'on_call', 'night'];
const canManagePeople = (user) => require('../access').can(user, 'employees.manage') === true;

function employeeFromBody(b, existingId = 0) {
  const d = {
    employee_no: (b.employee_no || '').trim(), name_ar: (b.name_ar || '').trim(), name_en: (b.name_en || '').trim() || null,
    email: (b.email || '').trim().toLowerCase() || null, phone: (b.phone || '').trim() || null, national_id: (b.national_id || '').trim() || null,
    nationality: b.nationality || null, section_id: Number(b.section_id) || null, job_title_ar: b.job_title_ar || null, job_title_en: b.job_title_en || null,
    grade: b.grade || null, hire_date: b.hire_date || null, employment_type: EMPLOYMENT_TYPES.includes(b.employment_type) ? b.employment_type : null,
    shift: SHIFTS.includes(b.shift) ? b.shift : null, role: ROLES.includes(b.role) ? b.role : 'employee', status: b.status === 'inactive' ? 'inactive' : 'active',
    email_notifications: b.email_notifications === '1' ? 1 : 0, notes: b.notes || null,
  };
  const errors = [];
  if (!/^[A-Za-z0-9-]{2,20}$/.test(d.employee_no)) errors.push('Employee ID: 2-20 letters/digits / الرقم الوظيفي غير صحيح');
  if (!d.name_ar) errors.push('Arabic name is required / الاسم بالعربية مطلوب');
  if (!d.email) errors.push('Email is required (work orders and alerts are sent to it) / البريد الإلكتروني مطلوب');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) errors.push('Email is not valid / البريد غير صحيح');
  if (!d.section_id && !['admin', 'auditor', 'hr', 'safety', 'warehouse', 'department_manager', 'sector_head', 'division_manager'].includes(d.role)) errors.push('Section is required / القسم مطلوب');
  if (d.phone && !/^[+0-9 ()-]{7,20}$/.test(d.phone)) errors.push('Phone is not valid / رقم الهاتف غير صحيح');
  if (get('SELECT 1 FROM employees WHERE employee_no = ? AND id <> ?', d.employee_no, existingId)) errors.push('Employee ID already exists / الرقم الوظيفي موجود');
  if (d.email && get('SELECT 1 FROM employees WHERE lower(email) = ? AND id <> ?', d.email, existingId)) errors.push('Email already used by another employee / البريد مستخدم');
  return { d, errors };
}

function formData(extra = {}) {
  return { sections: sections(), ROLES, EMPLOYMENT_TYPES, SHIFTS, ...extra };
}

router.get('/employees/new', (req, res) => {
  if (!canManagePeople(req.user)) throw new HttpError(403, res.locals.t('forbidden'));
  res.render('employee_form', formData({ e: { status: 'active', role: 'employee', email_notifications: 1 }, mode: 'new', errors: [] }));
});

router.post('/employees', (req, res) => {
  if (!canManagePeople(req.user)) throw new HttpError(403, res.locals.t('forbidden'));
  const { d, errors } = employeeFromBody(req.body);
  const pw = req.body.password || '';
  if (pw && pw.length < 8) errors.push('Password must be at least 8 characters / 8 أحرف على الأقل');
  if (errors.length) return res.status(400).render('employee_form', formData({ e: { ...req.body, ...d }, mode: 'new', errors }));
  const r = run(`INSERT INTO employees(employee_no, name_ar, name_en, email, phone, national_id, nationality, section_id, job_title_ar, job_title_en, grade, hire_date,
    employment_type, shift, role, status, email_notifications, notes, password_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...Object.values(d), pw ? hashPassword(pw) : null);
  const id = Number(r.lastInsertRowid);
  audit(req, 'create', 'employee', d.employee_no, null, d);
  // Welcome message: the new employee receives their login ID (the password is handed over by HR, never emailed)
  notify([id], {
    type: 'welcome', title: 'مرحبًا بك في نظام نقل الطاقة / Welcome to the Transmission WMS',
    body: `الرقم الوظيفي للدخول / Login ID: ${d.employee_no}\nستصلك أوامر العمل والتنبيهات على هذا البريد.\nWork orders and alerts will be sent to this email.`,
    link: '/login',
  });
  const sec = d.section_id ? get('SELECT manager_id FROM org_units WHERE id = ?', d.section_id) : null;
  if (sec?.manager_id) notify([sec.manager_id], { type: 'employee_added', email: false, title: `موظف جديد في قسمك: ${d.name_ar} / New employee in your section`, body: d.employee_no, link: `/employees/${id}` });
  res.flash('success', `${d.employee_no} ✓`);
  res.redirect(`/employees/${id}`);
});

router.get('/employees/:id/edit', (req, res) => {
  if (!canManagePeople(req.user)) throw new HttpError(403, res.locals.t('forbidden'));
  const e = get('SELECT * FROM employees WHERE id = ?', Number(req.params.id));
  if (!e) throw new HttpError(404, 'Not found');
  res.render('employee_form', formData({ e, mode: 'edit', errors: [] }));
});

router.post('/employees/:id', (req, res) => {
  const e = get('SELECT * FROM employees WHERE id = ?', Number(req.params.id));
  if (!e) throw new HttpError(404, 'Not found');
  const b = req.body;
  const self = e.id === req.user.id;
  const manager = canManagePeople(req.user);
  if (!self && !manager) throw new HttpError(403, res.locals.t('forbidden'));
  if (b.new_password) {
    if (b.new_password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters / 8 أحرف على الأقل');
    run('UPDATE employees SET password_hash = ? WHERE id = ?', hashPassword(b.new_password), e.id);
    audit(req, 'password_change', 'employee', e.employee_no);
  }
  if (b.full_edit && manager) {
    const { d, errors } = employeeFromBody(b, e.id);
    if (errors.length) return res.status(400).render('employee_form', formData({ e: { ...e, ...d, id: e.id }, mode: 'edit', errors }));
    run(`UPDATE employees SET employee_no=?, name_ar=?, name_en=?, email=?, phone=?, national_id=?, nationality=?, section_id=?, job_title_ar=?, job_title_en=?, grade=?, hire_date=?,
      employment_type=?, shift=?, role=?, status=?, email_notifications=?, notes=? WHERE id=?`, ...Object.values(d), e.id);
    audit(req, 'update', 'employee', e.employee_no, { ...e, password_hash: undefined }, d);
    if (d.section_id !== e.section_id) notify([e.id], { type: 'section_changed', title: 'تم تحديث قسمك / Your section was updated', body: '', link: `/employees/${e.id}` });
  }
  if (b.prefs) run('UPDATE employees SET email_notifications = ? WHERE id = ?', b.email_notifications === '1' ? 1 : 0, e.id);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/employees/${e.id}`);
});

// ----- leave / training / permission -----
router.get('/leaves', requireRole(...PEOPLE_VIEW), (req, res) => {
  const rows = all(`SELECT l.*, e.employee_no, e.name_ar, e.name_en FROM leaves l JOIN employees e ON e.id = l.employee_id
    ${req.query.current ? "WHERE l.end_date >= '" + todayRiyadh() + "'" : ''} ORDER BY l.start_date DESC LIMIT 500`);
  res.render('leaves', { rows, employees: all("SELECT id, employee_no, name_ar, name_en FROM employees WHERE status='active' ORDER BY employee_no"), LEAVE_TYPES, MODE_TYPES, MODES });
});

router.post('/leaves', requireRole('hr', 'admin'), (req, res) => {
  const b = req.body;
  if (!b.employee_id || !b.start_date || !b.end_date || b.end_date < b.start_date) throw new HttpError(400, 'Invalid leave dates / تواريخ غير صحيحة');
  const type = LEAVE_TYPES.includes(b.type) ? b.type : 'other';
  const mode = MODE_TYPES.includes(type) ? (MODES.includes(b.mode) ? b.mode : null) : null;
  if (MODE_TYPES.includes(type) && !mode) throw new HttpError(400, 'Choose remote or in person / اختر عن بُعد أو حضوري');
  const r = run('INSERT INTO leaves(employee_id, type, start_date, end_date, status, notes, mode, location) VALUES (?,?,?,?,?,?,?,?)',
    Number(b.employee_id), type, b.start_date, b.end_date, b.status || 'approved', b.notes || null, mode, b.location || null);
  audit(req, 'create', 'leave', r.lastInsertRowid, null, b);
  // Warn the team leaders of any active work the employee is now unavailable for
  const clashes = all(`SELECT DISTINCT w.id, w.wo_number, w.team_leader_id, w.officials_json FROM wo_participants p JOIN work_orders w ON w.id = p.wo_id
    WHERE p.employee_id = ? AND w.status IN ('awaiting_authorization','open','in_progress') AND substr(w.planned_start,1,10) <= ? AND substr(w.planned_end,1,10) >= ?`,
  Number(b.employee_id), b.end_date, b.start_date);
  const emp = get('SELECT employee_no, name_ar FROM employees WHERE id = ?', Number(b.employee_id));
  for (const w of clashes) {
    notify([w.team_leader_id, JSON.parse(w.officials_json || '{}').section_head?.employee_id], {
      type: 'leave_conflict', severity: 'warning', title: `${w.wo_number} - تعارض إجازة: ${emp.employee_no} ${emp.name_ar} / Leave conflicts with assignment`,
      body: `${b.type}: ${b.start_date} → ${b.end_date}`, link: `/wo/${w.id}`,
    });
  }
  if (clashes.length) res.flash('warning', `Conflicts with: ${clashes.map((c) => c.wo_number).join(', ')}`);
  res.redirect('/leaves');
});

router.post('/leaves/:id/cancel', requireRole('hr', 'admin'), (req, res) => {
  const l = get('SELECT * FROM leaves WHERE id = ?', Number(req.params.id));
  if (!l) throw new HttpError(404, 'Not found');
  run("UPDATE leaves SET status = 'cancelled' WHERE id = ?", l.id);
  if (l.course_id) run("UPDATE course_attendees SET attendance = 'cancelled' WHERE leave_id = ? AND attendance = 'registered'", l.id);
  audit(req, 'cancel', 'leave', l.id, l, { status: 'cancelled' });
  res.redirect('/leaves');
});

// ----- acting assignments -----
router.get('/acting', (req, res) => {
  const rows = all(`SELECT a.*, u.code, u.level, u.name_ar u_ar, u.name_en u_en, e.employee_no, e.name_ar, e.name_en FROM acting_assignments a
    JOIN org_units u ON u.id = a.unit_id JOIN employees e ON e.id = a.acting_employee_id ORDER BY a.start_at DESC`);
  const now = nowIso();
  rows.forEach((r) => { r.state = r.cancelled ? 'cancelled' : r.start_at > now ? 'scheduled' : r.end_at < now ? 'expired' : 'active'; });
  const at = req.query.at ? localToUtc(req.query.at) : null;
  const lookup = at && req.query.section ? officialsAt(Number(req.query.section), at) : null;
  res.render('acting', {
    rows, lookup,
    units: all("SELECT * FROM org_units WHERE level IN ('section','division','department','sector') ORDER BY id"),
    employees: all("SELECT id, employee_no, name_ar, name_en FROM employees WHERE status='active' ORDER BY employee_no"),
    sections: sections(), canEdit: ['hr', 'admin'].includes(req.user.role),
  });
});

router.post('/acting', requireRole('hr', 'admin'), (req, res) => {
  const b = req.body;
  const start = localToUtc(b.start_at), end = localToUtc(b.end_at);
  if (!b.unit_id || !b.acting_employee_id || !start || !end || end <= start) throw new HttpError(400, 'Invalid acting assignment / بيانات غير صحيحة');
  const r = run('INSERT INTO acting_assignments(unit_id, acting_employee_id, assignment_type, start_at, end_at, decision_no, approving_authority) VALUES (?,?,?,?,?,?,?)',
    Number(b.unit_id), Number(b.acting_employee_id), b.assignment_type || 'temporary', start, end, b.decision_no || null, b.approving_authority || null);
  audit(req, 'create', 'acting_assignment', r.lastInsertRowid, null, { ...b, start_at: start, end_at: end });
  const u = get('SELECT * FROM org_units WHERE id = ?', Number(b.unit_id));
  notify([Number(b.acting_employee_id), u.manager_id], {
    type: 'acting_assigned', title: `تكليف إداري: ${u.name_ar} / Acting assignment: ${u.name_en}`,
    body: `${b.start_at} → ${b.end_at}${b.decision_no ? `\nقرار / Decision: ${b.decision_no}` : ''}`, link: '/acting',
  });
  res.redirect('/acting');
});

router.post('/acting/:id/cancel', requireRole('hr', 'admin'), (req, res) => {
  const a = get('SELECT * FROM acting_assignments WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Not found');
  run('UPDATE acting_assignments SET cancelled = 1 WHERE id = ?', a.id);
  audit(req, 'cancel', 'acting_assignment', a.id, a, { cancelled: 1 });
  res.redirect('/acting');
});

// ----- organization -----
router.get('/org', (req, res) => {
  const units = all(`SELECT u.*, e.employee_no, e.name_ar m_ar, e.name_en m_en, (SELECT COUNT(*) FROM employees x WHERE x.section_id = u.id) staff FROM org_units u LEFT JOIN employees e ON e.id = u.manager_id ORDER BY u.id`);
  const now = nowIso();
  const tree = (pid, depth) => units.filter((u) => (u.parent_id || null) === pid).flatMap((u) => [{ ...u, depth, holder: officialsHolder(u, now) }, ...tree(u.id, depth + 1)]);
  res.render('org', { rows: tree(null, 0) });
});
function officialsHolder(u, now) {
  const a = get(`SELECT e.name_ar, e.name_en FROM acting_assignments a JOIN employees e ON e.id = a.acting_employee_id WHERE a.unit_id = ? AND a.cancelled = 0 AND a.start_at <= ? AND a.end_at >= ?`, u.id, now, now);
  return a;
}

module.exports = router;

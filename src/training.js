'use strict';
// Training courses (local & international), attendance, and rule-based improvement suggestions.
// Registering an employee automatically books a linked "training" absence, so the course shows
// on the team calendar and blocks conflicting work assignments.
const { all, get, run, tx } = require('./db');
const { nowIso, audit, HttpError, todayRiyadh } = require('./util');
const { notify } = require('./notify');
const { officialsAt } = require('./org');

const CATEGORIES = ['asset_management', 'towers_lines', 'digital_substations', 'protection', 'cables', 'gcb_sf6', 'hv_safety', 'emergency', 'lifting_height', 'thermal_inspection', 'job_hazard', 'team_management', 'facilities', 'fire_systems', 'low_voltage'];

// Which course categories help each section's work
const SECTION_CATEGORIES = {
  H1: ['towers_lines', 'thermal_inspection', 'lifting_height', 'hv_safety'],
  H2: ['cables', 'hv_safety', 'job_hazard'],
  H3: ['team_management', 'job_hazard', 'asset_management'],
  H4: ['facilities', 'job_hazard', 'hv_safety'],
  H5: ['emergency', 'team_management', 'hv_safety'],
  H6: ['low_voltage', 'digital_substations', 'hv_safety'],
  H7: ['gcb_sf6', 'digital_substations', 'hv_safety'],
  H8: ['protection', 'digital_substations'],
  H9: ['fire_systems', 'emergency', 'job_hazard'],
};
const ATTENDANCE = ['registered', 'attended', 'absent', 'cancelled'];

const daysOf = (c) => Math.round((Date.parse(c.end_date) - Date.parse(c.start_date)) / 864e5) + 1;
const placeOf = (c) => [c.city, c.country].filter(Boolean).join(' - ') || null;

function courseErrors(c) {
  const e = [];
  if (!c.code) e.push('Course code is required / رمز الدورة مطلوب');
  if (!c.title_ar || !c.title_en) e.push('Both titles are required / العنوانان مطلوبان');
  if (!['local', 'international'].includes(c.scope)) e.push('Scope: local / international');
  if (c.scope === 'international' && !c.country) e.push('International courses require the country / الدولة مطلوبة للدورات الخارجية');
  if (c.scope === 'local' && c.mode === 'in_person' && !c.city) e.push('Local in-person courses require the city / المدينة مطلوبة');
  if (!c.start_date || !c.end_date || c.end_date < c.start_date) e.push('Valid start and end dates are required / التواريخ غير صحيحة');
  if (!CATEGORIES.includes(c.category)) e.push('Choose a category / اختر التصنيف');
  return e;
}

function saveCourse(c, req, id = null) {
  const errs = courseErrors(c);
  if (get('SELECT 1 FROM courses WHERE code = ? AND id <> ?', c.code, id || 0)) errs.push('Course code already exists / رمز الدورة موجود');
  if (errs.length) throw new HttpError(400, errs.join('\n'));
  const vals = [c.code, c.title_ar, c.title_en, c.scope, c.category, c.country || null, c.city || null, c.provider || null, c.mode || 'in_person',
    c.start_date, c.end_date, c.hours || null, c.language || null, c.capacity || null, c.cost || null, c.status || 'planned'];
  if (id) {
    const before = get('SELECT * FROM courses WHERE id = ?', id);
    run(`UPDATE courses SET code=?, title_ar=?, title_en=?, scope=?, category=?, country=?, city=?, provider=?, mode=?, start_date=?, end_date=?, hours=?, language=?, capacity=?, cost=?, status=? WHERE id=?`, ...vals, id);
    // Keep linked absences in step with the course dates / mode / place
    run(`UPDATE leaves SET start_date = ?, end_date = ?, mode = ?, location = ?, notes = ? WHERE course_id = ? AND status = 'approved'`, c.start_date, c.end_date, c.mode, placeOf(c), c.title_en, id);
    if (c.status === 'cancelled' && before.status !== 'cancelled') cancelCourseEffects(id, req);
    audit(req, 'update', 'course', c.code, before, c);
    return id;
  }
  const r = run(`INSERT INTO courses(code, title_ar, title_en, scope, category, country, city, provider, mode, start_date, end_date, hours, language, capacity, cost, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals);
  audit(req, 'create', 'course', c.code, null, c);
  return Number(r.lastInsertRowid);
}

function cancelCourseEffects(courseId, req) {
  const c = get('SELECT * FROM courses WHERE id = ?', courseId);
  const att = all("SELECT * FROM course_attendees WHERE course_id = ? AND attendance = 'registered'", courseId);
  run("UPDATE leaves SET status = 'cancelled' WHERE course_id = ?", courseId);
  run("UPDATE course_attendees SET attendance = 'cancelled' WHERE course_id = ? AND attendance = 'registered'", courseId);
  notify(att.map((a) => a.employee_id), { type: 'course_cancelled', severity: 'warning', title: `أُلغيت الدورة: ${c.title_ar} / Course cancelled: ${c.title_en}`, body: `${c.start_date} → ${c.end_date}`, link: `/training/${c.id}` });
  audit(req, 'cancel', 'course', c.code, null, { attendees: att.length });
}

/** Register employees on a course: creates the attendee row and a linked approved training absence. */
function register(courseId, employeeIds, role, req) {
  const c = get('SELECT * FROM courses WHERE id = ?', courseId);
  if (!c || c.status === 'cancelled') throw new HttpError(400, 'Course not open for registration / الدورة غير متاحة');
  const ids = [...new Set((employeeIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'Choose at least one employee / اختر موظفًا');
  const taken = get("SELECT COUNT(*) n FROM course_attendees WHERE course_id = ? AND attendance <> 'cancelled'", courseId).n;
  if (c.capacity && taken + ids.length > c.capacity) throw new HttpError(400, `Course capacity is ${c.capacity} (${taken} registered) / السعة ممتلئة`);
  const W = require('./workorders');
  const errors = [];
  for (const id of ids) {
    if (get("SELECT 1 FROM course_attendees WHERE course_id = ? AND employee_id = ? AND attendance <> 'cancelled'", courseId, id)) {
      errors.push(`${get('SELECT employee_no FROM employees WHERE id = ?', id).employee_no}: already registered / مسجل مسبقًا`);
      continue;
    }
    // Course days must be free (no other leave, course or work assignment)
    const errs = W.availabilityErrors({ participantIds: [id], plannedStart: c.start_date + 'T00:00:00Z', plannedEnd: c.end_date + 'T20:59:59Z' });
    if (errs.length) errors.push(...errs);
  }
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  tx(() => {
    for (const id of ids) {
      run(`INSERT INTO leaves(employee_id, type, start_date, end_date, status, mode, location, notes, course_id) VALUES (?, 'training', ?, ?, 'approved', ?, ?, ?, ?)
        ON CONFLICT(employee_id, type, start_date) DO UPDATE SET end_date = excluded.end_date, status = 'approved', mode = excluded.mode, location = excluded.location, notes = excluded.notes, course_id = excluded.course_id`,
      id, c.start_date, c.end_date, c.mode, placeOf(c), c.title_en, c.id);
      const leaveId = get("SELECT id FROM leaves WHERE employee_id = ? AND type = 'training' AND start_date = ?", id, c.start_date).id;
      run(`INSERT INTO course_attendees(course_id, employee_id, role, leave_id, registered_by) VALUES (?,?,?,?,?)
        ON CONFLICT(course_id, employee_id) DO UPDATE SET attendance = 'registered', leave_id = excluded.leave_id, role = excluded.role`, c.id, id, role || 'trainee', leaveId, req.user.id);
      audit(req, 'register', 'course', c.code, null, { employee_id: id, role });
    }
  });
  const where = c.mode === 'remote' ? 'عن بُعد / Remote' : placeOf(c);
  notify(ids, {
    type: 'course_registered', title: `تم تسجيلك في دورة: ${c.title_ar} / You are registered: ${c.title_en}`,
    body: `${c.start_date} → ${c.end_date} (${daysOf(c)} days)\n${where}${c.provider ? '\n' + c.provider : ''}`, link: `/training/${c.id}`,
    details: [['الدورة / Course', c.title_en], ['النوع / Scope', c.scope], ['المكان / Place', where], ['التاريخ / Dates', `${c.start_date} → ${c.end_date}`]],
  });
  const heads = new Set();
  for (const id of ids) {
    const e = get('SELECT section_id FROM employees WHERE id = ?', id);
    const h = e?.section_id ? officialsAt(e.section_id, nowIso()).section_head?.employee_id : null;
    if (h) heads.add(h);
  }
  notify([...heads], { type: 'course_registered', email: false, title: `تسجيل في دورة من فريقك: ${c.title_ar} / Team member(s) registered on a course`, body: `${ids.length} · ${c.start_date} → ${c.end_date}`, link: `/training/${c.id}` });
  return ids.length;
}

function updateAttendee(attendeeId, { attendance, result, score, certificate_no }, req) {
  const a = get('SELECT * FROM course_attendees WHERE id = ?', attendeeId);
  if (!a) throw new HttpError(404, 'Not found');
  if (!ATTENDANCE.includes(attendance)) throw new HttpError(400, 'Invalid attendance');
  const c = get('SELECT * FROM courses WHERE id = ?', a.course_id);
  run('UPDATE course_attendees SET attendance = ?, result = ?, score = ?, certificate_no = ? WHERE id = ?', attendance, result || null, score === '' || score == null ? null : Number(score), certificate_no || null, a.id);
  // Cancelling frees the employee again; an absence on a past course stays recorded
  if (attendance === 'cancelled' && a.leave_id) run("UPDATE leaves SET status = 'cancelled' WHERE id = ?", a.leave_id);
  if (attendance !== 'cancelled' && a.leave_id) run("UPDATE leaves SET status = 'approved' WHERE id = ?", a.leave_id);
  audit(req, 'attendance', 'course', c.code, a, { attendance, result, score, certificate_no });
  if (attendance === 'attended' && result === 'pass') {
    notify([a.employee_id], { type: 'course_passed', email: false, title: `اجتزت الدورة: ${c.title_ar} / Course passed: ${c.title_en}`, body: certificate_no ? `Certificate: ${certificate_no}` : '', link: `/training/${c.id}` });
  }
}

/**
 * Advisory suggestions (never automatic): who should train on what, and why.
 * - employees on an improvement plan or rated Satisfactory/Acceptable/below opening
 * - employees with no attended course in the last 12 months
 */
function suggestions({ limit = 40 } = {}) {
  const today = todayRiyadh();
  const yearAgo = new Date(Date.parse(today) - 365 * 864e5).toISOString().slice(0, 10);
  const upcoming = all("SELECT * FROM courses WHERE status = 'planned' AND start_date > ? ORDER BY start_date", today);
  const P = require('./points');
  const board = Object.fromEntries(P.leaderboard().rows.map((r) => [r.id, r]));
  const plans = Object.fromEntries(all("SELECT employee_id, id FROM improvement_plans WHERE status IN ('active','transfer_recommended')").map((r) => [r.employee_id, r.id]));
  const emps = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.job_title_en, s.code section_code,
      (SELECT MAX(c.end_date) FROM course_attendees a JOIN courses c ON c.id = a.course_id WHERE a.employee_id = e.id AND a.attendance = 'attended') last_course
    FROM employees e LEFT JOIN org_units s ON s.id = e.section_id WHERE e.status = 'active' AND e.role IN ('employee','team_leader','foreman') ORDER BY e.employee_no`);
  const out = [];
  for (const e of emps) {
    const b = board[e.id];
    const reasons = [];
    if (plans[e.id]) reasons.push('plan');
    else if (b && (b.below || ['satisfactory', 'acceptable'].includes(b.rating))) reasons.push(b.below ? 'below' : 'rating_' + b.rating);
    if (!e.last_course || e.last_course < yearAgo) reasons.push('no_recent');
    if (!reasons.length) continue;
    const cats = SECTION_CATEGORIES[e.section_code] || ['hv_safety'];
    const registered = new Set(all("SELECT course_id FROM course_attendees WHERE employee_id = ? AND attendance <> 'cancelled'", e.id).map((r) => r.course_id));
    const courses = upcoming.filter((c) => cats.includes(c.category) && !registered.has(c.id)).slice(0, 2);
    if (!courses.length) continue;
    out.push({ ...e, reasons, courses, plan_id: plans[e.id] || null, rating: b?.rating, balance: b?.balance, priority: plans[e.id] ? 0 : reasons[0].startsWith('rating') || reasons[0] === 'below' ? 1 : 2 });
  }
  return out.sort((a, b) => a.priority - b.priority || a.employee_no.localeCompare(b.employee_no)).slice(0, limit);
}

function stats(year) {
  const y = String(year);
  return get(`SELECT
      (SELECT COUNT(*) FROM courses WHERE substr(start_date,1,4) = ? AND status <> 'cancelled') courses,
      (SELECT COUNT(*) FROM courses WHERE substr(start_date,1,4) = ? AND scope = 'international' AND status <> 'cancelled') international,
      (SELECT COUNT(*) FROM course_attendees a JOIN courses c ON c.id = a.course_id WHERE substr(c.start_date,1,4) = ? AND a.attendance = 'attended') attended,
      (SELECT COUNT(DISTINCT a.employee_id) FROM course_attendees a JOIN courses c ON c.id = a.course_id WHERE substr(c.start_date,1,4) = ? AND a.attendance IN ('attended','registered')) people,
      (SELECT COUNT(*) FROM course_attendees a JOIN courses c ON c.id = a.course_id WHERE substr(c.start_date,1,4) = ? AND a.result = 'pass') passed,
      (SELECT COALESCE(SUM(c.hours),0) FROM course_attendees a JOIN courses c ON c.id = a.course_id WHERE substr(c.start_date,1,4) = ? AND a.attendance = 'attended') hours`, y, y, y, y, y, y);
}

module.exports = { CATEGORIES, SECTION_CATEGORIES, ATTENDANCE, saveCourse, register, updateAttendee, suggestions, stats, daysOf, placeOf, courseErrors };

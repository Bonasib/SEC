'use strict';
// Team calendar: every event of the year on one timeline (dates are Riyadh calendar dates).
const { all } = require('./db');
const { riyadhDate } = require('./workorders');

const ABSENCE_TYPES = ['annual', 'sick', 'emergency', 'training', 'workshop', 'factory_test', 'permission', 'business_travel', 'other'];
const EVENT_TYPES = ['holiday', 'work', ...ABSENCE_TYPES, 'acting'];

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

/**
 * Events overlapping [from, to] (inclusive YYYY-MM-DD).
 * filters: { sectionId, employeeId, types: Set|null }
 */
function eventsBetween(from, to, { sectionId, employeeId, types } = {}) {
  const want = (t) => !types || types.has(t);
  const out = [];

  if (want('holiday')) {
    for (const h of all('SELECT * FROM holidays WHERE start_date <= ? AND end_date >= ? ORDER BY start_date', to, from)) {
      out.push({ kind: 'holiday', type: 'holiday', start: h.start_date, end: h.end_date, name_ar: h.name_ar, name_en: h.name_en, approximate: !!h.approximate, id: h.id });
    }
  }

  const empCond = [], empParams = [];
  if (sectionId) { empCond.push('e.section_id = ?'); empParams.push(sectionId); }
  if (employeeId) { empCond.push('e.id = ?'); empParams.push(employeeId); }
  const absenceTypes = ABSENCE_TYPES.filter(want);
  if (absenceTypes.length) {
    const rows = all(`SELECT l.*, e.employee_no, e.name_ar, e.name_en, s.code section_code FROM leaves l
      JOIN employees e ON e.id = l.employee_id LEFT JOIN org_units s ON s.id = e.section_id
      WHERE l.status IN ('approved','pending') AND l.start_date <= ? AND l.end_date >= ?
      AND l.type IN (${absenceTypes.map(() => '?').join(',')}) ${empCond.length ? 'AND ' + empCond.join(' AND ') : ''}
      ORDER BY l.start_date`, to, from, ...absenceTypes, ...empParams);
    for (const l of rows) {
      out.push({ kind: 'absence', type: l.type, start: l.start_date, end: l.end_date, mode: l.mode, location: l.location, pending: l.status === 'pending',
        employee_id: l.employee_id, employee_no: l.employee_no, name_ar: l.name_ar, name_en: l.name_en, section_code: l.section_code, notes: l.notes });
    }
  }

  if (want('work')) {
    const cond = ["w.status <> 'cancelled'", 'w.planned_start <= ?', 'w.planned_end >= ?'];
    // planned times are UTC; widen by a day and trim on Riyadh dates below
    const params = [addDays(to, 1) + 'T23:59:59Z', addDays(from, -1) + 'T00:00:00Z'];
    if (sectionId) { cond.push('w.section_id = ?'); params.push(sectionId); }
    if (employeeId) { cond.push('w.id IN (SELECT wo_id FROM wo_participants WHERE employee_id = ?)'); params.push(employeeId); }
    for (const w of all(`SELECT w.id, w.wo_number, w.title, w.priority, w.status, w.planned_start, w.planned_end, s.code section_code,
        (SELECT COUNT(*) FROM wo_participants p WHERE p.wo_id = w.id) team_size
      FROM work_orders w LEFT JOIN org_units s ON s.id = w.section_id WHERE ${cond.join(' AND ')} ORDER BY w.planned_start`, ...params)) {
      const start = riyadhDate(w.planned_start), end = riyadhDate(w.planned_end);
      if (start > to || end < from) continue;
      out.push({ kind: 'work', type: 'work', start, end, id: w.id, wo_number: w.wo_number, title: w.title, priority: w.priority, status: w.status, section_code: w.section_code, team_size: w.team_size });
    }
  }

  if (want('acting')) {
    const cond = ['a.cancelled = 0', 'a.start_at <= ?', 'a.end_at >= ?'];
    const params = [addDays(to, 1) + 'T00:00:00Z', addDays(from, -1) + 'T00:00:00Z'];
    if (employeeId) { cond.push('a.acting_employee_id = ?'); params.push(employeeId); }
    for (const a of all(`SELECT a.*, u.code, u.name_ar u_ar, u.name_en u_en, e.employee_no, e.name_ar, e.name_en, e.section_id FROM acting_assignments a
      JOIN org_units u ON u.id = a.unit_id JOIN employees e ON e.id = a.acting_employee_id WHERE ${cond.join(' AND ')}`, ...params)) {
      if (sectionId && a.unit_id !== sectionId && a.section_id !== sectionId) continue;
      const start = riyadhDate(a.start_at), end = riyadhDate(a.end_at);
      if (start > to || end < from) continue;
      out.push({ kind: 'acting', type: 'acting', start, end, employee_no: a.employee_no, name_ar: a.name_ar, name_en: a.name_en, unit_ar: a.u_ar, unit_en: a.u_en, unit_code: a.code });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || EVENT_TYPES.indexOf(a.type) - EVENT_TYPES.indexOf(b.type));
}

// Per-day buckets for [from, to]
function byDay(events, from, to) {
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { date: d, holidays: [], work: [], absences: [], acting: [] };
  for (const ev of events) {
    const s = ev.start < from ? from : ev.start;
    const e = ev.end > to ? to : ev.end;
    for (let d = s; d <= e; d = addDays(d, 1)) {
      const b = days[d];
      if (!b) continue;
      if (ev.kind === 'holiday') b.holidays.push(ev);
      else if (ev.kind === 'work') b.work.push(ev);
      else if (ev.kind === 'acting') b.acting.push(ev);
      else b.absences.push(ev);
    }
  }
  return days;
}

// Days in a year per event type (counting each person-day for absences)
function yearSummary(events, year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const sum = {};
  for (const ev of events) {
    const s = ev.start < from ? from : ev.start;
    const e = ev.end > to ? to : ev.end;
    const n = daysBetween(s, e) + 1;
    sum[ev.type] = sum[ev.type] || { events: 0, days: 0 };
    sum[ev.type].events++;
    sum[ev.type].days += n;
  }
  return sum;
}

function toIcs(events, lang = 'ar') {
  const esc = (s) => String(s || '').replace(/[\\,;]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const d = (x) => x.replace(/-/g, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SEC Transmission WMS//Team Calendar//EN', 'CALSCALE:GREGORIAN', 'X-WR-TIMEZONE:Asia/Riyadh'];
  events.forEach((ev, i) => {
    const title = ev.kind === 'holiday' ? (lang === 'en' ? ev.name_en : ev.name_ar)
      : ev.kind === 'work' ? `${ev.wo_number} ${ev.title}`
      : ev.kind === 'acting' ? `${lang === 'en' ? ev.name_en || ev.name_ar : ev.name_ar} - ${lang === 'en' ? ev.unit_en : ev.unit_ar}`
      : `${ev.name_ar} - ${ev.type}${ev.mode ? ' (' + ev.mode + ')' : ''}`;
    lines.push('BEGIN:VEVENT', `UID:${ev.kind}-${ev.id || ev.employee_no || ''}-${ev.start}-${i}@sec-wms`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${d(ev.start)}`, `DTEND;VALUE=DATE:${d(addDays(ev.end, 1))}`, `SUMMARY:${esc(title)}`, `CATEGORIES:${ev.type}`, 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

module.exports = { eventsBetween, byDay, yearSummary, toIcs, addDays, ABSENCE_TYPES, EVENT_TYPES };

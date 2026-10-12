'use strict';
const express = require('express');
const { all, get, run } = require('../db');
const { audit, HttpError, todayRiyadh } = require('../util');
const { sections } = require('../org');
const { requireRole } = require('../perm');
const C = require('../calendar');
const { exportWorkbook, toCsv } = require('../importexport');

const router = express.Router();
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function filtersFrom(req) {
  const q = req.query;
  const types = toArr(q.t).filter((x) => C.EVENT_TYPES.includes(x));
  // Without the calendar.view_all permission an employee sees their own team (plus any granted sections)
  const v = require('../access').can(req.user, 'calendar.view_all');
  const own = req.user.section_id || null;
  let sectionId = q.section === 'all' ? null : Number(q.section) || (['employee', 'team_leader', 'foreman', 'section_head'].includes(req.user.role) ? own : null);
  if (v !== true) {
    const allowed = [own, ...(Array.isArray(v) ? v : [])].filter(Boolean);
    if (!allowed.includes(sectionId)) sectionId = own;
  }
  return { sectionId, employeeId: Number(q.employee) || null, types: types.length ? new Set(types) : null, typeList: types };
}

router.get('/calendar', (req, res) => {
  const today = todayRiyadh();
  const year = Number(req.query.year) || Number(today.slice(0, 4));
  const view = req.query.view === 'month' ? 'month' : 'year';
  const month = Math.min(12, Math.max(1, Number(req.query.month) || (year === Number(today.slice(0, 4)) ? Number(today.slice(5, 7)) : 1)));
  const f = filtersFrom(req);
  const yFrom = `${year}-01-01`, yTo = `${year}-12-31`;
  const events = C.eventsBetween(yFrom, yTo, f);
  const days = C.byDay(events, yFrom, yTo);
  const mm = String(month).padStart(2, '0');
  const mFrom = `${year}-${mm}-01`;
  const mTo = C.addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`, -1);
  const keep = new URLSearchParams();
  if (req.query.section) keep.set('section', req.query.section);
  if (f.employeeId) keep.set('employee', f.employeeId);
  f.typeList.forEach((x) => keep.append('t', x));
  res.render('calendar', {
    view, year, month, today, days, events, mFrom, mTo,
    monthEvents: events.filter((e) => e.start <= mTo && e.end >= mFrom),
    summary: C.yearSummary(events, year),
    holidays: all('SELECT * FROM holidays WHERE start_date <= ? AND end_date >= ? ORDER BY start_date', yTo, yFrom),
    sections: sections(), sectionId: f.sectionId, employeeId: f.employeeId, typeList: f.typeList,
    employees: all("SELECT id, employee_no, name_ar, name_en FROM employees WHERE status = 'active'" + (f.sectionId ? ' AND section_id = ?' : '') + ' ORDER BY employee_no', ...(f.sectionId ? [f.sectionId] : [])),
    EVENT_TYPES: C.EVENT_TYPES, keep: keep.toString(), canEditHolidays: ['admin', 'hr'].includes(req.user.role),
    teamSize: f.sectionId ? get("SELECT COUNT(*) n FROM employees WHERE status = 'active' AND section_id = ?", f.sectionId).n : get("SELECT COUNT(*) n FROM employees WHERE status = 'active'").n,
  });
});

router.get('/calendar/export', async (req, res, next) => {
  try {
    const year = Number(req.query.year) || Number(todayRiyadh().slice(0, 4));
    const events = C.eventsBetween(`${year}-01-01`, `${year}-12-31`, filtersFrom(req));
    audit(req, 'export', 'calendar', year, null, { events: events.length, format: req.query.format });
    if (req.query.format === 'ics') {
      res.type('text/calendar; charset=utf-8').attachment(`team_calendar_${year}.ics`);
      return res.send(C.toIcs(events, req.lang));
    }
    const rows = events.map((e) => ({
      type: e.type, start: e.start, end: e.end,
      title: e.kind === 'holiday' ? `${e.name_ar} / ${e.name_en}` : e.kind === 'work' ? `${e.wo_number} ${e.title}` : e.kind === 'task' ? `${e.time || ''} ${e.title}`.trim() : e.kind === 'acting' ? `${e.unit_ar} / ${e.unit_en}` : e.notes || '',
      employee_no: e.employee_no || '', employee: e.name_ar || e.people || '', section: e.section_code || e.unit_code || '',
      mode: e.mode || '', location: e.location || '', status: e.status || (e.pending ? 'pending' : ''), wo_number: e.wo_number || '',
    }));
    if (req.query.format === 'csv') { res.type('text/csv; charset=utf-8').attachment(`team_calendar_${year}.csv`); return res.send(toCsv(rows)); }
    const wb = await exportWorkbook([['calendar', rows]]);
    res.attachment(`team_calendar_${year}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.post('/holidays', requireRole('admin', 'hr'), (req, res) => {
  const b = req.body;
  if (!b.start_date || !b.name_ar || !b.name_en) throw new HttpError(400, 'Date and both names are required / التاريخ والاسمان مطلوبة');
  const end = b.end_date || b.start_date;
  if (end < b.start_date) throw new HttpError(400, 'End before start / النهاية قبل البداية');
  const r = run('INSERT INTO holidays(start_date, end_date, name_ar, name_en, kind, approximate) VALUES (?,?,?,?,?,?)',
    b.start_date, end, b.name_ar, b.name_en, b.kind === 'company' ? 'company' : 'public', b.approximate ? 1 : 0);
  audit(req, 'create', 'holiday', r.lastInsertRowid, null, b);
  res.redirect(`/calendar?year=${b.start_date.slice(0, 4)}#holidays`);
});

router.post('/holidays/:id(\\d+)', requireRole('admin', 'hr'), (req, res) => {
  const h = get('SELECT * FROM holidays WHERE id = ?', Number(req.params.id));
  if (!h) throw new HttpError(404, 'Not found');
  const b = req.body;
  if (!b.start_date || !b.name_ar || !b.name_en) throw new HttpError(400, 'Date and both names are required / التاريخ والاسمان مطلوبة');
  const end = b.end_date || b.start_date;
  if (end < b.start_date) throw new HttpError(400, 'End before start / النهاية قبل البداية');
  const after = { start_date: b.start_date, end_date: end, name_ar: b.name_ar, name_en: b.name_en, kind: b.kind === 'company' ? 'company' : 'public', approximate: b.approximate ? 1 : 0 };
  run('UPDATE holidays SET start_date=?, end_date=?, name_ar=?, name_en=?, kind=?, approximate=? WHERE id=?', ...Object.values(after), h.id);
  audit(req, 'update', 'holiday', h.id, h, after);
  res.redirect(`/calendar?year=${b.start_date.slice(0, 4)}#holidays`);
});

router.post('/holidays/:id/delete', requireRole('admin', 'hr'), (req, res) => {
  const h = get('SELECT * FROM holidays WHERE id = ?', Number(req.params.id));
  if (!h) throw new HttpError(404, 'Not found');
  run('DELETE FROM holidays WHERE id = ?', h.id);
  audit(req, 'delete', 'holiday', h.id, h, null);
  res.redirect(`/calendar?year=${h.start_date.slice(0, 4)}#holidays`);
});

module.exports = router;

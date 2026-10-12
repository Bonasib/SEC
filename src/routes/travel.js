'use strict';
const express = require('express');
const { HttpError, todayRiyadh } = require('../util');
const { sections } = require('../org');
const { can } = require('../access');
const TV = require('../travel');
const { exportWorkbook } = require('../importexport');

const router = express.Router();

// Managers/HR see everyone (travel.view_all); other employees see their own travel only
function scope(req) {
  const v = can(req.user, 'travel.view_all');
  if (v === true) return { sectionId: Number(req.query.section) || null, employeeId: Number(req.query.employee) || null, all: true };
  if (Array.isArray(v)) {
    const s = Number(req.query.section);
    return { sectionId: v.includes(s) ? s : v[0], employeeId: null, all: false, sections: v };
  }
  return { sectionId: null, employeeId: req.user.id, all: false };
}

router.get('/travel', (req, res) => {
  const year = Number(req.query.year) || Number(todayRiyadh().slice(0, 4));
  const sc = scope(req);
  const band = TV.BANDS[req.query.band] ? req.query.band : null;
  const rep = TV.report(year, sc);
  let rows = rep.rows;
  if (band) rows = rows.filter((r) => (band === 'over_100' ? r.b : r.c) > 0);
  res.render('travel', {
    year, band, rows, limit: rep.limit, sc,
    summary: TV.summary(year, sc.employeeId ? {} : sc),
    trips: TV.trips(year, { ...sc, band }),
    sections: sc.sections ? sections().filter((s) => sc.sections.includes(s.id)) : sections(),
    counts: { over: rep.rows.filter((r) => r.state === 'over').length, limit: rep.rows.filter((r) => r.state === 'limit').length, near: rep.rows.filter((r) => r.state === 'near').length },
  });
});

router.get('/travel/export', async (req, res, next) => {
  try {
    if (can(req.user, 'travel.view_all') !== true) throw new HttpError(403, res.locals.t('forbidden'));
    const year = Number(req.query.year) || Number(todayRiyadh().slice(0, 4));
    const rep = TV.report(year);
    const emp = rep.rows.map((r) => ({ employee_no: r.employee_no, name: r.name_ar, section: r.section_code, over_100km: r.b, over_200km: r.c, limit: rep.limit, total_km: r.km, overnight: r.overnight, travel_hours: r.hours, status: r.state }));
    const tr = TV.trips(year).map((w) => ({ wo_number: w.wo_number, title: w.title, section: w.section_code, band: w.distance_category === 'C' ? 'over_200' : 'over_100', distance_km: w.distance_km, planned_start: w.planned_start, team_size: w.team_size, overnight: w.overnight ? 'yes' : 'no', sector_approval: w.needs_sector_approval ? 'yes' : 'no', status: w.status }));
    const wb = await exportWorkbook([['employees', emp], ['travel_work_orders', tr]]);
    res.attachment(`travel_assignments_${year}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

module.exports = router;

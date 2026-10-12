'use strict';
// Travel assignments: work orders that involve travel are banded as "over 100 km" (100-200 km)
// or "over 200 km". Each employee may have up to `distance_threshold` (default 20) assignments
// per band per year; reaching and exceeding the limit raises alerts.
const { all, get, setting } = require('./db');
const { HttpError, todayRiyadh, nowIso } = require('./util');
const { notify, once } = require('./notify');
const { officialsAt } = require('./org');

const BANDS = { over_100: 'B', over_200: 'C' };
const BAND_OF = { B: 'over_100', C: 'over_200' };
const threshold = () => Number(setting('distance_threshold'));

/**
 * Normalize the travel answer of a work order.
 * involves_travel = 'yes' requires a band and a distance that matches it:
 *   over_100 -> 100..200 km, over_200 -> more than 200 km. 'no' requires less than 100 km.
 * When the question was not asked (older imports/API), it is derived from the distance.
 */
function normalize({ involves_travel, travel_band, distance_km }) {
  const km = Number(distance_km) || 0;
  let involves = involves_travel;
  if (!['yes', 'no'].includes(involves)) involves = km >= 100 ? 'yes' : 'no';
  if (involves === 'no') {
    if (km >= 100) throw new HttpError(400, 'Distance is 100 km or more: answer "Yes" to the travel question / المسافة 100 كم أو أكثر: أجب بنعم على سؤال السفر');
    return { involves_travel: 'no', distance_km: km, category: 'A' };
  }
  let band = travel_band;
  if (!BANDS[band]) band = km > 200 ? 'over_200' : km >= 100 ? 'over_100' : null;
  if (!band) throw new HttpError(400, 'Travel jobs must be over 100 km or over 200 km / مهام السفر يجب أن تكون أكثر من 100 كم أو أكثر من 200 كم');
  if (!km) throw new HttpError(400, 'Enter the round-trip distance in km / أدخل المسافة ذهابًا وعودة');
  if (band === 'over_100' && (km < 100 || km > 200)) throw new HttpError(400, '"Over 100 km" means 100 to 200 km; check the distance or choose "Over 200 km" / فئة "أكثر من 100 كم" تعني 100-200 كم');
  if (band === 'over_200' && km <= 200) throw new HttpError(400, '"Over 200 km" requires a distance above 200 km / فئة "أكثر من 200 كم" تتطلب مسافة أكبر من 200 كم');
  return { involves_travel: 'yes', distance_km: km, category: BANDS[band], band };
}

/** Per-employee travel counts for a year (non-cancelled work orders). */
function report(year, { sectionId, employeeId } = {}) {
  const y = String(year);
  const limit = threshold();
  const cond = ["e.status = 'active'"], p = [];
  if (sectionId) { cond.push('e.section_id = ?'); p.push(sectionId); }
  if (employeeId) { cond.push('e.id = ?'); p.push(employeeId); }
  const rows = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.job_title_en, s.code section_code,
      SUM(CASE WHEN w.distance_category = 'B' THEN 1 ELSE 0 END) b,
      SUM(CASE WHEN w.distance_category = 'C' THEN 1 ELSE 0 END) c,
      ROUND(SUM(w.distance_km)) km, SUM(w.overnight) overnight, ROUND(SUM(COALESCE(w.travel_hours,0)), 1) hours,
      MAX(w.planned_start) last_trip
    FROM employees e LEFT JOIN org_units s ON s.id = e.section_id
    JOIN wo_participants p ON p.employee_id = e.id
    JOIN work_orders w ON w.id = p.wo_id AND w.status <> 'cancelled' AND w.distance_category IN ('B','C') AND substr(w.planned_start,1,4) = ?
    WHERE ${cond.join(' AND ')} GROUP BY e.id ORDER BY MAX(b, c) DESC, (b + c) DESC, e.employee_no`, y, ...p);
  for (const r of rows) {
    const top = Math.max(r.b, r.c);
    r.state = top > limit ? 'over' : top === limit ? 'limit' : top >= limit * 0.8 ? 'near' : 'ok';
  }
  return { rows, limit };
}

function summary(year, { sectionId } = {}) {
  const y = String(year);
  const sc = sectionId ? ' AND w.section_id = ' + Number(sectionId) : '';
  return get(`SELECT
      SUM(CASE WHEN w.distance_category = 'B' THEN 1 ELSE 0 END) b,
      SUM(CASE WHEN w.distance_category = 'C' THEN 1 ELSE 0 END) c,
      ROUND(SUM(w.distance_km)) km, SUM(w.overnight) overnight, ROUND(SUM(COALESCE(w.travel_hours,0)),1) hours,
      SUM(w.needs_sector_approval) sector
    FROM work_orders w WHERE w.status <> 'cancelled' AND w.distance_category IN ('B','C') AND substr(w.planned_start,1,4) = ?${sc}`, y);
}

function trips(year, { sectionId, employeeId, band } = {}) {
  const cond = ["w.status <> 'cancelled'", "w.distance_category IN ('B','C')", 'substr(w.planned_start,1,4) = ?'], p = [String(year)];
  if (sectionId) { cond.push('w.section_id = ?'); p.push(sectionId); }
  if (employeeId) { cond.push('w.id IN (SELECT wo_id FROM wo_participants WHERE employee_id = ?)'); p.push(employeeId); }
  if (BANDS[band]) { cond.push('w.distance_category = ?'); p.push(BANDS[band]); }
  return all(`SELECT w.*, s.code section_code, (SELECT COUNT(*) FROM wo_participants x WHERE x.wo_id = w.id) team_size
    FROM work_orders w LEFT JOIN org_units s ON s.id = w.section_id WHERE ${cond.join(' AND ')} ORDER BY w.planned_start DESC LIMIT 300`, ...p);
}

/**
 * Alert employees (and their managers) who reach or exceed the yearly limit in a band.
 * Deduplicated: one "reached" alert and one alert per additional assignment beyond the limit.
 */
function checkAlerts(year = Number(todayRiyadh().slice(0, 4)), employeeIds = null) {
  const limit = threshold();
  let n = 0;
  for (const r of report(year).rows) {
    if (employeeIds && !employeeIds.includes(r.id)) continue;
    for (const [cat, count] of [['B', r.b], ['C', r.c]]) {
      if (count < limit) continue;
      const band = BAND_OF[cat];
      const label = cat === 'B' ? ['أكثر من 100 كم', 'over 100 km'] : ['أكثر من 200 كم', 'over 200 km'];
      const e = get('SELECT section_id FROM employees WHERE id = ?', r.id);
      const o = e?.section_id ? officialsAt(e.section_id, nowIso()) : {};
      const managers = [o.section_head?.employee_id, o.division_manager?.employee_id, o.department_manager?.employee_id];
      const key = count === limit ? `travel-${r.id}-${year}-${cat}-limit` : `travel-${r.id}-${year}-${cat}-over-${count}`;
      once(key, () => {
        n++;
        notify([r.id, ...managers], {
          type: count > limit ? 'travel_over_limit' : 'travel_limit', severity: count > limit ? 'critical' : 'warning',
          title: count > limit
            ? `${r.employee_no} تجاوز ${limit} مهمة سفر ${label[0]} (${count}) / exceeded ${limit} travel assignments ${label[1]} (${count})`
            : `${r.employee_no} بلغ الحد ${limit} مهمة سفر ${label[0]} / reached the limit of ${limit} travel assignments ${label[1]}`,
          body: count > limit
            ? `${r.name_ar}\nكل مهمة إضافية تتطلب مراجعة مدير الإدارة واعتماد رئيس القطاع.\nEvery additional assignment needs Department Manager review and Sector Head approval.`
            : `${r.name_ar}\nالمهمة التالية في هذه الفئة تتطلب اعتماد رئيس القطاع.\nThe next assignment in this band needs Sector Head approval.`,
          link: `/travel?year=${year}&band=${band}#employees`,
        });
      });
    }
  }
  return n;
}

module.exports = { normalize, report, summary, trips, checkAlerts, BANDS, BAND_OF, threshold };

'use strict';
const express = require('express');
const { all, get, run, setting } = require('../db');
const { audit, HttpError, todayRiyadh } = require('../util');
const { requireRole } = require('../perm');
const { ASSET_TYPES, EQUIP_TYPES, EQUIP_STATUS, VEHICLE_TYPES } = require('../entities');
const { sections } = require('../org');
const { can } = require('../access');

const router = express.Router();

router.get('/assets', (req, res) => {
  const cond = [], p = [];
  if (req.query.type) { cond.push('a.type = ?'); p.push(req.query.type); }
  if (req.query.voltage) { cond.push('a.voltage_kv = ?'); p.push(Number(req.query.voltage)); }
  if (req.query.q) { cond.push('(skey(a.code) LIKE skey(?) OR skey(a.name_ar) LIKE skey(?) OR skey(a.name_en) LIKE skey(?) OR skey(a.line_code) LIKE skey(?))'); p.push(...Array(4).fill(`%${req.query.q}%`)); }
  const rows = all(`SELECT a.*, (SELECT COUNT(*) FROM work_orders w WHERE w.asset_id = a.id AND w.status <> 'cancelled') wo_count,
      (SELECT COUNT(*) FROM work_orders w WHERE w.asset_id = a.id AND w.status IN ('open','in_progress','pending_closure')) wo_open
    FROM assets a ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.code LIMIT 1000`, ...p);
  res.render('assets', { rows, ASSET_TYPES, canEdit: req.user.role === 'admin' });
});

router.post('/assets', requireRole('admin'), (req, res) => {
  const b = req.body;
  if (!b.code || !ASSET_TYPES.includes(b.type)) throw new HttpError(400, 'Code and type are required');
  if (get('SELECT 1 FROM assets WHERE code = ?', b.code.trim())) throw new HttpError(400, 'Code already exists / الرمز موجود');
  run('INSERT INTO assets(code, type, name_ar, name_en, voltage_kv, line_code, region, lat, lng) VALUES (?,?,?,?,?,?,?,?,?)',
    b.code.trim(), b.type, b.name_ar || null, b.name_en || null, Number(b.voltage_kv) || null, b.line_code || null, b.region || null, Number(b.lat) || null, Number(b.lng) || null);
  audit(req, 'create', 'asset', b.code, null, b);
  res.redirect('/assets');
});

// ---------- vehicle fleet ----------
const FLEET_EDIT = (req) => can(req.user, 'fleet.manage') === true;

router.post('/assets/:id(\\d+)', requireRole('admin'), (req, res) => {
  const a = get('SELECT * FROM assets WHERE id = ?', Number(req.params.id));
  if (!a) throw new HttpError(404, 'Not found');
  const b = req.body;
  const code = (b.code || '').trim();
  if (!code || !ASSET_TYPES.includes(b.type)) throw new HttpError(400, 'Code and type are required');
  if (get('SELECT 1 FROM assets WHERE code = ? AND id <> ?', code, a.id)) throw new HttpError(400, 'Code already exists / الرمز موجود');
  const after = { code, type: b.type, name_ar: b.name_ar || null, name_en: b.name_en || null, voltage_kv: Number(b.voltage_kv) || null, line_code: b.line_code || null,
    region: b.region || null, lat: Number(b.lat) || null, lng: Number(b.lng) || null, status: ['in_service', 'out_of_service', 'retired'].includes(b.status) ? b.status : a.status };
  run('UPDATE assets SET code=?, type=?, name_ar=?, name_en=?, voltage_kv=?, line_code=?, region=?, lat=?, lng=?, status=? WHERE id=?', ...Object.values(after), a.id);
  audit(req, 'update', 'asset', a.code, a, after);
  res.flash('success', res.locals.t('saved'));
  res.redirect('/assets');
});

router.get('/fleet', (req, res) => {
  const today = todayRiyadh();
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const cond = ["q.type = 'vehicle'"], p = [];
  if (req.query.section) { cond.push('q.section_id = ?'); p.push(Number(req.query.section)); }
  if (req.query.vtype) { cond.push('q.vehicle_type = ?'); p.push(req.query.vtype); }
  if (req.query.status) { cond.push('q.status = ?'); p.push(req.query.status); }
  if (req.query.q) { cond.push('(skey(q.code) LIKE skey(?) OR skey(q.plate_number) LIKE skey(?) OR skey(q.make_model) LIKE skey(?) OR skey(q.name) LIKE skey(?))'); p.push(...Array(4).fill(`%${req.query.q}%`)); }
  const SORT = { code: 'q.code', plate: 'q.plate_number', type: 'q.vehicle_type', seats: 'q.seats', expiry: 'q.expiry_date', section: 's.code', year: 'q.model_year' };
  const rows = all(`SELECT q.*, s.code section_code FROM equipment q LEFT JOIN org_units s ON s.id = q.section_id WHERE ${cond.join(' AND ')}
    ORDER BY ${SORT[req.query.sort] || 'q.code'} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'}, q.code`, ...p);
  for (const q of rows) {
    q.flag = q.expiry_date && q.expiry_date < today ? 'expired' : q.expiry_date && q.expiry_date <= horizon ? 'soon' : null;
    q.current = get(`SELECT w.id, w.wo_number, w.title, w.planned_end FROM wo_equipment x JOIN work_orders w ON w.id = x.wo_id
      WHERE x.equipment_id = ? AND w.status IN ('open','in_progress','awaiting_authorization') AND w.planned_start <= ? AND w.planned_end >= ? LIMIT 1`, q.id, now, now);
    q.next = all(`SELECT w.id, w.wo_number, w.planned_start, w.planned_end FROM wo_equipment x JOIN work_orders w ON w.id = x.wo_id
      WHERE x.equipment_id = ? AND w.status IN ('open','awaiting_authorization') AND w.planned_start > ? ORDER BY w.planned_start LIMIT 3`, q.id, now);
    q.trips = get(`SELECT COUNT(*) n FROM wo_equipment x JOIN work_orders w ON w.id = x.wo_id WHERE x.equipment_id = ? AND w.status = 'closed'`, q.id).n;
  }
  const docFlags = require('../documents').expirySummary('vehicle');
  // From the dashboard: vehicles whose registration or papers expire soon
  if (req.query.docs === 'expiring') rows.splice(0, rows.length, ...rows.filter((q) => q.flag || docFlags[q.id]));
  const stats = {
    total: rows.length,
    available: rows.filter((q) => q.status === 'available' && !q.current && q.flag !== 'expired').length,
    in_use: rows.filter((q) => q.current).length,
    maintenance: rows.filter((q) => q.status !== 'available').length,
    expired: rows.filter((q) => q.flag === 'expired').length,
    seats: rows.filter((q) => q.status === 'available' && q.flag !== 'expired').reduce((a, q) => a + (q.seats || 0), 0),
  };
  res.render('fleet', { rows, stats, VEHICLE_TYPES, EQUIP_STATUS, sections: sections(), canEdit: FLEET_EDIT(req), docFlags });
});

router.get('/fleet/:id(\\d+)', (req, res) => {
  const Docs = require('../documents');
  const q = get("SELECT q.*, s.code section_code FROM equipment q LEFT JOIN org_units s ON s.id = q.section_id WHERE q.id = ? AND q.type = 'vehicle'", Number(req.params.id));
  if (!q) throw new HttpError(404, res.locals.t('not_found'));
  const today = todayRiyadh();
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);
  q.flag = q.expiry_date && q.expiry_date < today ? 'expired' : q.expiry_date && q.expiry_date <= horizon ? 'soon' : null;
  const trips = all(`SELECT w.id, w.wo_number, w.title, w.status, w.planned_start, w.planned_end, w.distance_km, e.name_ar, e.name_en FROM wo_equipment x JOIN work_orders w ON w.id = x.wo_id
    LEFT JOIN employees e ON e.id = w.team_leader_id WHERE x.equipment_id = ? ORDER BY w.planned_start DESC LIMIT 100`, q.id);
  res.render('vehicle', {
    q, trips, VEHICLE_TYPES, EQUIP_STATUS, sections: sections(), canEdit: FLEET_EDIT(req),
    documents: Docs.list('vehicle', q.id), docRights: Docs.rights('vehicle', q, req.user), DOC_TYPES: Docs.TYPES.vehicle,
    km: trips.filter((t) => t.status === 'closed').reduce((a, t) => a + (t.distance_km || 0), 0),
  });
});

function vehicleFromBody(b, old = {}) {
  const v = {
    name: (b.name || old.name || '').trim(), plate_number: (b.plate_number || '').trim().toUpperCase(), vehicle_type: VEHICLE_TYPES.includes(b.vehicle_type) ? b.vehicle_type : 'other',
    make_model: b.make_model || null, model_year: Number(b.model_year) || null, seats: Number(b.seats) || null, section_id: Number(b.section_id) || null,
    status: EQUIP_STATUS.includes(b.status) ? b.status : 'available', location: b.location || null, expiry_date: b.expiry_date || null,
  };
  if (!v.plate_number) throw new HttpError(400, 'Plate number is required / رقم اللوحة مطلوب');
  if (!v.seats || v.seats < 1) throw new HttpError(400, 'Number of seats is required / عدد المقاعد مطلوب');
  if (!v.name) v.name = `${v.vehicle_type} ${v.plate_number}`;
  return v;
}

router.post('/fleet', (req, res) => {
  if (!FLEET_EDIT(req)) throw new HttpError(403, res.locals.t('forbidden'));
  const code = (req.body.code || '').trim();
  if (!code) throw new HttpError(400, 'Fleet number is required / رقم المركبة مطلوب');
  if (get('SELECT 1 FROM equipment WHERE code = ?', code)) throw new HttpError(400, 'Code already exists / الرمز موجود');
  const v = vehicleFromBody(req.body);
  if (get("SELECT 1 FROM equipment WHERE type = 'vehicle' AND plate_number = ?", v.plate_number)) throw new HttpError(400, 'Plate number already registered / رقم اللوحة مسجل');
  run(`INSERT INTO equipment(code, type, name, plate_number, vehicle_type, make_model, model_year, seats, section_id, status, location, expiry_date)
    VALUES (?, 'vehicle', ?,?,?,?,?,?,?,?,?,?)`, code, ...Object.values(v));
  audit(req, 'create', 'vehicle', code, null, v);
  res.flash('success', res.locals.t('saved'));
  res.redirect('/fleet');
});

router.post('/fleet/:id', (req, res) => {
  if (!FLEET_EDIT(req)) throw new HttpError(403, res.locals.t('forbidden'));
  const q = get("SELECT * FROM equipment WHERE id = ? AND type = 'vehicle'", Number(req.params.id));
  if (!q) throw new HttpError(404, 'Not found');
  const v = vehicleFromBody(req.body, q);
  run(`UPDATE equipment SET name=?, plate_number=?, vehicle_type=?, make_model=?, model_year=?, seats=?, section_id=?, status=?, location=?, expiry_date=? WHERE id=?`, ...Object.values(v), q.id);
  audit(req, 'update', 'vehicle', q.code, q, v);
  res.flash('success', res.locals.t('saved'));
  res.redirect(req.body.back === 'detail' ? `/fleet/${q.id}` : '/fleet');
});

router.get('/equipment', (req, res) => {
  const today = todayRiyadh();
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);
  const rows = all(`SELECT q.*, (SELECT w.wo_number FROM wo_equipment x JOIN work_orders w ON w.id = x.wo_id WHERE x.equipment_id = q.id AND w.status IN ('open','in_progress') LIMIT 1) booked_on
    FROM equipment q WHERE q.type <> 'vehicle' ORDER BY q.code`);
  rows.forEach((q) => {
    const dates = [q.expiry_date, q.calibration_due].filter(Boolean);
    q.flag = dates.some((d) => d < today) ? 'expired' : dates.some((d) => d <= horizon) ? 'soon' : null;
  });
  res.render('equipment', { rows, EQUIP_TYPES: EQUIP_TYPES.filter((x) => x !== 'vehicle'), EQUIP_STATUS, sections: sections(), canEdit: ['admin', 'safety'].includes(req.user.role) });
});

router.post('/equipment', requireRole('admin', 'safety'), (req, res) => {
  const b = req.body;
  if (!b.code || !b.name || !EQUIP_TYPES.includes(b.type)) throw new HttpError(400, 'Code, name and type are required');
  if (get('SELECT 1 FROM equipment WHERE code = ?', b.code.trim())) throw new HttpError(400, 'Code already exists / الرمز موجود');
  run('INSERT INTO equipment(code, type, name, status, location, expiry_date, calibration_due) VALUES (?,?,?,?,?,?,?)',
    b.code.trim(), b.type, b.name, EQUIP_STATUS.includes(b.status) ? b.status : 'available', b.location || null, b.expiry_date || null, b.calibration_due || null);
  audit(req, 'create', 'equipment', b.code, null, b);
  res.redirect('/equipment');
});

router.post('/equipment/:id', requireRole('admin', 'safety'), (req, res) => {
  const q = get('SELECT * FROM equipment WHERE id = ?', Number(req.params.id));
  if (!q) throw new HttpError(404, 'Not found');
  const b = req.body;
  const after = {
    name: (b.name || q.name).trim(), type: EQUIP_TYPES.includes(b.type) && b.type !== 'vehicle' ? b.type : q.type,
    status: EQUIP_STATUS.includes(b.status) ? b.status : q.status, expiry_date: b.expiry_date || null, calibration_due: b.calibration_due || null, location: b.location || null,
    section_id: b.section_id === undefined ? q.section_id : Number(b.section_id) || null,
  };
  if (!after.name) throw new HttpError(400, 'Name is required / الاسم مطلوب');
  run('UPDATE equipment SET name=?, type=?, status=?, expiry_date=?, calibration_due=?, location=?, section_id=? WHERE id=?', ...Object.values(after), q.id);
  audit(req, 'update', 'equipment', q.code, q, after);
  res.flash('success', res.locals.t('saved'));
  res.redirect('/equipment');
});

module.exports = router;

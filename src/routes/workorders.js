'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { all, get, run, tx } = require('../db');
const { localToUtc, utcToLocalInput, audit, HttpError, nowIso } = require('../util');
const W = require('../workorders');
const { woFilterSql, WO_TYPES, PRIORITIES, RESULTS, MAT_SOURCES } = require('../entities');
const { sections } = require('../org');
const { requireRole, canViewWO, canWorkOnWO, canManageWO, WO_CREATORS } = require('../perm');
const { notify, idsByRole } = require('../notify');
const WC = require('../wo_changes');
const Items = require('../items');

const router = express.Router();
const UPLOAD_DIR = process.env.UPLOAD_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '..', '..', 'uploads'));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, new Date().toISOString().slice(0, 7));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg')),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.mimetype)),
});

function loadWO(req) {
  const wo = get('SELECT * FROM work_orders WHERE id = ?', Number(req.params.id));
  if (!wo) throw new HttpError(404, 'Work order not found');
  if (!canViewWO(wo, req.user)) throw new HttpError(403, 'Forbidden');
  return wo;
}
const ensure = (ok) => { if (!ok) throw new HttpError(403, 'You do not have permission for this action / ليست لديك صلاحية'); };
const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

const WO_SORTS = {
  number: 'w.wo_number', title: 'w.title', priority: "CASE w.priority WHEN 'C1' THEN 1 WHEN 'C2' THEN 2 WHEN 'C3' THEN 3 WHEN 'C4' THEN 4 ELSE 5 END",
  section: 's.code', leader: 'e.name_ar', start: 'w.planned_start', end: 'w.planned_end', status: 'w.status', created: 'w.created_at',
};
const woSort = (q) => `${WO_SORTS[q.sort] || 'w.id'} ${q.dir === 'asc' ? 'ASC' : WO_SORTS[q.sort] ? (q.dir === 'desc' ? 'DESC' : 'ASC') : 'DESC'}, w.id DESC`;

router.get('/wo', (req, res) => {
  const { where, params } = woFilterSql(req.query, req.user);
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = get(`SELECT COUNT(*) n FROM work_orders w ${where}`, ...params).n;
  const rows = all(`SELECT w.*, s.code section_code, e.name_ar leader_ar, e.name_en leader_en,
      (SELECT COUNT(*) FROM wo_photos p WHERE p.wo_id = w.id AND p.stage='before') before_n,
      (SELECT COUNT(*) FROM wo_photos p WHERE p.wo_id = w.id AND p.stage='after') after_n
    FROM work_orders w LEFT JOIN org_units s ON s.id = w.section_id LEFT JOIN employees e ON e.id = w.team_leader_id
    ${where} ORDER BY ${woSort(req.query)} LIMIT 50 OFFSET ?`, ...params, (page - 1) * 50);
  res.render('wo_list', { rows, total, page, sections: sections(), WO_TYPES, PRIORITIES, qs: new URLSearchParams(Object.entries(req.query).filter(([k, v]) => v && k !== 'page')).toString() });
});

function formLists(excludeWoId = 0) {
  return {
    sections: sections(),
    employees: all("SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.job_title_en, s.code section_code FROM employees e LEFT JOIN org_units s ON s.id = e.section_id WHERE e.status = 'active' ORDER BY e.employee_no"),
    assets: all('SELECT id, code, name_ar, name_en, voltage_kv FROM assets ORDER BY code'),
    equipment: all('SELECT * FROM equipment ORDER BY code'),
    items: Items.pickerOptions(excludeWoId),
    WO_TYPES, PRIORITIES,
  };
}

router.get('/wo/new', requireRole(...WO_CREATORS), (req, res) => {
  res.render('wo_new', { ...formLists(), form: {} });
});

function woDataFromBody(b) {
  return {
    type: b.type, title: (b.title || '').trim(), description: b.description, priority: b.priority,
    asset_id: b.asset_id ? Number(b.asset_id) : null, voltage_kv: b.voltage_kv ? Number(b.voltage_kv) : null,
    location: b.location, section_id: Number(b.section_id) || null, distance_km: b.involves_travel === 'no' ? 0 : Number(b.distance_km) || 0,
    involves_travel: b.involves_travel, travel_band: b.involves_travel === 'yes' ? b.travel_band : null,
    planned_start: localToUtc(b.planned_start), planned_end: localToUtc(b.planned_end),
    team_leader_id: Number(b.team_leader_id) || null, participant_ids: toArr(b.participant_ids).map(Number), equipment_ids: toArr(b.equipment_ids).map(Number),
    overnight: b.overnight === '1', travel_hours: b.travel_hours ? Number(b.travel_hours) : null, selection_reason: b.selection_reason,
    materials_withdrawn: b.materials_withdrawn, reservation_number: (b.reservation_number || '').trim() || null, warehouse: b.warehouse,
    items: Items.parseLines(b),
  };
}

router.post('/wo', requireRole(...WO_CREATORS), (req, res, next) => {
  const b = req.body;
  const data = woDataFromBody(b);
  try {
    const { wo, warnings } = W.createWorkOrder(data, req);
    res.flash(warnings.length ? 'warning' : 'success', `${wo.wo_number} ✓` + (warnings.length ? '\n' + warnings.join('\n') : ''));
    res.redirect(`/wo/${wo.id}`);
  } catch (e) {
    if (e.status !== 400) return next(e);
    res.status(400).render('wo_new', { ...formLists(), form: b, error: e.message });
  }
});

// ----- edit -----
function editForm(wo) {
  const asset = wo.asset_id ? get('SELECT code FROM assets WHERE id = ?', wo.asset_id) : null;
  return {
    ...wo, asset_code: asset?.code || '', planned_start: utcToLocalInput(wo.planned_start), planned_end: utcToLocalInput(wo.planned_end),
    travel_band: wo.distance_category === 'C' ? 'over_200' : wo.distance_category === 'B' ? 'over_100' : '',
    participant_ids: all('SELECT employee_id FROM wo_participants WHERE wo_id = ?', wo.id).map((r) => r.employee_id),
    equipment_ids: all('SELECT equipment_id FROM wo_equipment WHERE wo_id = ?', wo.id).map((r) => r.equipment_id),
  };
}
const canEditWO = (wo, user) => canManageWO(wo, user) && ['awaiting_authorization', 'open', 'in_progress'].includes(wo.status);

router.get('/wo/:id(\\d+)/edit', (req, res) => {
  const wo = loadWO(req);
  ensure(canEditWO(wo, req.user));
  res.render('wo_new', { ...formLists(wo.id), form: editForm(wo), editing: wo });
});

router.post('/wo/:id(\\d+)/edit', (req, res, next) => {
  const wo = loadWO(req);
  ensure(canEditWO(wo, req.user));
  try {
    const { warnings } = W.updateWorkOrder(wo, woDataFromBody(req.body), (req.body.edit_reason || '').trim(), req);
    res.flash(warnings.length ? 'warning' : 'success', res.locals.t('saved') + (warnings.length ? '\n' + warnings.join('\n') : ''));
    res.redirect(`/wo/${wo.id}`);
  } catch (e) {
    if (e.status !== 400) return next(e);
    res.status(400).render('wo_new', { ...formLists(wo.id), form: { ...req.body, id: wo.id }, editing: wo, error: e.message });
  }
});

router.get('/wo/:id', (req, res) => {
  const wo = loadWO(req);
  const participants = all(`SELECT e.*, p.role p_role, s.code section_code FROM wo_participants p JOIN employees e ON e.id = p.employee_id
    LEFT JOIN org_units s ON s.id = e.section_id WHERE p.wo_id = ? ORDER BY p.role DESC, e.employee_no`, wo.id);
  const photos = all('SELECT p.*, e.name_ar, e.name_en FROM wo_photos p LEFT JOIN employees e ON e.id = p.uploaded_by WHERE p.wo_id = ? ORDER BY p.id', wo.id);
  const approvals = all(`SELECT a.*, e.name_ar, e.name_en, e.employee_no, x.name_ar exp_ar, x.name_en exp_en FROM wo_approvals a
    LEFT JOIN employees e ON e.id = a.decided_by LEFT JOIN employees x ON x.id = a.expected_employee_id WHERE a.wo_id = ? ORDER BY a.id`, wo.id);
  const pending = W.pendingApproval(wo.id);
  const rec = W.reconciliation(wo.id);
  const history = all(`SELECT a.*, e.employee_no, e.name_ar, e.name_en FROM audit_log a LEFT JOIN employees e ON e.id = a.employee_id
    WHERE a.entity IN ('work_order','wo_photo','material_line','material_reservation') AND (a.entity_id = ? OR a.entity_id LIKE ?) ORDER BY a.id DESC LIMIT 100`, wo.wo_number, wo.wo_number + ':%');
  res.render('wo_detail', {
    wo, participants, photos, approvals, pending, rec,
    lineErrors: W.lineErrors, lineVariance: W.lineVariance,
    reservations: all('SELECT r.*, e.name_ar recv_ar FROM material_reservations r LEFT JOIN employees e ON e.id = r.received_by WHERE r.wo_id = ? ORDER BY r.id', wo.id),
    equipment: all('SELECT q.* FROM wo_equipment x JOIN equipment q ON q.id = x.equipment_id WHERE x.wo_id = ?', wo.id),
    asset: wo.asset_id ? get('SELECT * FROM assets WHERE id = ?', wo.asset_id) : null,
    section: get('SELECT * FROM org_units WHERE id = ?', wo.section_id),
    leader: get('SELECT * FROM employees WHERE id = ?', wo.team_leader_id),
    officials: JSON.parse(wo.officials_json || '{}'),
    checklist: W.closureChecklist(wo), history, RESULTS, MAT_SOURCES, away: W.teamAway(wo),
    crew: W.crewSummary(wo.id), extensions: WC.extensionsOf(wo.id), handovers: WC.handoversOf(wo.id), isManager: WC.isManagerOf(wo, req.user),
    canHistory: require('../access').can(req.user, 'wo.view_history', wo.section_id) === true,
    handoverCandidates: all("SELECT e.id, e.employee_no, e.name_ar, e.name_en, s.code section_code FROM employees e LEFT JOIN org_units s ON s.id = e.section_id WHERE e.status = 'active' AND e.role IN ('employee','team_leader','section_head') ORDER BY (e.section_id = ?) DESC, e.employee_no", wo.section_id),
    vehicles: all("SELECT q.* FROM wo_equipment x JOIN equipment q ON q.id = x.equipment_id WHERE x.wo_id = ? AND q.type = 'vehicle'", wo.id),
    woItems: Items.ofWo(wo.id), itemOptions: Items.pickerOptions(wo.id),
    tasks: all('SELECT * FROM tasks WHERE wo_id = ? ORDER BY task_date, start_time', wo.id),
    can: {
      work: canWorkOnWO(wo, req.user) && wo.status === 'in_progress',
      manage: canManageWO(wo, req.user),
      decide: pending ? W.canDecide(wo, pending, req.user).ok : false,
      warehouse: ['warehouse', 'admin'].includes(req.user.role),
      materials: (canWorkOnWO(wo, req.user) || ['warehouse'].includes(req.user.role)) && ['open', 'in_progress'].includes(wo.status),
      items: (canManageWO(wo, req.user) || canWorkOnWO(wo, req.user) || Items.canManage(req.user)) && ['awaiting_authorization', 'open', 'in_progress'].includes(wo.status),
      edit: canManageWO(wo, req.user) && ['awaiting_authorization', 'open', 'in_progress'].includes(wo.status),
    },
    isCritical: W.isCritical(wo),
  });
});

router.post('/wo/:id/extensions', (req, res) => {
  const wo = loadWO(req);
  const r = WC.requestExtension(wo, { newStart: localToUtc(req.body.new_start), newEnd: localToUtc(req.body.new_end), reason: (req.body.reason || '').trim() }, req);
  res.flash('success', r.autoApproved ? res.locals.t('ext_applied') : res.locals.t('ext_requested'));
  res.redirect(`/wo/${wo.id}#schedule`);
});
router.post('/wo/:id/extensions/:xid/decide', (req, res) => {
  const wo = loadWO(req);
  WC.decideExtension(wo, Number(req.params.xid), req.body.decision !== 'rejected', (req.body.comment || '').trim(), req);
  res.redirect(`/wo/${wo.id}#schedule`);
});
router.post('/wo/:id/extensions/:xid/cancel', (req, res) => {
  const wo = loadWO(req);
  WC.cancelExtension(wo, Number(req.params.xid), req);
  res.redirect(`/wo/${wo.id}#schedule`);
});
router.post('/wo/:id/handovers', (req, res) => {
  const wo = loadWO(req);
  WC.scheduleHandover(wo, { toEmployeeId: req.body.to_employee_id, scheduledAt: localToUtc(req.body.scheduled_at), reason: (req.body.reason || '').trim(), workStatus: req.body.work_status, removeOutgoing: req.body.remove_outgoing === '1' }, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/wo/${wo.id}#schedule`);
});
router.post('/wo/:id/handovers/:hid/cancel', (req, res) => {
  const wo = loadWO(req);
  WC.cancelHandover(wo, Number(req.params.hid), req);
  res.redirect(`/wo/${wo.id}#schedule`);
});

router.post('/wo/:id/start', (req, res) => {
  const wo = loadWO(req);
  ensure(canWorkOnWO(wo, req.user));
  W.startWork(wo, req);
  res.flash('success', 'Started / بدأ التنفيذ');
  res.redirect(`/wo/${wo.id}`);
});

// Execution details recorded by the team while work is in progress
router.post('/wo/:id/execution', (req, res) => {
  const wo = loadWO(req);
  ensure(canWorkOnWO(wo, req.user));
  if (wo.status !== 'in_progress') throw new HttpError(400, 'Work order is not in progress / ليس قيد التنفيذ');
  const b = req.body;
  if (b.materials_used === 'no') {
    const used = get('SELECT COUNT(*) n FROM material_lines WHERE wo_id = ? AND used_qty > 0', wo.id).n;
    if (used) throw new HttpError(400, 'Material lines already record used quantities / توجد مواد مستخدمة مسجلة');
  }
  const after = {
    result: RESULTS.includes(b.result) ? b.result : null,
    action_description: b.action_description || null,
    completion_pct: b.completion_pct === '' || b.completion_pct == null ? null : Math.max(0, Math.min(100, Number(b.completion_pct))),
    non_completion_reason: b.non_completion_reason || null,
    arrival_at: localToUtc(b.arrival_at), restored_at: localToUtc(b.restored_at),
    materials_used: ['yes', 'no'].includes(b.materials_used) ? b.materials_used : null,
    alt_material_source: b.alt_material_source || null,
    travel_hours: b.travel_hours === '' || b.travel_hours == null ? wo.travel_hours : Number(b.travel_hours),
    overnight: b.overnight === '1' ? 1 : 0,
  };
  const before = Object.fromEntries(Object.keys(after).map((k) => [k, wo[k]]));
  run(`UPDATE work_orders SET result=?, action_description=?, completion_pct=?, non_completion_reason=?, arrival_at=?, restored_at=?, materials_used=?,
    alt_material_source=?, travel_hours=?, overnight=? WHERE id=?`, ...Object.values(after), wo.id);
  audit(req, 'update_execution', 'work_order', wo.wo_number, before, after);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/wo/${wo.id}#execution`);
});

router.post('/wo/:id/photos', upload.array('photos', 20), (req, res) => {
  const wo = loadWO(req);
  const cleanup = () => (req.files || []).forEach((f) => fs.rm(f.path, () => {}));
  if (!canWorkOnWO(wo, req.user)) { cleanup(); throw new HttpError(403, 'Forbidden'); }
  if (!['open', 'in_progress'].includes(wo.status)) { cleanup(); throw new HttpError(400, 'Photos are locked for this status / الصور مقفلة'); }
  const stage = req.body.stage;
  if (!['before', 'during', 'after'].includes(stage)) { cleanup(); throw new HttpError(400, 'Choose a stage'); }
  if (!req.files?.length) throw new HttpError(400, 'Select at least one image (jpg/png/webp/heic) / اختر صورة');
  if (stage !== 'before' && wo.status !== 'in_progress') { cleanup(); throw new HttpError(400, 'Start work before uploading during/after photos / ابدأ العمل أولاً'); }
  const pair = req.body.pair_photo_id ? get("SELECT id FROM wo_photos WHERE id = ? AND wo_id = ? AND stage = 'before'", Number(req.body.pair_photo_id), wo.id) : null;
  for (const f of req.files) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex');
    const rel = path.relative(UPLOAD_DIR, f.path);
    const r = run(`INSERT INTO wo_photos(wo_id, stage, file_name, original_name, mime, sha256, caption, defect_location, pair_photo_id, lat, lng, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, wo.id, stage, rel, f.originalname, f.mimetype, sha, req.body.caption || null, req.body.defect_location || null,
      stage === 'after' ? pair?.id ?? null : null, Number(req.body.lat) || null, Number(req.body.lng) || null, req.user.id);
    audit(req, 'upload', 'wo_photo', `${wo.wo_number}:${r.lastInsertRowid}`, null, { stage, sha256: sha, file: f.originalname });
  }
  res.flash('success', `${req.files.length} ✓`);
  res.redirect(`/wo/${wo.id}#photos`);
});

router.get('/wo/:id/photos/:pid', (req, res) => {
  const wo = loadWO(req);
  const p = get('SELECT * FROM wo_photos WHERE id = ? AND wo_id = ?', Number(req.params.pid), wo.id);
  if (!p) throw new HttpError(404, 'Not found');
  const file = path.resolve(UPLOAD_DIR, p.file_name);
  if (!file.startsWith(path.resolve(UPLOAD_DIR))) throw new HttpError(400, 'Bad path');
  res.type(p.mime || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(file);
});

// ----- materials -----
router.post('/wo/:id/reservations', (req, res) => {
  const wo = loadWO(req);
  ensure(canWorkOnWO(wo, req.user) || canManageWO(wo, req.user) || req.user.role === 'warehouse');
  if (!['open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Locked');
  const num = (req.body.reservation_number || '').trim();
  if (!num) throw new HttpError(400, 'Reservation number required');
  if (get('SELECT 1 FROM material_reservations WHERE reservation_number = ?', num)) throw new HttpError(400, `Reservation ${num} already used / رقم الحجز مستخدم`);
  tx(() => {
    if (wo.materials_withdrawn !== 'yes') {
      run("UPDATE work_orders SET materials_withdrawn = 'yes' WHERE id = ?", wo.id);
      audit(req, 'update', 'work_order', wo.wo_number, { materials_withdrawn: wo.materials_withdrawn }, { materials_withdrawn: 'yes' }, 'reservation added');
    }
    const isPrimary = get('SELECT COUNT(*) n FROM material_reservations WHERE wo_id = ?', wo.id).n === 0 ? 1 : 0;
    run('INSERT INTO material_reservations(wo_id, reservation_number, is_primary, warehouse, received_by) VALUES (?,?,?,?,?)', wo.id, num, isPrimary, req.body.warehouse || null, wo.team_leader_id);
    audit(req, 'create', 'material_reservation', `${wo.wo_number}:${num}`, null, { reservation_number: num, warehouse: req.body.warehouse });
  });
  notify(idsByRole('warehouse'), { type: 'reservation_unverified', severity: 'warning', title: `${wo.wo_number} - حجز جديد بانتظار التحقق ${num} / New reservation to verify`, body: wo.title, link: `/wo/${wo.id}` });
  res.redirect(`/wo/${wo.id}#materials`);
});

router.post('/wo/:id/reservations/:rid/verify', requireRole('warehouse', 'admin'), (req, res) => {
  const wo = loadWO(req);
  const r = get('SELECT * FROM material_reservations WHERE id = ? AND wo_id = ?', Number(req.params.rid), wo.id);
  if (!r) throw new HttpError(404, 'Not found');
  const after = {
    verified: 1, verified_by: req.user.id, status: req.body.status || 'fully_issued', warehouse: req.body.warehouse || r.warehouse,
    storage_location: req.body.storage_location || r.storage_location, issued_at: localToUtc(req.body.issued_at) || nowIso(), issued_by: req.body.issued_by || req.user.name_ar,
  };
  run('UPDATE material_reservations SET verified=?, verified_by=?, status=?, warehouse=?, storage_location=?, issued_at=?, issued_by=? WHERE id=?', ...Object.values(after), r.id);
  audit(req, 'verify', 'material_reservation', `${wo.wo_number}:${r.reservation_number}`, r, after);
  notify([wo.team_leader_id], { type: 'reservation_verified', title: `${wo.wo_number} - تم التحقق من الحجز ${r.reservation_number} / Reservation verified`, body: wo.title, link: `/wo/${wo.id}`, email: false });
  res.redirect(`/wo/${wo.id}#materials`);
});

function materialFromBody(b) {
  const n = (k) => { const v = Number(b[k] || 0); if (Number.isNaN(v) || v < 0) throw new HttpError(400, `${k}: invalid`); return v; };
  return {
    reservation_id: b.reservation_id ? Number(b.reservation_id) : null, line_no: b.line_no || null, material_number: (b.material_number || '').trim(),
    description: b.description || null, uom: b.uom || null, source: MAT_SOURCES.includes(b.source) ? b.source : 'warehouse',
    reserved_qty: n('reserved_qty'), issued_qty: n('issued_qty'), used_qty: n('used_qty'), returned_qty: n('returned_qty'), damaged_qty: n('damaged_qty'),
    transferred_qty: n('transferred_qty'), transfer_wo_number: b.transfer_wo_number || null, remaining_authorized_qty: n('remaining_authorized_qty'),
    batch: b.batch || null, serial: b.serial || null, install_location: b.install_location || null, damage_reason: b.damage_reason || null,
  };
}
// A catalog pick fills the material number, description and unit
function fromCatalog(b) {
  const it = b.item_id ? get('SELECT * FROM items WHERE id = ?', Number(b.item_id)) : null;
  if (!it) return { ...b, item_id: null };
  return { ...b, item_id: it.id, material_number: (b.material_number || '').trim() || it.code, description: b.description || it.name_ar, uom: b.uom || it.uom };
}

router.post('/wo/:id/materials', (req, res) => {
  const wo = loadWO(req);
  ensure(canWorkOnWO(wo, req.user) || req.user.role === 'warehouse');
  if (!['open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Materials are locked / المواد مقفلة');
  const body = fromCatalog(req.body);
  const m = materialFromBody(body);
  if (!m.material_number) throw new HttpError(400, 'Material number required / رقم المادة مطلوب');
  if (m.source === 'warehouse' && !m.reservation_id) throw new HttpError(400, 'Choose the reservation for warehouse materials / اختر رقم الحجز');
  if (m.reservation_id && !get('SELECT 1 FROM material_reservations WHERE id = ? AND wo_id = ?', m.reservation_id, wo.id)) throw new HttpError(400, 'Bad reservation');
  const r = run(`INSERT INTO material_lines(wo_id, reservation_id, line_no, material_number, description, uom, source, reserved_qty, issued_qty, used_qty, returned_qty, damaged_qty,
    transferred_qty, transfer_wo_number, remaining_authorized_qty, batch, serial, install_location, damage_reason, recorded_by, item_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    wo.id, ...Object.values(m), req.user.id, body.item_id);
  audit(req, 'create', 'material_line', `${wo.wo_number}:${m.material_number}:${m.line_no || ''}`, null, { id: Number(r.lastInsertRowid), ...m });
  res.redirect(`/wo/${wo.id}#materials`);
});

// Edits keep a full before/after audit record; closed work orders are locked.
router.post('/wo/:id/materials/:mid', (req, res) => {
  const wo = loadWO(req);
  ensure(canWorkOnWO(wo, req.user) || req.user.role === 'warehouse');
  if (!['open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Materials are locked / المواد مقفلة');
  const old = get('SELECT * FROM material_lines WHERE id = ? AND wo_id = ?', Number(req.params.mid), wo.id);
  if (!old) throw new HttpError(404, 'Not found');
  if (!req.body.reason) throw new HttpError(400, 'A reason is required for every edit / سبب التعديل مطلوب');
  const m = { ...materialFromBody({ ...old, ...req.body }) };
  if (req.user.role === 'warehouse') { m.used_qty = old.used_qty; m.install_location = old.install_location; }
  else if (req.user.role !== 'admin') { m.issued_qty = old.issued_qty; m.returned_qty = old.returned_qty; }
  run(`UPDATE material_lines SET reservation_id=?, line_no=?, material_number=?, description=?, uom=?, source=?, reserved_qty=?, issued_qty=?, used_qty=?, returned_qty=?,
    damaged_qty=?, transferred_qty=?, transfer_wo_number=?, remaining_authorized_qty=?, batch=?, serial=?, install_location=?, damage_reason=?, recorded_by=? WHERE id=?`,
    ...Object.values(m), req.user.id, old.id);
  audit(req, 'update', 'material_line', `${wo.wo_number}:${old.material_number}:${old.line_no || ''}`, old, m, req.body.reason);
  res.redirect(`/wo/${wo.id}#materials`);
});

// ----- catalog materials, tools & equipment on the work order -----
const ensureItems = (wo, user) => ensure(canManageWO(wo, user) || canWorkOnWO(wo, user) || Items.canManage(user));
router.post('/wo/:id/items', (req, res) => {
  const wo = loadWO(req);
  ensureItems(wo, req.user);
  const lines = Items.parseLines(req.body);
  if (!lines.length) throw new HttpError(400, 'Choose an item and quantity / اختر الصنف والكمية');
  for (const l of lines) Items.addToWo(wo, { itemId: l.item_id, qty: l.qty, notes: (req.body.notes || '').trim() }, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/wo/${wo.id}#items`);
});
router.post('/wo/:id/items/:lid(\\d+)', (req, res) => {
  const wo = loadWO(req);
  ensureItems(wo, req.user);
  Items.updateWoLine(wo, Number(req.params.lid), req.body, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/wo/${wo.id}#items`);
});
router.post('/wo/:id/items/:lid(\\d+)/delete', (req, res) => {
  const wo = loadWO(req);
  ensureItems(wo, req.user);
  Items.removeFromWo(wo, Number(req.params.lid), req);
  res.redirect(`/wo/${wo.id}#items`);
});

router.post('/wo/:id/submit', (req, res) => {
  const wo = loadWO(req);
  ensure(canWorkOnWO(wo, req.user));
  W.submitForClosure(wo, req);
  res.flash('success', 'Submitted for approval / أُرسل للاعتماد');
  res.redirect(`/wo/${wo.id}`);
});

router.post('/wo/:id/decide', (req, res) => {
  const wo = loadWO(req);
  W.decide(wo, req.body.decision === 'rejected' ? 'rejected' : 'approved', (req.body.comment || '').trim(), req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/wo/${wo.id}`);
});

router.post('/wo/:id/cancel', (req, res) => {
  const wo = loadWO(req);
  ensure(canManageWO(wo, req.user));
  W.cancelWorkOrder(wo, (req.body.reason || '').trim(), req);
  res.redirect(`/wo/${wo.id}`);
});

router.get('/wo/:id/print', (req, res) => {
  const wo = loadWO(req);
  res.render('wo_print', {
    wo, officials: JSON.parse(wo.officials_json || '{}'),
    participants: all('SELECT e.*, p.role p_role FROM wo_participants p JOIN employees e ON e.id = p.employee_id WHERE p.wo_id = ? ORDER BY p.role DESC, e.employee_no', wo.id),
    photos: all('SELECT * FROM wo_photos WHERE wo_id = ? ORDER BY stage, id', wo.id),
    approvals: all("SELECT a.*, e.name_ar, e.name_en, e.employee_no FROM wo_approvals a LEFT JOIN employees e ON e.id = a.decided_by WHERE a.wo_id = ? AND a.decision IN ('approved','rejected') ORDER BY a.id", wo.id),
    rec: W.reconciliation(wo.id), lineVariance: W.lineVariance, away: W.teamAway(wo), crew: W.crewSummary(wo.id), woItems: Items.ofWo(wo.id),
    handovers: WC.handoversOf(wo.id), extensions: WC.extensionsOf(wo.id),
    asset: wo.asset_id ? get('SELECT * FROM assets WHERE id = ?', wo.asset_id) : null,
    section: get('SELECT * FROM org_units WHERE id = ?', wo.section_id),
    leader: get('SELECT * FROM employees WHERE id = ?', wo.team_leader_id),
  });
});

module.exports = router;

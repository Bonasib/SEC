'use strict';
const crypto = require('node:crypto');
const { all, get, run, tx, setting } = require('./db');
const { nowIso, audit, distanceCategory, HttpError, fmt } = require('./util');
const { officialsAt, holderAt } = require('./org');
const { notify, idsByRole, once } = require('./notify');
const { both, D } = require('./i18n');

const CRITICAL = ['C1', 'C2', 'C3', 'C4'];
const ACTIVE_STATUSES = ['awaiting_authorization', 'open', 'in_progress', 'pending_closure'];
const MAX_WO = 999999;

const isCritical = (wo) => CRITICAL.includes(wo.priority) || wo.type === 'critical';
const riyadhDate = (iso) => new Date(new Date(iso).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const placeholders = (arr) => arr.map(() => '?').join(',');

// ---------- numbering ----------
function nextWoNumber() {
  run("INSERT OR IGNORE INTO sequences(name, value) VALUES ('wo', 0)");
  const { value } = get("SELECT value FROM sequences WHERE name = 'wo'");
  const next = value + 1;
  if (next > MAX_WO) throw new HttpError(409, 'Work order sequence exhausted (WO999999). Generation stopped / تم بلوغ الحد الأقصى لأرقام أوامر العمل');
  run("UPDATE sequences SET value = ? WHERE name = 'wo'", next);
  if (next >= Number(setting('wo_sequence_warn_at'))) {
    once(`wo-seq-${Math.floor(next / 1000)}`, () =>
      notify(idsByRole('admin'), { type: 'wo_sequence', severity: 'critical', title: 'تنبيه: اقتراب نفاد أرقام أوامر العمل / WO sequence nearly exhausted', body: `Current: WO${String(next).padStart(6, '0')} / max WO999999` }));
  }
  return 'WO' + String(next).padStart(6, '0');
}

// Imported historical numbers must keep the format and push the sequence forward
function reserveImportedNumber(num) {
  if (!/^WO\d{6}$/.test(num)) throw new Error('wo_number must be WO + 6 digits');
  if (get('SELECT 1 FROM work_orders WHERE wo_number = ?', num)) throw new Error(`${num} already exists and cannot be reused`);
  run("INSERT OR IGNORE INTO sequences(name, value) VALUES ('wo', 0)");
  run("UPDATE sequences SET value = MAX(value, ?) WHERE name = 'wo'", Number(num.slice(2)));
  return num;
}

// ---------- validation ----------
function availabilityErrors({ participantIds, equipmentIds = [], plannedStart, plannedEnd, excludeWoId = 0 }) {
  const errors = [];
  if (new Date(plannedEnd) < new Date(plannedStart)) errors.push('Planned end is before planned start / النهاية قبل البداية');
  const d1 = riyadhDate(plannedStart), d2 = riyadhDate(plannedEnd);

  for (const id of participantIds) {
    const e = get('SELECT employee_no, name_ar, status FROM employees WHERE id = ?', id);
    if (!e) { errors.push(`Unknown employee id ${id}`); continue; }
    if (e.status !== 'active') errors.push(`${e.employee_no} ${e.name_ar}: not active / غير نشط`);
    const lv = get(`SELECT type, start_date, end_date FROM leaves WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`, id, d2, d1);
    if (lv) errors.push(`${e.employee_no} ${e.name_ar}: ${lv.type} ${lv.start_date} → ${lv.end_date} (غير متاح / unavailable)`);
    const clash = get(
      `SELECT w.wo_number FROM work_orders w JOIN wo_participants p ON p.wo_id = w.id
       WHERE p.employee_id = ? AND w.id <> ? AND w.status IN ('awaiting_authorization','open','in_progress')
       AND w.planned_start < ? AND w.planned_end > ?`, id, excludeWoId, plannedEnd, plannedStart);
    if (clash) errors.push(`${e.employee_no} ${e.name_ar}: conflicting work ${clash.wo_number} / تعارض مع مهمة أخرى`);
  }

  for (const id of equipmentIds) {
    const q = get('SELECT * FROM equipment WHERE id = ?', id);
    if (!q) { errors.push(`Unknown equipment id ${id}`); continue; }
    if (q.status !== 'available') errors.push(`${q.code} ${q.name}: ${q.status} (غير متاحة / not available)`);
    if (q.expiry_date && q.expiry_date < d2) errors.push(`${q.code} ${q.name}: expired ${q.expiry_date} / منتهية الصلاحية`);
    if (q.calibration_due && q.calibration_due < d2) errors.push(`${q.code} ${q.name}: calibration due ${q.calibration_due} / تحتاج معايرة`);
    const booked = get(
      `SELECT w.wo_number FROM work_orders w JOIN wo_equipment x ON x.wo_id = w.id
       WHERE x.equipment_id = ? AND w.id <> ? AND w.status IN ('awaiting_authorization','open','in_progress')
       AND w.planned_start < ? AND w.planned_end > ?`, id, excludeWoId, plannedEnd, plannedStart);
    if (booked) errors.push(`${q.code} ${q.name}: already booked on ${booked.wo_number} / محجوزة`);
  }
  return errors;
}

// Assignment counts per employee in a distance category for the calendar year
function distanceCounts(participantIds, category, year, excludeWoId = 0) {
  if (!participantIds.length) return [];
  return participantIds.map((id) => {
    const r = get(
      `SELECT COUNT(*) n FROM work_orders w JOIN wo_participants p ON p.wo_id = w.id
       WHERE p.employee_id = ? AND w.distance_category = ? AND w.status <> 'cancelled'
       AND substr(w.planned_start,1,4) = ? AND w.id <> ?`, id, category, String(year), excludeWoId);
    const e = get('SELECT employee_no, name_ar FROM employees WHERE id = ?', id);
    return { employee_id: id, employee_no: e?.employee_no, name_ar: e?.name_ar, count: r.n };
  });
}

function splitWarning({ assetId, location, plannedStart, participantIds, excludeWoId = 0 }) {
  if (!participantIds.length) return null;
  const from = new Date(new Date(plannedStart).getTime() - 24 * 3600e3).toISOString();
  const to = new Date(new Date(plannedStart).getTime() + 24 * 3600e3).toISOString();
  const r = get(
    `SELECT DISTINCT w.wo_number FROM work_orders w JOIN wo_participants p ON p.wo_id = w.id
     WHERE w.id <> ? AND w.status <> 'cancelled' AND w.planned_start BETWEEN ? AND ?
     AND ((w.asset_id IS NOT NULL AND w.asset_id = ?) OR (w.location IS NOT NULL AND w.location <> '' AND w.location = ?))
     AND p.employee_id IN (${placeholders(participantIds)}) LIMIT 1`,
    excludeWoId, from, to, assetId ?? -1, location || '\u0000', ...participantIds);
  return r ? `Possible split of ${r.wo_number}: same asset/location, same team, within 24h / احتمال تقسيم مهمة` : null;
}

// ---------- create ----------
/**
 * data: { type, title, description, priority, asset_id, voltage_kv, location, section_id, distance_km,
 *   planned_start, planned_end (UTC ISO), team_leader_id, participant_ids[], equipment_ids[], overnight,
 *   travel_hours, selection_reason, materials_withdrawn, reservation_number, warehouse, wo_number? }
 */
function createWorkOrder(data, req, { importedNumber } = {}) {
  const participantIds = [...new Set([data.team_leader_id, ...(data.participant_ids || [])].filter(Boolean).map(Number))];
  const equipmentIds = [...new Set((data.equipment_ids || []).filter(Boolean).map(Number))];
  if (!data.title) throw new HttpError(400, 'Title is required / العنوان مطلوب');
  if (!data.team_leader_id) throw new HttpError(400, 'Team leader is required / قائد الفريق مطلوب');
  if (!data.section_id) throw new HttpError(400, 'Section is required / القسم مطلوب');
  if (!data.planned_start || !data.planned_end) throw new HttpError(400, 'Planned start/end required / التواريخ مطلوبة');
  if (!['yes', 'no'].includes(data.materials_withdrawn)) throw new HttpError(400, 'Answer the warehouse materials question / أجب عن سؤال سحب المواد');
  if (data.materials_withdrawn === 'yes' && !data.reservation_number) throw new HttpError(400, 'Reservation number is required when materials were withdrawn / رقم الحجز إلزامي');
  if (data.materials_withdrawn === 'no' && data.reservation_number) throw new HttpError(400, 'Reservation number not allowed when no materials were withdrawn / لا يسمح برقم حجز');
  if (data.reservation_number && get('SELECT 1 FROM material_reservations WHERE reservation_number = ?', data.reservation_number))
    throw new HttpError(400, `Reservation ${data.reservation_number} is already linked to another work order / رقم الحجز مستخدم`);

  const itemLines = data.items || [];
  const errors = [
    ...availabilityErrors({ participantIds, equipmentIds, plannedStart: data.planned_start, plannedEnd: data.planned_end }),
    ...require('./items').checkLines(itemLines),
  ];
  if (errors.length) throw new HttpError(400, errors.join('\n'));

  const travel = require('./travel').normalize(data);
  data.distance_km = travel.distance_km;
  const category = travel.category;
  const year = riyadhDate(data.planned_start).slice(0, 4);
  const threshold = Number(setting('distance_threshold'));
  const counts = category === 'A' ? [] : distanceCounts(participantIds, category, year);
  const over = counts.filter((c) => c.count + 1 > threshold);
  const needsSector = over.length > 0;
  if (needsSector && category === 'C' && !data.selection_reason)
    throw new HttpError(400, `Assignment ${threshold + 1}+ over 200 km requires a selection reason and alternatives / يلزم تبرير الاختيار والبدائل: ${over.map((o) => o.employee_no).join(', ')}`);

  const created = nowIso();
  const officials = officialsAt(Number(data.section_id), created);
  const sla = CRITICAL.includes(data.priority) ? Number(setting(`sla_hours_${data.priority}`)) : null;
  const dueAt = sla ? new Date(Date.now() + sla * 3600e3).toISOString() : null;
  const split = splitWarning({ assetId: data.asset_id, location: data.location, plannedStart: data.planned_start, participantIds });

  const wo = tx(() => {
    const woNumber = importedNumber ? reserveImportedNumber(importedNumber) : nextWoNumber();
    const r = run(
      `INSERT INTO work_orders(wo_number, type, title, description, priority, asset_id, voltage_kv, location, section_id,
        distance_km, distance_category, needs_sector_approval, selection_reason, planned_start, planned_end, due_at,
        overnight, travel_hours, status, team_leader_id, officials_json, materials_withdrawn, split_warning, created_by, created_at, imported, involves_travel)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      woNumber, data.type || 'corrective', data.title, data.description || null, data.priority || 'normal',
      data.asset_id || null, data.voltage_kv || null, data.location || null, Number(data.section_id),
      Number(data.distance_km) || 0, category, needsSector ? 1 : 0, data.selection_reason || null,
      data.planned_start, data.planned_end, dueAt, data.overnight ? 1 : 0, data.travel_hours || null,
      needsSector ? 'awaiting_authorization' : 'open', Number(data.team_leader_id), JSON.stringify(officials),
      data.materials_withdrawn, split, req?.user?.id ?? null, created, importedNumber ? 1 : 0, travel.involves_travel);
    const id = Number(r.lastInsertRowid);
    for (const pid of participantIds) run('INSERT INTO wo_participants(wo_id, employee_id, role) VALUES (?,?,?)', id, pid, pid === Number(data.team_leader_id) ? 'leader' : 'member');
    for (const eid of equipmentIds) run('INSERT INTO wo_equipment(wo_id, equipment_id) VALUES (?,?)', id, eid);
    require('./items').addLines(id, itemLines, req);
    if (data.reservation_number) {
      run('INSERT INTO material_reservations(wo_id, reservation_number, warehouse, received_by) VALUES (?,?,?,?)', id, data.reservation_number, data.warehouse || null, Number(data.team_leader_id));
    }
    if (needsSector) {
      run("INSERT INTO wo_approvals(wo_id, phase, step, seq, expected_employee_id) VALUES (?, 'authorization', 'department_manager', 1, ?)", id, officials.department_manager?.employee_id ?? null);
      run("INSERT INTO wo_approvals(wo_id, phase, step, seq, expected_employee_id) VALUES (?, 'authorization', 'sector_head', 2, ?)", id, officials.sector_head?.employee_id ?? null);
    }
    const w = get('SELECT * FROM work_orders WHERE id = ?', id);
    audit(req, importedNumber || req?.importing ? 'import' : 'create', 'work_order', w.wo_number, null, { ...w, participants: participantIds, equipment: equipmentIds, items: itemLines, distance_counts: counts });
    return w;
  });

  // ----- alerts -----
  if (category !== 'A') require('./travel').checkAlerts(Number(year), participantIds);
  if (itemLines.length) require('./items').lowStockCheck(itemLines.map((l) => l.item_id));
  const link = `/wo/${wo.id}`;
  const details = woDetails(wo);
  notify(participantIds, {
    type: 'wo_assigned', severity: isCritical(wo) ? 'critical' : 'info',
    title: `${wo.wo_number} - تم إسناد أمر عمل لك / Work order assigned to you`,
    body: `${wo.title}${wo.description ? '\n' + wo.description : ''}`, link, details,
  });
  notify([officials.section_head?.employee_id].filter((x) => x && !participantIds.includes(x)), {
    type: 'wo_created', title: `${wo.wo_number} - أمر عمل جديد في قسمك / New work order in your section`, body: wo.title, link, details,
  });
  if (isCritical(wo)) {
    notify([officials.division_manager?.employee_id, officials.department_manager?.employee_id, ...idsByRole('safety')], {
      type: 'critical_created', severity: 'critical',
      title: `${wo.wo_number} - حالة حرجة ${wo.priority} / Critical case ${wo.priority}`,
      body: `${wo.title}\nالاستجابة مطلوبة قبل / Response due: ${fmt(wo.due_at, 'en')}`, link, details,
    });
  }
  if (needsSector) {
    notify([officials.department_manager?.employee_id], {
      type: 'approval_request', severity: 'warning',
      title: `${wo.wo_number} - مطلوب مراجعة: تجاوز ${threshold} مهمة / Review required: over ${threshold} assignments`,
      body: over.map((o) => `${o.employee_no} ${o.name_ar}: ${o.count + 1}`).join('\n') + (wo.selection_reason ? `\n${wo.selection_reason}` : ''),
      link, details,
    });
  }
  if (split) notify([officials.section_head?.employee_id, officials.division_manager?.employee_id], { type: 'split_warning', severity: 'warning', title: `${wo.wo_number} - تحذير / Warning`, body: split, link });
  const hol = holidaysBetween(riyadhDate(wo.planned_start), riyadhDate(wo.planned_end));
  const holidayWarning = hol.length ? `Planned during a public holiday: ${hol.map((h) => h.name_en).join(', ')} / خلال إجازة رسمية: ${hol.map((h) => h.name_ar).join('، ')}` : null;
  const crew = crewSummary(wo.id);
  const seatWarning = crew.vehicles.length && crew.seats < crew.people ? `Vehicle seats (${crew.seats}) are fewer than the crew (${crew.people}) / المقاعد أقل من عدد الفريق` : null;
  return { wo, warnings: [split, holidayWarning, seatWarning, needsSector ? `Sector Head authorization required (assignment > ${threshold} in ${category}) / يتطلب اعتماد رئيس القطاع` : null].filter(Boolean) };
}

function woDetails(wo) {
  const asset = wo.asset_id ? get('SELECT code FROM assets WHERE id = ?', wo.asset_id) : null;
  const leader = get('SELECT employee_no, name_ar FROM employees WHERE id = ?', wo.team_leader_id);
  return [
    ['رقم أمر العمل / WO', wo.wo_number],
    ['النوع / Type', both('wt_' + wo.type)],
    ['الأولوية / Priority', both('pr_' + wo.priority)],
    ['الأصل / Asset', asset?.code || '—'],
    ['الجهد / Voltage', wo.voltage_kv ? `${wo.voltage_kv} kV` : '—'],
    ['الموقع / Location', wo.location || '—'],
    ['البداية / Start', fmt(wo.planned_start, 'en')],
    ['النهاية / End', fmt(wo.planned_end, 'en')],
    ['قائد الفريق / Leader', leader ? `${leader.employee_no} ${leader.name_ar}` : '—'],
    ['الحالة / Status', both('st_' + wo.status)],
    ...(() => {
      const items = require('./items').ofWo(wo.id);
      return items.length ? [['المواد والعدد / Materials & tools', items.map((i) => `${i.code} ${i.name_ar} × ${i.qty} ${i.uom}`).join(' · ')]] : [];
    })(),
  ];
}

// ---------- crew & fleet ----------
function crewSummary(woId) {
  const people = get('SELECT COUNT(*) n FROM wo_participants WHERE wo_id = ?', woId).n;
  const vehicles = all("SELECT q.* FROM wo_equipment x JOIN equipment q ON q.id = x.equipment_id WHERE x.wo_id = ? AND q.type = 'vehicle' ORDER BY q.code", woId);
  const devices = all("SELECT q.* FROM wo_equipment x JOIN equipment q ON q.id = x.equipment_id WHERE x.wo_id = ? AND q.type <> 'vehicle' ORDER BY q.code", woId);
  return { people, vehicles, devices, seats: vehicles.reduce((a, v) => a + (v.seats || 0), 0) };
}

// ---------- team availability ----------
const holidaysBetween = (from, to) => all('SELECT * FROM holidays WHERE start_date <= ? AND end_date >= ? ORDER BY start_date', to, from);

// Section staff (and any participant) who were on leave, a course, workshop, factory tests, etc.
// during the work order's planned window.
function teamAway(wo) {
  const from = riyadhDate(wo.planned_start), to = riyadhDate(wo.planned_end);
  const people = all(`SELECT l.*, e.employee_no, e.name_ar, e.name_en, e.job_title_en,
      EXISTS (SELECT 1 FROM wo_participants p WHERE p.wo_id = ? AND p.employee_id = e.id) is_participant
    FROM leaves l JOIN employees e ON e.id = l.employee_id
    WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ?
    AND (e.section_id = ? OR e.id IN (SELECT employee_id FROM wo_participants WHERE wo_id = ?))
    ORDER BY l.type, e.employee_no`, wo.id, to, from, wo.section_id, wo.id);
  return { from, to, people, holidays: holidaysBetween(from, to) };
}

// ---------- materials ----------
function lineVariance(l) {
  return +(l.issued_qty - (l.used_qty + l.returned_qty + l.damaged_qty + l.transferred_qty + l.remaining_authorized_qty)).toFixed(4);
}
function lineErrors(l) {
  const e = [];
  if (l.source === 'warehouse') {
    const v = lineVariance(l);
    if (v !== 0) e.push(`variance ${v}`);
    if (l.used_qty > l.issued_qty) e.push('used > issued');
  } else if (l.used_qty <= 0) e.push('no used quantity');
  if (l.damaged_qty > 0 && !l.damage_reason) e.push('damage reason required');
  if (l.transferred_qty > 0 && !l.transfer_wo_number) e.push('receiving WO required for transfer');
  return e;
}
function reconciliation(woId) {
  const lines = all('SELECT * FROM material_lines WHERE wo_id = ? ORDER BY id', woId);
  const bad = lines.filter((l) => lineErrors(l).length);
  return { lines, bad, status: !lines.length ? 'none' : bad.length === 0 ? 'fully_reconciled' : bad.length < lines.length ? 'partially_reconciled' : 'not_reconciled' };
}

// ---------- closure ----------
function closureChecklist(wo) {
  const photos = all('SELECT stage FROM wo_photos WHERE wo_id = ?', wo.id);
  const has = (s) => photos.some((p) => p.stage === s);
  const res = all('SELECT * FROM material_reservations WHERE wo_id = ?', wo.id);
  const rec = reconciliation(wo.id);
  const participants = get('SELECT COUNT(*) n FROM wo_participants WHERE wo_id = ?', wo.id).n;
  const usedLines = rec.lines.filter((l) => l.used_qty > 0).length;
  const items = [
    { key: 'before_photo', ok: has('before'), label: 'صورة قبل العمل / Before photo' },
    { key: 'after_photo', ok: has('after'), label: 'صورة بعد العمل / After photo' },
    { key: 'action', ok: !!(wo.action_description && wo.action_description.trim()), label: 'وصف الإجراء / Action description' },
    { key: 'result', ok: !!wo.result, label: 'نتيجة المعالجة / Result' },
    { key: 'participants', ok: participants > 0, label: 'أسماء المشاركين / Participants' },
    { key: 'materials_used_answered', ok: !!wo.materials_used, label: 'سؤال استخدام المواد / Materials-used question answered' },
  ];
  if (wo.materials_withdrawn === 'yes') {
    items.push({ key: 'reservation_verified', ok: res.length > 0 && res.every((r) => r.verified), label: 'التحقق من رقم الحجز / Reservation verified' });
  }
  if (wo.materials_used === 'yes') {
    items.push({ key: 'used_lines', ok: usedLines > 0, label: 'تسجيل المواد المستخدمة وكمياتها / Used materials recorded' });
    if (wo.materials_withdrawn !== 'yes') items.push({ key: 'alt_source', ok: !!wo.alt_material_source, label: 'مصدر المواد البديل / Alternative material source' });
  }
  if (rec.lines.length) items.push({ key: 'reconciled', ok: rec.bad.length === 0, label: 'مطابقة المواد (المصروف = المستخدم + المرتجع + التالف + المحول + المتبقي) / Materials reconciled' });
  if (isCritical(wo)) items.push({ key: 'response_times', ok: !!(wo.arrival_at && wo.restored_at), label: 'أوقات الوصول والاستعادة / Arrival & restoration times' });
  if (wo.result && wo.result !== 'complete') items.push({ key: 'non_completion', ok: !!wo.non_completion_reason, label: 'سبب عدم الإنجاز الكامل / Reason for non-completion' });
  return items;
}

// ---------- approvals ----------
function pendingApproval(woId) {
  return get("SELECT * FROM wo_approvals WHERE wo_id = ? AND decision = 'pending' ORDER BY seq LIMIT 1", woId);
}

// Who may decide a step right now: the expected person, or whoever holds the position now (acting).
function canDecide(wo, step, user) {
  if (!user) return { ok: false };
  if (step.step === 'team_leader') return { ok: user.id === wo.team_leader_id, acting: false };
  if (step.expected_employee_id === user.id) return { ok: true, acting: false };
  const nowOfficials = officialsAt(wo.section_id, nowIso());
  const holder = nowOfficials[step.step];
  if (holder?.employee_id === user.id) return { ok: true, acting: !!holder.acting };
  if (!step.expected_employee_id && !holder?.employee_id && user.role === step.step) return { ok: true, acting: false };
  return { ok: false };
}

function notifyApprover(wo, step) {
  let ids;
  if (step.step === 'team_leader') ids = [wo.team_leader_id];
  else {
    const holder = officialsAt(wo.section_id, nowIso())[step.step];
    ids = [holder?.employee_id || step.expected_employee_id].filter(Boolean);
    if (!ids.length) ids = idsByRole(step.step, 'admin');
  }
  notify(ids, {
    type: 'approval_request', severity: isCritical(wo) ? 'critical' : 'warning',
    title: `${wo.wo_number} - مطلوب اعتمادك (${D['step_' + step.step][0]}) / Your approval is required (${D['step_' + step.step][1]})`,
    body: `${wo.title}\n${both('phase_' + step.phase)}`, link: `/wo/${wo.id}`, details: woDetails(wo),
  });
}

function participantIds(woId) {
  return all('SELECT employee_id FROM wo_participants WHERE wo_id = ?', woId).map((r) => r.employee_id);
}

function startWork(wo, req) {
  if (wo.status !== 'open') throw new HttpError(400, 'Only open work orders can start / لا يمكن البدء');
  const res = all('SELECT * FROM material_reservations WHERE wo_id = ?', wo.id);
  if (wo.materials_withdrawn === 'yes' && (!res.length || !res.every((r) => r.verified)))
    throw new HttpError(400, 'Reservation must be verified by the warehouse before work starts / يجب التحقق من رقم الحجز قبل البدء');
  const eq = all('SELECT equipment_id FROM wo_equipment WHERE wo_id = ?', wo.id).map((r) => r.equipment_id);
  const errs = availabilityErrors({ participantIds: [], equipmentIds: eq, plannedStart: nowIso(), plannedEnd: wo.planned_end, excludeWoId: wo.id });
  if (errs.length) throw new HttpError(400, errs.join('\n'));
  const at = nowIso();
  run("UPDATE work_orders SET status = 'in_progress', actual_start = ? WHERE id = ?", at, wo.id);
  audit(req, 'start', 'work_order', wo.wo_number, { status: wo.status }, { status: 'in_progress', actual_start: at });
  const officials = JSON.parse(wo.officials_json || '{}');
  notify([officials.section_head?.employee_id, ...participantIds(wo.id)], {
    type: 'wo_started', title: `${wo.wo_number} - بدأ التنفيذ / Work started`, body: wo.title, link: `/wo/${wo.id}`, email: isCritical(wo),
  });
}

function submitForClosure(wo, req) {
  if (wo.status !== 'in_progress') throw new HttpError(400, 'Work order must be in progress / يجب أن يكون قيد التنفيذ');
  const missing = closureChecklist(wo).filter((i) => !i.ok);
  if (missing.length) {
    const rec = reconciliation(wo.id);
    if (rec.bad.length) {
      const o = JSON.parse(wo.officials_json || '{}');
      once(`variance-${wo.id}-${rec.bad.map((l) => l.id + ':' + lineVariance(l)).join(',')}`, () =>
        notify([o.section_head?.employee_id, o.division_manager?.employee_id, ...idsByRole('warehouse')], {
          type: 'material_variance', severity: 'warning',
          title: `${wo.wo_number} - فروقات مواد غير مبررة تمنع الإغلاق / Unexplained material variance blocks closure`,
          body: rec.bad.map((l) => `${l.material_number}: ${lineErrors(l).join(', ')}`).join('\n'), link: `/wo/${wo.id}`,
        }));
    }
    throw new HttpError(400, 'Closure requirements not met / متطلبات الإغلاق غير مكتملة:\n' + missing.map((m) => '• ' + m.label).join('\n'));
  }
  const at = nowIso();
  const officials = officialsAt(wo.section_id, at);
  tx(() => {
    run("UPDATE wo_approvals SET decision = 'superseded' WHERE wo_id = ? AND phase = 'closure' AND decision = 'pending'", wo.id);
    const steps = ['team_leader', 'section_head'];
    if (isCritical(wo)) steps.push('division_manager');
    steps.forEach((s, i) => {
      const expected = s === 'team_leader' ? wo.team_leader_id : officials[s]?.employee_id ?? null;
      const r = run("INSERT INTO wo_approvals(wo_id, phase, step, seq, expected_employee_id) VALUES (?, 'closure', ?, ?, ?)", wo.id, s, i + 1, expected);
      // Submitting as the team leader signs the team-leader step
      if (s === 'team_leader' && req.user.id === wo.team_leader_id) {
        run("UPDATE wo_approvals SET decision = 'approved', decided_by = ?, decided_at = ?, verification_code = ? WHERE id = ?",
          req.user.id, at, crypto.randomBytes(4).toString('hex').toUpperCase(), r.lastInsertRowid);
      }
    });
    run("UPDATE work_orders SET status = 'pending_closure', actual_end = COALESCE(actual_end, ?) WHERE id = ?", at, wo.id);
    audit(req, 'submit_closure', 'work_order', wo.wo_number, { status: wo.status }, { status: 'pending_closure' });
  });
  const fresh = get('SELECT * FROM work_orders WHERE id = ?', wo.id);
  notifyApprover(fresh, pendingApproval(wo.id));
}

function decide(wo, decision, comment, req) {
  const step = pendingApproval(wo.id);
  if (!step) throw new HttpError(400, 'Nothing awaiting approval / لا يوجد ما ينتظر الاعتماد');
  const who = canDecide(wo, step, req.user);
  if (!who.ok) throw new HttpError(403, 'You are not the approver for this step / لست المعتمد لهذه الخطوة');
  if (decision === 'rejected' && !comment) throw new HttpError(400, 'A comment is required to reject / التعليق مطلوب عند الرفض');
  const at = nowIso();
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const participants = participantIds(wo.id);
  const link = `/wo/${wo.id}`;
  let finalStatus = null;

  tx(() => {
    run('UPDATE wo_approvals SET decision = ?, decided_by = ?, decided_at = ?, comment = ?, acting = ?, verification_code = ? WHERE id = ?',
      decision, req.user.id, at, comment || null, who.acting ? 1 : 0, code, step.id);
    if (decision === 'rejected') {
      run("UPDATE wo_approvals SET decision = 'superseded' WHERE wo_id = ? AND phase = ? AND decision = 'pending'", wo.id, step.phase);
      finalStatus = step.phase === 'authorization' ? 'cancelled' : 'in_progress';
      run('UPDATE work_orders SET status = ?, cancel_reason = CASE WHEN ? = \'cancelled\' THEN ? ELSE cancel_reason END WHERE id = ?', finalStatus, finalStatus, `Authorization rejected: ${comment}`, wo.id);
    } else if (!pendingApproval(wo.id)) {
      finalStatus = step.phase === 'authorization' ? 'open' : 'closed';
      run('UPDATE work_orders SET status = ?, closed_at = CASE WHEN ? = \'closed\' THEN ? ELSE closed_at END WHERE id = ?', finalStatus, finalStatus, at, wo.id);
    }
    audit(req, decision === 'approved' ? 'approve' : 'reject', 'work_order', wo.wo_number,
      { status: wo.status, step: step.step }, { status: finalStatus || wo.status, step: step.step, verification_code: code, acting: who.acting }, comment);
  });

  const fresh = get('SELECT * FROM work_orders WHERE id = ?', wo.id);
  if (finalStatus === 'cancelled') require('./sync').onWorkOrderStatus(fresh, 'cancelled', req);
  if (decision === 'rejected') {
    notify([...participants, wo.created_by], {
      type: 'approval_rejected', severity: 'warning',
      title: `${wo.wo_number} - تم الرفض من ${D['step_' + step.step][0]} / Rejected by ${D['step_' + step.step][1]}`, body: comment, link,
    });
  } else if (finalStatus === 'closed') {
    require('./points').awardClosure(fresh, participants, req.user.id);
    require('./items').settle(fresh, req);
    require('./sync').onWorkOrderStatus(fresh, 'closed', req);
    const o = JSON.parse(wo.officials_json || '{}');
    notify([...participants, o.section_head?.employee_id], { type: 'wo_closed', title: `${wo.wo_number} - تم إغلاق أمر العمل / Work order closed`, body: wo.title, link, details: woDetails(fresh) });
  } else if (finalStatus === 'open') {
    notify([...participants], { type: 'wo_authorized', title: `${wo.wo_number} - تم التفويض ويمكن البدء / Authorized - work may start`, body: wo.title, link, details: woDetails(fresh) });
  } else {
    notifyApprover(fresh, pendingApproval(wo.id));
  }
}

// ---------- edit ----------
const EDITABLE = ['awaiting_authorization', 'open', 'in_progress'];
/**
 * Edit a work order's details, crew and vehicles. Dates are locked once work has started
 * (use an extension). Availability, travel bands and assignment limits are re-checked.
 */
function updateWorkOrder(wo, data, reason, req) {
  if (!EDITABLE.includes(wo.status)) throw new HttpError(400, 'This work order can no longer be edited / لا يمكن تعديل أمر العمل في هذه الحالة');
  if (!reason) throw new HttpError(400, 'A reason for the change is required / سبب التعديل مطلوب');
  if (!data.title) throw new HttpError(400, 'Title is required / العنوان مطلوب');
  if (!data.team_leader_id) throw new HttpError(400, 'Team leader is required / قائد الفريق مطلوب');
  if (!data.section_id) throw new HttpError(400, 'Section is required / القسم مطلوب');
  const started = wo.status === 'in_progress';
  const start = started || !data.planned_start ? wo.planned_start : data.planned_start;
  const end = started || !data.planned_end ? wo.planned_end : data.planned_end;
  const participantIdsNew = [...new Set([data.team_leader_id, ...(data.participant_ids || [])].filter(Boolean).map(Number))];
  const equipmentIds = [...new Set((data.equipment_ids || []).filter(Boolean).map(Number))];
  const before = { ...wo, participants: participantIds(wo.id), equipment: all('SELECT equipment_id FROM wo_equipment WHERE wo_id = ?', wo.id).map((r) => r.equipment_id) };

  const errors = availabilityErrors({ participantIds: participantIdsNew, equipmentIds, plannedStart: start, plannedEnd: end, excludeWoId: wo.id });
  if (errors.length) throw new HttpError(400, errors.join('\n'));
  const travel = require('./travel').normalize(data);
  const year = riyadhDate(start).slice(0, 4);
  const threshold = Number(setting('distance_threshold'));
  const counts = travel.category === 'A' ? [] : distanceCounts(participantIdsNew, travel.category, year, wo.id);
  const over = counts.filter((c) => c.count + 1 > threshold);
  if (over.length && travel.category === 'C' && !data.selection_reason)
    throw new HttpError(400, `Assignment ${threshold + 1}+ over 200 km requires a selection reason / يلزم تبرير الاختيار: ${over.map((o) => o.employee_no).join(', ')}`);
  const wasAuthorized = !!get("SELECT 1 FROM wo_approvals WHERE wo_id = ? AND phase = 'authorization' AND decision = 'approved'", wo.id);
  const needsAuth = over.length > 0 && !wo.needs_sector_approval && wo.status === 'open' && !wasAuthorized;

  const priority = data.priority || wo.priority;
  const sla = CRITICAL.includes(priority) ? Number(setting(`sla_hours_${priority}`)) : null;
  const dueAt = priority === wo.priority ? wo.due_at : sla ? new Date(Date.now() + sla * 3600e3).toISOString() : null;
  const sectionChanged = Number(data.section_id) !== wo.section_id;
  const officials = sectionChanged ? officialsAt(Number(data.section_id), nowIso()) : null;

  const after = {
    type: data.type || wo.type, title: data.title, description: data.description || null, priority, asset_id: data.asset_id || null, voltage_kv: data.voltage_kv || null,
    location: data.location || null, section_id: Number(data.section_id), distance_km: travel.distance_km, distance_category: travel.category, involves_travel: travel.involves_travel,
    selection_reason: data.selection_reason || null, planned_start: start, planned_end: end, due_at: dueAt, overnight: data.overnight ? 1 : 0,
    travel_hours: data.travel_hours ?? null, team_leader_id: Number(data.team_leader_id),
  };
  tx(() => {
    run(`UPDATE work_orders SET type=?, title=?, description=?, priority=?, asset_id=?, voltage_kv=?, location=?, section_id=?, distance_km=?, distance_category=?, involves_travel=?,
      selection_reason=?, planned_start=?, planned_end=?, due_at=?, overnight=?, travel_hours=?, team_leader_id=? WHERE id=?`, ...Object.values(after), wo.id);
    if (officials) run('UPDATE work_orders SET officials_json = ? WHERE id = ?', JSON.stringify(officials), wo.id);
    run('DELETE FROM wo_participants WHERE wo_id = ?', wo.id);
    for (const pid of participantIdsNew) run('INSERT INTO wo_participants(wo_id, employee_id, role) VALUES (?,?,?)', wo.id, pid, pid === after.team_leader_id ? 'leader' : 'member');
    run('DELETE FROM wo_equipment WHERE wo_id = ?', wo.id);
    for (const eid of equipmentIds) run('INSERT INTO wo_equipment(wo_id, equipment_id) VALUES (?,?)', wo.id, eid);
    if (needsAuth) {
      const o = officials || JSON.parse(wo.officials_json || '{}');
      run("UPDATE work_orders SET needs_sector_approval = 1, status = 'awaiting_authorization' WHERE id = ?", wo.id);
      run("INSERT INTO wo_approvals(wo_id, phase, step, seq, expected_employee_id) VALUES (?, 'authorization', 'department_manager', 1, ?)", wo.id, o.department_manager?.employee_id ?? null);
      run("INSERT INTO wo_approvals(wo_id, phase, step, seq, expected_employee_id) VALUES (?, 'authorization', 'sector_head', 2, ?)", wo.id, o.sector_head?.employee_id ?? null);
    }
    audit(req, 'update', 'work_order', wo.wo_number, before, { ...after, participants: participantIdsNew, equipment: equipmentIds }, reason);
  });

  // ----- tell the people affected -----
  const fresh = get('SELECT * FROM work_orders WHERE id = ?', wo.id);
  const link = `/wo/${wo.id}`;
  const details = woDetails(fresh);
  const added = participantIdsNew.filter((x) => !before.participants.includes(x));
  const removed = before.participants.filter((x) => !participantIdsNew.includes(x));
  const kept = participantIdsNew.filter((x) => before.participants.includes(x));
  const changed = Object.keys(after).filter((k) => String(after[k] ?? '') !== String(wo[k] ?? ''));
  if (added.length) notify(added, { type: 'wo_assigned', severity: isCritical(fresh) ? 'critical' : 'info', title: `${wo.wo_number} - تم إسناد أمر عمل لك / Work order assigned to you`, body: fresh.title, link, details });
  if (removed.length) notify(removed, { type: 'wo_unassigned', severity: 'warning', title: `${wo.wo_number} - تم استبعادك من أمر العمل / You were removed from the work order`, body: reason, link: '/' });
  if (kept.length && (changed.length || [...equipmentIds].sort().join() !== [...before.equipment].sort().join())) {
    notify(kept, { type: 'wo_updated', title: `${wo.wo_number} - تم تعديل أمر العمل / Work order updated`, body: `${reason}\n${changed.join(', ')}`, link, details });
  }
  if (needsAuth) {
    const o = JSON.parse(fresh.officials_json || '{}');
    notify([o.department_manager?.employee_id], { type: 'approval_request', severity: 'warning', title: `${wo.wo_number} - مطلوب مراجعة: تجاوز ${threshold} مهمة / Review required: over ${threshold} assignments`, body: over.map((x) => `${x.employee_no} ${x.name_ar}: ${x.count + 1}`).join('\n'), link, details });
  }
  if (travel.category !== 'A') require('./travel').checkAlerts(Number(year), participantIdsNew);
  const crew = crewSummary(wo.id);
  return {
    wo: fresh,
    warnings: [
      crew.vehicles.length && crew.seats < crew.people ? `Vehicle seats (${crew.seats}) are fewer than the crew (${crew.people}) / المقاعد أقل من عدد الفريق` : null,
      needsAuth ? `Sector Head authorization required (assignment > ${threshold}) / يتطلب اعتماد رئيس القطاع` : null,
      over.length && !needsAuth ? `Over ${threshold} assignments in this distance band: ${over.map((x) => x.employee_no).join(', ')}` : null,
    ].filter(Boolean),
  };
}

function cancelWorkOrder(wo, reason, req) {
  if (!ACTIVE_STATUSES.includes(wo.status)) throw new HttpError(400, 'Cannot cancel / لا يمكن الإلغاء');
  if (!reason) throw new HttpError(400, 'Cancellation reason required / سبب الإلغاء مطلوب');
  tx(() => {
    run("UPDATE work_orders SET status = 'cancelled', cancel_reason = ? WHERE id = ?", reason, wo.id);
    run("UPDATE wo_approvals SET decision = 'superseded' WHERE wo_id = ? AND decision = 'pending'", wo.id);
    run("UPDATE material_reservations SET status = 'cancelled' WHERE wo_id = ?", wo.id);
    audit(req, 'cancel', 'work_order', wo.wo_number, { status: wo.status }, { status: 'cancelled' }, reason);
  });
  notify(participantIds(wo.id), { type: 'wo_cancelled', severity: 'warning', title: `${wo.wo_number} - تم إلغاء أمر العمل / Work order cancelled`, body: reason, link: `/wo/${wo.id}` });
  require('./sync').onWorkOrderStatus(wo, 'cancelled', req);
}

module.exports = {
  CRITICAL, ACTIVE_STATUSES, isCritical, nextWoNumber, availabilityErrors, distanceCounts, createWorkOrder,
  closureChecklist, reconciliation, lineVariance, lineErrors, pendingApproval, canDecide, startWork,
  submitForClosure, decide, cancelWorkOrder, updateWorkOrder, participantIds, woDetails, riyadhDate, holderAt, teamAway, holidaysBetween, crewSummary,
};

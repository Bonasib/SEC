'use strict';
// Optional documents attached to work orders, vehicles and employees (licences, cards, permits...).
// Documents with an expiry date raise alerts before and after they expire.
const { all, get, run, setting } = require('./db');
const { audit, HttpError, nowIso, todayRiyadh } = require('./util');
const { notify, idsByRole, once } = require('./notify');
const { officialsAt } = require('./org');
const F = require('./files');

const TYPES = {
  work_order: ['work_permit', 'drawing', 'method_statement', 'risk_assessment', 'test_report', 'contractor_doc', 'handover_report', 'other'],
  vehicle: ['registration', 'insurance', 'periodic_inspection', 'operating_card', 'maintenance_record', 'other'],
  employee: ['employee_card', 'national_id', 'driving_license', 'certificate', 'medical', 'other'],
};
const MANAGERS = ['section_head', 'division_manager', 'department_manager', 'sector_head'];

function target(entity, id) {
  if (entity === 'work_order') return get('SELECT * FROM work_orders WHERE id = ?', id);
  if (entity === 'vehicle') return get("SELECT * FROM equipment WHERE id = ? AND type = 'vehicle'", id);
  if (entity === 'employee') return get('SELECT * FROM employees WHERE id = ?', id);
  return null;
}

/** { view, edit } for a user on one record. */
function rights(entity, rec, user) {
  const { can } = require('./access');
  if (!rec || !user) return { view: false, edit: false };
  if (entity === 'work_order') {
    const P = require('./perm');
    const view = P.canViewWO(rec, user);
    return { view, edit: view && rec.status !== 'cancelled' && (P.canWorkOnWO(rec, user) || P.canManageWO(rec, user)) };
  }
  if (entity === 'vehicle') {
    const edit = can(user, 'fleet.manage') === true;
    return { view: true, edit };
  }
  // Employee documents are personal: the employee, HR / people managers and the managers of the employee's section
  const hr = can(user, 'employees.manage') === true;
  const self = user.id === rec.id;
  const o = rec.section_id ? officialsAt(rec.section_id, nowIso()) : {};
  const boss = MANAGERS.some((k) => o[k]?.employee_id === user.id);
  return { view: self || hr || boss || user.role === 'auditor', edit: self || hr };
}

function list(entity, id) {
  return all(`SELECT d.*, e.name_ar, e.name_en FROM documents d LEFT JOIN employees e ON e.id = d.uploaded_by
    WHERE d.entity = ? AND d.entity_id = ? AND d.deleted_at IS NULL ORDER BY d.doc_type, d.id DESC`, entity, id)
    .map((d) => ({ ...d, state: expiryState(d.expiry_date) }));
}

function expiryState(date) {
  if (!date) return null;
  const today = todayRiyadh();
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);
  return date < today ? 'expired' : date <= horizon ? 'soon' : 'valid';
}

function add(entity, id, files, b, req) {
  const rec = target(entity, id);
  if (!rec) throw new HttpError(404, 'Not found');
  if (!rights(entity, rec, req.user).edit) throw new HttpError(403, 'Forbidden / ليست لديك صلاحية');
  if (!files?.length) throw new HttpError(400, 'Choose a file / اختر ملفًا');
  const type = TYPES[entity].includes(b.doc_type) ? b.doc_type : 'other';
  const dateOk = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
  const meta = { title: String(b.title || '').trim() || null, doc_no: String(b.doc_no || '').trim() || null, issue_date: dateOk(b.issue_date), expiry_date: dateOk(b.expiry_date), notes: String(b.notes || '').trim() || null };
  if (meta.issue_date && meta.expiry_date && meta.expiry_date < meta.issue_date) throw new HttpError(400, 'Expiry is before issue date / تاريخ الانتهاء قبل الإصدار');
  for (const f of files) {
    const r = run(`INSERT INTO documents(entity, entity_id, doc_type, title, doc_no, issue_date, expiry_date, file_name, original_name, mime, size, sha256, notes, uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, entity, id, type, meta.title || f.originalname, meta.doc_no, meta.issue_date, meta.expiry_date,
    F.rel(f.path), f.originalname, f.mimetype, f.size, F.sha256(f.path), meta.notes, req.user.id);
    audit(req, 'create', 'document', `${entity}:${id}:${r.lastInsertRowid}`, null, { doc_type: type, file: f.originalname, ...meta });
  }
  // Tell the people concerned
  if (entity === 'work_order') {
    const ids = all('SELECT employee_id FROM wo_participants WHERE wo_id = ?', id).map((x) => x.employee_id).filter((x) => x !== req.user.id);
    notify(ids, { type: 'document_added', email: false, title: `${rec.wo_number} - مستند جديد / New document`, body: `${meta.title || files[0].originalname}`, link: `/wo/${id}#documents` });
  } else if (entity === 'employee' && rec.id !== req.user.id) {
    notify([rec.id], { type: 'document_added', email: false, title: 'أُضيف مستند إلى ملفك / A document was added to your file', body: meta.title || files[0].originalname, link: `/employees/${id}#documents` });
  }
  checkExpiry();
  return files.length;
}

function find(docId, user, needEdit) {
  const d = get('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', docId);
  if (!d) throw new HttpError(404, 'Not found');
  const r = rights(d.entity, target(d.entity, d.entity_id), user);
  if (!(needEdit ? r.edit : r.view)) throw new HttpError(403, 'Forbidden / ليست لديك صلاحية');
  return d;
}

// Deleting keeps the record (audit) and removes the file
function remove(docId, req) {
  const d = find(docId, req.user, true);
  run('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?', nowIso(), req.user.id, d.id);
  F.remove(d.file_name);
  audit(req, 'delete', 'document', `${d.entity}:${d.entity_id}:${d.id}`, d, null);
  return d;
}

const linkOf = (d) => (d.entity === 'work_order' ? `/wo/${d.entity_id}#documents` : d.entity === 'vehicle' ? `/fleet/${d.entity_id}#documents` : `/employees/${d.entity_id}#documents`);

/** Alerts for documents expiring soon or expired (vehicle licences, employee cards...). Once per state. */
function checkExpiry() {
  let n = 0;
  const today = todayRiyadh();
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);
  for (const d of all('SELECT * FROM documents WHERE deleted_at IS NULL AND expiry_date IS NOT NULL AND expiry_date <= ?', horizon)) {
    const expired = d.expiry_date < today;
    once(`doc-${d.id}-${d.expiry_date}-${expired ? 'x' : 'soon'}`, () => {
      n++;
      const rec = target(d.entity, d.entity_id);
      if (!rec) return;
      let ids = [], name = '';
      if (d.entity === 'vehicle') {
        ids = [...idsByRole('admin', 'safety'), rec.section_id ? officialsAt(rec.section_id, nowIso()).section_head?.employee_id : null];
        name = `${rec.plate_number || rec.code}`;
      } else if (d.entity === 'employee') {
        ids = [rec.id, ...idsByRole('hr')];
        name = `${rec.employee_no} ${rec.name_ar}`;
      } else {
        ids = [rec.team_leader_id];
        name = rec.wo_number;
      }
      const { D } = require('./i18n');
      const [ar, en] = D['dt_' + d.doc_type] || [d.doc_type, d.doc_type];
      notify(ids, {
        type: 'document_expiry', severity: expired ? 'critical' : 'warning',
        title: `${name} - ${ar}: ${expired ? 'منتهي' : 'ينتهي قريبًا'} ${d.expiry_date} / ${en}: ${expired ? 'expired' : 'expiring soon'} ${d.expiry_date}`,
        body: d.title || '', link: linkOf(d),
      });
    });
  }
  return n;
}

/** Counts of expiring/expired documents for a set of records (list badges). */
function expirySummary(entity) {
  const rows = all('SELECT entity_id, expiry_date FROM documents WHERE entity = ? AND deleted_at IS NULL AND expiry_date IS NOT NULL', entity);
  const out = {};
  for (const r of rows) {
    const s = expiryState(r.expiry_date);
    if (s === 'valid') continue;
    out[r.entity_id] = out[r.entity_id] === 'expired' || s === 'expired' ? 'expired' : 'soon';
  }
  return out;
}

module.exports = { TYPES, rights, list, add, find, remove, checkExpiry, expirySummary, target };

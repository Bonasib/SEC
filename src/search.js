'use strict';
// Global search: one box across the system. Every group applies the same visibility rules as its own page,
// so a result never leads to a page the reader may not open.
const { all, searchKey } = require('./db');
const { can, woScope } = require('./access');
const { PEOPLE_VIEW } = require('./perm');

const LIMIT = 8;
const WO_ACTIVE_FIRST = "CASE w.status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'pending_closure' THEN 2 ELSE 3 END";

// Every word must appear in at least one of the columns (Arabic letter variants and case ignored)
function match(cols, terms) {
  return {
    sql: terms.map(() => `(${cols.map((c) => `skey(${c}) LIKE ? ESCAPE '\\'`).join(' OR ')})`).join(' AND '),
    params: terms.flatMap((t) => cols.map(() => t)),
  };
}

const terms = (q) => searchKey(q).split(/\s+/).filter(Boolean).slice(0, 5).map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`);

/** Groups of results: { key, icon, total (capped at LIMIT + 1), rows: [{ href, code, title, sub, status }], more } */
function search(q, user, h) {
  const words = terms(q || '');
  if (!words.length || String(q).trim().length < 2) return [];
  const { t, nm, lbl } = h;
  const enc = encodeURIComponent(String(q).trim());
  const out = [];
  const add = (key, icon, rows, more) => { if (rows.length) out.push({ key, icon, rows: rows.slice(0, LIMIT), more: rows.length > LIMIT ? more : null }); };

  // Work orders (same scope as the work-order list)
  {
    const m = match(['w.wo_number', 'w.title', 'w.location', 'w.description', 'a.code', 'a.name_ar', 'a.name_en'], words);
    const sc = woScope(user);
    const rows = all(`SELECT w.id, w.wo_number, w.title, w.status, w.priority, w.location, w.planned_start, s.code section_code FROM work_orders w
      LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN org_units s ON s.id = w.section_id
      WHERE ${m.sql}${sc.sql ? ' AND ' + sc.sql : ''} ORDER BY ${WO_ACTIVE_FIRST}, w.planned_start DESC LIMIT ${LIMIT + 1}`, ...m.params, ...sc.params);
    add('work_orders', 'clipboard', rows.map((w) => ({ href: `/wo/${w.id}`, code: w.wo_number, title: w.title, sub: [w.section_code, w.location, h.fmt(w.planned_start, false)].filter(Boolean), status: lbl('wo_status', w.status), tone: w.status })), `/wo?q=${enc}`);
  }

  // Daily tasks: dispatchers see all, others their own
  {
    const m = match(['t.title', 't.details', 't.location'], words);
    const mine = can(user, 'tasks.dispatch') === true ? '' : ' AND (t.id IN (SELECT task_id FROM task_assignees WHERE employee_id = ?) OR t.created_by = ?)';
    const rows = all(`SELECT t.id, t.title, t.task_date, t.start_time, t.status, s.code section_code FROM tasks t LEFT JOIN org_units s ON s.id = t.section_id
      WHERE ${m.sql}${mine} ORDER BY t.task_date DESC LIMIT ${LIMIT + 1}`, ...m.params, ...(mine ? [user.id, user.id] : []));
    add('daily_tasks', 'tasks', rows.map((r) => ({ href: `/tasks?day=${r.task_date}`, code: r.task_date, title: r.title, sub: [r.section_code, r.start_time].filter(Boolean), status: t('task_' + r.status), tone: r.status })), null);
  }

  // Employees: only for roles that may open profiles
  if (PEOPLE_VIEW.includes(user.role)) {
    const m = match(['e.employee_no', 'e.name_ar', 'e.name_en', 'e.email', 'e.phone', 'e.job_title_ar', 'e.job_title_en'], words);
    const rows = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.job_title_ar, e.job_title_en, e.role, e.status, s.code section_code FROM employees e
      LEFT JOIN org_units s ON s.id = e.section_id WHERE ${m.sql} ORDER BY e.status = 'active' DESC, e.employee_no LIMIT ${LIMIT + 1}`, ...m.params);
    add('employees', 'users', rows.map((e) => ({ href: `/employees/${e.id}`, code: e.employee_no, title: nm(e), sub: [h.lang === 'en' ? e.job_title_en || e.job_title_ar : e.job_title_ar || e.job_title_en, e.section_code].filter(Boolean), status: e.status === 'active' ? '' : lbl('emp_status', e.status), tone: e.status })), `/employees?q=${enc}`);
  }

  // Materials and tools
  {
    const m = match(['i.code', 'i.inventory_no', 'i.name_ar', 'i.name_en', 'i.supplier', 'i.location', 'i.category'], words);
    const rows = all(`SELECT i.id, i.code, i.inventory_no, i.name_ar, i.name_en, i.kind, i.quantity, i.uom, i.status FROM items i WHERE ${m.sql} ORDER BY i.status = 'active' DESC, i.code LIMIT ${LIMIT + 1}`, ...m.params);
    add('materials_tools', 'boxes', rows.map((i) => ({ href: `/materials/${i.id}`, code: i.code, title: nm(i), sub: [lbl('kind', i.kind), i.inventory_no, `${i.quantity} ${lbl('uom', i.uom)}`].filter(Boolean), status: i.status === 'active' ? '' : t('inactive'), tone: i.status })), `/materials?q=${enc}`);
  }

  // Vehicles
  {
    const m = match(['q.code', 'q.plate_number', 'q.name', 'q.make_model'], words);
    const rows = all(`SELECT q.id, q.code, q.plate_number, q.name, q.make_model, q.vehicle_type, q.status FROM equipment q WHERE q.type = 'vehicle' AND ${m.sql} ORDER BY q.code LIMIT ${LIMIT + 1}`, ...m.params);
    add('fleet', 'truck', rows.map((v) => ({ href: `/fleet/${v.id}`, code: v.plate_number || v.code, title: v.make_model || v.name, sub: [v.code, v.vehicle_type ? lbl('vehicle', v.vehicle_type) : ''].filter(Boolean), status: lbl('equip_status', v.status), tone: v.status })), `/fleet?q=${enc}`);
  }

  // Devices and safety equipment
  {
    const m = match(['q.code', 'q.name', 'q.location'], words);
    const rows = all(`SELECT q.id, q.code, q.name, q.type, q.status, q.location FROM equipment q WHERE q.type <> 'vehicle' AND ${m.sql} ORDER BY q.code LIMIT ${LIMIT + 1}`, ...m.params);
    add('devices', 'wrench', rows.map((q) => ({ href: `/equipment?find=${encodeURIComponent(q.code)}`, code: q.code, title: q.name, sub: [lbl('equip_type', q.type), q.location].filter(Boolean), status: lbl('equip_status', q.status), tone: q.status })), null);
  }

  // Network assets
  {
    const m = match(['a.code', 'a.name_ar', 'a.name_en', 'a.line_code', 'a.region'], words);
    const rows = all(`SELECT a.id, a.code, a.name_ar, a.name_en, a.type, a.voltage_kv, a.region FROM assets a WHERE ${m.sql} ORDER BY a.code LIMIT ${LIMIT + 1}`, ...m.params);
    add('assets', 'tower', rows.map((a) => ({ href: `/assets?q=${encodeURIComponent(a.code)}`, code: a.code, title: nm(a), sub: [lbl('asset_type', a.type), a.voltage_kv ? a.voltage_kv + ' kV' : '', a.region].filter(Boolean) })), `/assets?q=${enc}`);
  }

  // Training courses
  {
    const m = match(['c.code', 'c.title_ar', 'c.title_en', 'c.provider', 'c.city', 'c.country'], words);
    const rows = all(`SELECT c.id, c.code, c.title_ar, c.title_en, c.start_date, c.city, c.status, c.scope FROM courses c WHERE ${m.sql} ORDER BY c.start_date DESC LIMIT ${LIMIT + 1}`, ...m.params);
    add('training', 'file', rows.map((c) => ({ href: `/training/${c.id}`, code: c.code, title: h.lang === 'en' ? c.title_en || c.title_ar : c.title_ar || c.title_en, sub: [h.fmt(c.start_date, false), c.city].filter(Boolean), status: t('cs_' + c.status), tone: c.status })), null);
  }

  // Documents on work orders, vehicles and employees the reader may open
  {
    const D = require('./documents');
    const m = match(['d.title', 'd.doc_no', 'd.original_name', 'd.notes'], words);
    const cands = all(`SELECT d.id, d.entity, d.entity_id, d.doc_type, d.title, d.doc_no, d.original_name, d.expiry_date FROM documents d
      WHERE d.deleted_at IS NULL AND ${m.sql} ORDER BY d.id DESC LIMIT 60`, ...m.params);
    const seen = new Map();
    const rows = [];
    for (const d of cands) {
      const k = `${d.entity}:${d.entity_id}`;
      if (!seen.has(k)) { const rec = D.target(d.entity, d.entity_id); seen.set(k, { rec, view: D.rights(d.entity, rec, user).view }); }
      const { rec, view } = seen.get(k);
      if (!view) continue;
      const owner = d.entity === 'work_order' ? rec.wo_number : d.entity === 'vehicle' ? rec.plate_number || rec.code : `${rec.employee_no} · ${nm(rec)}`;
      rows.push({ href: `/documents/${d.id}`, external: true, code: d.doc_no || '', title: d.title || d.original_name, sub: [t('dt_' + d.doc_type), owner].filter(Boolean),
        parent: d.entity === 'work_order' ? `/wo/${d.entity_id}` : d.entity === 'vehicle' ? `/fleet/${d.entity_id}` : `/employees/${d.entity_id}#documents` });
      if (rows.length > LIMIT) break;
    }
    add('documents', 'file', rows, null);
  }

  // Organisation units
  {
    const m = match(['o.code', 'o.name_ar', 'o.name_en'], words);
    const rows = all(`SELECT o.id, o.code, o.name_ar, o.name_en, o.level FROM org_units o WHERE ${m.sql} ORDER BY o.code LIMIT ${LIMIT + 1}`, ...m.params);
    add('org_units', 'network', rows.map((o) => ({ href: `/org#u${o.id}`, code: o.code, title: nm(o), sub: [lbl('level', o.level)] })), null);
  }
  return out;
}

module.exports = { search, LIMIT };

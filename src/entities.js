'use strict';
const { all, get, run } = require('./db');
const { localToUtc, utcToLocalInput, audit, hashPassword } = require('./util');
const wo = require('./workorders');

const ROLES = ['employee', 'team_leader', 'foreman', 'section_head', 'division_manager', 'department_manager', 'sector_head', 'hr', 'safety', 'warehouse', 'admin', 'auditor'];
const MANAGERS = ['section_head', 'division_manager', 'department_manager', 'sector_head'];
const WO_TYPES = ['preventive', 'corrective', 'inspection', 'tower_inspection', 'critical', 'contractor_supervision', 'other'];
const PRIORITIES = ['normal', 'C1', 'C2', 'C3', 'C4'];
const RESULTS = ['complete', 'partial', 'temporary', 'follow_up', 'unsuccessful'];
const LEAVE_TYPES = ['annual', 'sick', 'emergency', 'training', 'workshop', 'factory_test', 'permission', 'business_travel', 'other'];
// Types that are delivered either remotely or in person
const MODE_TYPES = ['training', 'workshop'];
const MODES = ['remote', 'in_person'];
const ASSET_TYPES = ['line', 'tower', 'substation', 'cable', 'equipment', 'facility'];
const EQUIP_TYPES = ['vehicle', 'thermal_camera', 'binoculars', 'test_set', 'fault_locator', 'communications', 'crane', 'tool', 'other'];
const EQUIP_STATUS = ['available', 'under_maintenance', 'out_of_service'];
const VEHICLE_TYPES = ['pickup_4x4', 'crew_cab', 'bucket_truck', 'crane_truck', 'line_truck', 'van', 'sedan', 'trailer', 'other'];
const MAT_SOURCES = ['warehouse', 'site_stock', 'emergency_stock', 'contractor'];
const ITEM_UOMS = ['piece', 'meter', 'kg', 'liter', 'set', 'roll', 'box', 'pair'];

// ---------- value normalization (Excel cells can be objects, numbers, Dates) ----------
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    return String(v);
  }
  return typeof v === 'string' ? v.trim() : v;
}
const str = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '').trim());
function dateOnly(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new Error(`invalid date "${s}" (use YYYY-MM-DD)`);
}
// Excel stores datetimes without timezone; exceljs hands them back as UTC Dates
// carrying the wall-clock value, which we interpret as Riyadh time.
function dateTime(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return localToUtc(v.toISOString().slice(0, 19));
  return localToUtc(String(v).trim());
}
function num(v, field) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${field}: not a number`);
  return n;
}
function oneOf(v, list, field) {
  const s = str(v);
  if (!s) return null;
  if (!list.includes(s)) throw new Error(`${field}: "${s}" not in [${list.join(', ')}]`);
  return s;
}
const yesNo = (v, field) => {
  const s = str(v).toLowerCase();
  if (!s) return null;
  if (['yes', 'y', 'نعم', '1', 'true'].includes(s)) return 'yes';
  if (['no', 'n', 'لا', '0', 'false'].includes(s)) return 'no';
  throw new Error(`${field}: use yes/no`);
};
const bool = (v) => ['yes', 'y', 'نعم', '1', 'true'].includes(str(v).toLowerCase());

const empByNo = (no) => (no ? get('SELECT * FROM employees WHERE employee_no = ?', str(no)) : null);
const unitByCode = (c) => (c ? get('SELECT * FROM org_units WHERE code = ?', str(c)) : null);
function mustEmp(no, field) { const e = empByNo(no); if (!e) throw new Error(`${field}: employee "${no}" not found`); return e; }
function mustUnit(c, field) { const u = unitByCode(c); if (!u) throw new Error(`${field}: unit "${c}" not found`); return u; }

// Validate each field, collecting every error instead of stopping at the first
function collect(row, fns) {
  const data = {}, errors = [];
  for (const [k, fn] of Object.entries(fns)) {
    try { data[k] = fn(row[k]); } catch (e) { errors.push(e.message); }
  }
  return { data, errors };
}
const required = (fn, field) => (v) => { const r = fn(v); if (r === null || r === '' || r === undefined) throw new Error(`${field}: required`); return r; };
const text = (v) => str(v) || null;

const ENTITIES = {
  org_units: {
    label: 'org_units', key: 'code', importRoles: ['admin', 'hr'], exportRoles: ['admin', 'hr', 'auditor'],
    columns: [
      ['code', 'رمز الوحدة (فريد)', 'Unit code (unique)', true],
      ['level', 'المستوى: company/sector/region/department/division/section/team', 'Level', true],
      ['name_ar', 'الاسم بالعربية', 'Arabic name', true],
      ['name_en', 'الاسم بالإنجليزية', 'English name', true],
      ['parent_code', 'رمز الوحدة الأعلى', 'Parent unit code'],
      ['manager_no', 'الرقم الوظيفي للمدير', 'Manager employee ID'],
    ],
    exportRows: () => all(`SELECT u.code, u.level, u.name_ar, u.name_en, p.code parent_code, e.employee_no manager_no
      FROM org_units u LEFT JOIN org_units p ON p.id = u.parent_id LEFT JOIN employees e ON e.id = u.manager_id ORDER BY u.id`),
    validate(row) {
      const r = collect(row, {
        code: required(text, 'code'),
        level: required((v) => oneOf(v, ['company', 'sector', 'region', 'department', 'division', 'section', 'team'], 'level'), 'level'),
        name_ar: required(text, 'name_ar'), name_en: required(text, 'name_en'),
        parent_id: (v) => (str(row.parent_code) ? mustUnit(row.parent_code, 'parent_code').id : null),
        manager_id: () => (str(row.manager_no) ? mustEmp(row.manager_no, 'manager_no').id : null),
      });
      r.mode = r.data.code && unitByCode(r.data.code) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      const before = unitByCode(d.code);
      if (mode === 'update') run('UPDATE org_units SET level=?, name_ar=?, name_en=?, parent_id=?, manager_id=? WHERE code=?', d.level, d.name_ar, d.name_en, d.parent_id, d.manager_id, d.code);
      else run('INSERT INTO org_units(code, level, name_ar, name_en, parent_id, manager_id) VALUES (?,?,?,?,?,?)', d.code, d.level, d.name_ar, d.name_en, d.parent_id, d.manager_id);
      audit(req, 'import', 'org_unit', d.code, before, d);
    },
  },

  employees: {
    label: 'employees', key: 'employee_no', importRoles: ['admin', 'hr'], exportRoles: ['admin', 'hr', 'auditor', ...MANAGERS],
    columns: [
      ['employee_no', 'الرقم الوظيفي (المعرف الأساسي)', 'Employee ID (primary key)', true],
      ['name_ar', 'الاسم بالعربية', 'Arabic name', true],
      ['name_en', 'الاسم بالإنجليزية', 'English name'],
      ['email', 'البريد الإلكتروني (لإرسال أوامر العمل والتنبيهات)', 'Email (work orders & alerts are sent here)'],
      ['phone', 'الهاتف', 'Phone'],
      ['nationality', 'الجنسية', 'Nationality'],
      ['section_code', 'رمز القسم مثل H1', 'Section code e.g. H1'],
      ['job_title_ar', 'المسمى الوظيفي بالعربية', 'Job title (Arabic)'],
      ['job_title_en', 'المسمى الوظيفي بالإنجليزية', 'Job title (English)'],
      ['grade', 'المرتبة', 'Grade'],
      ['hire_date', 'تاريخ التعيين YYYY-MM-DD', 'Hire date YYYY-MM-DD'],
      ['employment_type', 'نوع العقد', 'Employment type'],
      ['shift', 'نظام المناوبة', 'Shift pattern'],
      ['status', 'الحالة: active/inactive', 'Status: active/inactive'],
      ['role', `الدور: ${ROLES.join('/')}`, `Role: ${ROLES.join('/')}`],
      ['email_notifications', 'استلام البريد yes/no', 'Email notifications yes/no'],
      ['initial_password', 'كلمة مرور أولية (للموظفين الجدد فقط)', 'Initial password (new employees only)'],
    ],
    exportRows: (q, user) => all(`SELECT e.employee_no, e.name_ar, e.name_en, e.email, e.phone, e.nationality, s.code section_code, e.job_title_ar, e.job_title_en,
        e.grade, e.hire_date, e.employment_type, e.shift, e.status, e.role, CASE e.email_notifications WHEN 1 THEN 'yes' ELSE 'no' END email_notifications
        FROM employees e LEFT JOIN org_units s ON s.id = e.section_id ORDER BY e.employee_no`)
      .map((r) => (['admin', 'hr'].includes(user.role) ? r : { ...r, phone: r.phone ? '****' + String(r.phone).slice(-3) : '' })),
    validate(row) {
      const r = collect(row, {
        employee_no: required(text, 'employee_no'), name_ar: required(text, 'name_ar'), name_en: text,
        email: (v) => { const s = str(v); if (s && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw new Error('email: invalid'); return s || null; },
        phone: text, nationality: text,
        section_id: (v) => (str(row.section_code) ? mustUnit(row.section_code, 'section_code').id : null),
        job_title_ar: text, job_title_en: text, grade: text, hire_date: dateOnly, employment_type: text, shift: text,
        status: (v) => oneOf(v, ['active', 'inactive'], 'status') || 'active',
        role: (v) => oneOf(v, ROLES, 'role') || 'employee',
        email_notifications: (v) => (str(v) ? (yesNo(v, 'email_notifications') === 'yes' ? 1 : 0) : 1),
        initial_password: text,
      });
      r.mode = r.data.employee_no && empByNo(r.data.employee_no) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      const before = empByNo(d.employee_no);
      const f = [d.name_ar, d.name_en, d.email, d.phone, d.nationality, d.section_id, d.job_title_ar, d.job_title_en, d.grade, d.hire_date, d.employment_type, d.shift, d.status, d.role, d.email_notifications];
      if (mode === 'update') {
        run(`UPDATE employees SET name_ar=?, name_en=?, email=?, phone=?, nationality=?, section_id=?, job_title_ar=?, job_title_en=?, grade=?, hire_date=?,
          employment_type=?, shift=?, status=?, role=?, email_notifications=? WHERE employee_no=?`, ...f, d.employee_no);
      } else {
        run(`INSERT INTO employees(name_ar, name_en, email, phone, nationality, section_id, job_title_ar, job_title_en, grade, hire_date, employment_type, shift, status, role,
          email_notifications, employee_no, password_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...f, d.employee_no, d.initial_password ? hashPassword(d.initial_password) : null);
      }
      const { initial_password, ...safe } = d;
      audit(req, 'import', 'employee', d.employee_no, before && { ...before, password_hash: undefined }, safe);
    },
  },

  leaves: {
    label: 'leaves', importRoles: ['admin', 'hr'], exportRoles: ['admin', 'hr', 'auditor', ...MANAGERS],
    columns: [
      ['employee_no', 'الرقم الوظيفي', 'Employee ID', true],
      ['type', `النوع: ${LEAVE_TYPES.join('/')}`, `Type: ${LEAVE_TYPES.join('/')}`, true],
      ['start_date', 'من YYYY-MM-DD', 'From YYYY-MM-DD', true],
      ['end_date', 'إلى YYYY-MM-DD', 'To YYYY-MM-DD', true],
      ['mode', 'طريقة الحضور: remote/in_person (إلزامي للدورات وورش العمل)', 'Mode: remote/in_person (required for training & workshop)'],
      ['location', 'المكان (المصنع/المدينة/الدولة)', 'Location (factory / city / country)'],
      ['status', 'الحالة: approved/pending/cancelled', 'Status: approved/pending/cancelled'],
      ['notes', 'ملاحظات', 'Notes'],
    ],
    exportRows: () => all(`SELECT e.employee_no, l.type, l.start_date, l.end_date, l.mode, l.location, l.status, l.notes FROM leaves l JOIN employees e ON e.id = l.employee_id ORDER BY l.start_date DESC`),
    validate(row) {
      const r = collect(row, {
        employee_id: () => mustEmp(row.employee_no, 'employee_no').id,
        type: required((v) => oneOf(v, LEAVE_TYPES, 'type'), 'type'),
        start_date: required(dateOnly, 'start_date'), end_date: required(dateOnly, 'end_date'),
        status: (v) => oneOf(v, ['approved', 'pending', 'cancelled'], 'status') || 'approved', notes: text,
        mode: (v) => oneOf(v, MODES, 'mode'), location: text,
      });
      if (r.data.start_date && r.data.end_date && r.data.end_date < r.data.start_date) r.errors.push('end_date before start_date');
      if (MODE_TYPES.includes(r.data.type) && !r.data.mode) r.errors.push('mode: required (remote/in_person) for training and workshop');
      if (!MODE_TYPES.includes(r.data.type)) r.data.mode = null;
      r.mode = r.data.employee_id && get('SELECT 1 FROM leaves WHERE employee_id=? AND type=? AND start_date=?', r.data.employee_id, r.data.type, r.data.start_date) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      run(`INSERT INTO leaves(employee_id, type, start_date, end_date, status, notes, mode, location) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(employee_id, type, start_date) DO UPDATE SET end_date=excluded.end_date, status=excluded.status, notes=excluded.notes, mode=excluded.mode, location=excluded.location`,
        d.employee_id, d.type, d.start_date, d.end_date, d.status, d.notes, d.mode, d.location);
      audit(req, 'import', 'leave', `${d.employee_id}:${d.type}:${d.start_date}`, null, d);
    },
  },

  acting_assignments: {
    label: 'acting', importRoles: ['admin', 'hr'], exportRoles: ['admin', 'hr', 'auditor', ...MANAGERS],
    columns: [
      ['unit_code', 'رمز الوحدة التي يُكلف بإدارتها', 'Unit code being managed', true],
      ['acting_employee_no', 'الرقم الوظيفي للمكلف', 'Acting employee ID', true],
      ['assignment_type', 'النوع: temporary/leave/training/business_travel/delegation', 'Type', true],
      ['start_at', 'البداية YYYY-MM-DD HH:MM (توقيت الرياض)', 'Start YYYY-MM-DD HH:MM (Riyadh)', true],
      ['end_at', 'النهاية YYYY-MM-DD HH:MM', 'End YYYY-MM-DD HH:MM', true],
      ['decision_no', 'رقم القرار', 'Decision no.'],
      ['approving_authority', 'جهة الاعتماد', 'Approving authority'],
      ['cancelled', 'ملغى yes/no', 'Cancelled yes/no'],
    ],
    exportRows: () => all(`SELECT u.code unit_code, e.employee_no acting_employee_no, a.assignment_type, a.start_at, a.end_at, a.decision_no, a.approving_authority,
        CASE a.cancelled WHEN 1 THEN 'yes' ELSE 'no' END cancelled FROM acting_assignments a JOIN org_units u ON u.id = a.unit_id JOIN employees e ON e.id = a.acting_employee_id ORDER BY a.start_at DESC`)
      .map((r) => ({ ...r, start_at: utcToLocalInput(r.start_at).replace('T', ' '), end_at: utcToLocalInput(r.end_at).replace('T', ' ') })),
    validate(row) {
      const r = collect(row, {
        unit_id: () => mustUnit(row.unit_code, 'unit_code').id,
        acting_employee_id: () => mustEmp(row.acting_employee_no, 'acting_employee_no').id,
        assignment_type: required((v) => oneOf(v, ['temporary', 'leave', 'training', 'business_travel', 'delegation'], 'assignment_type'), 'assignment_type'),
        start_at: required(dateTime, 'start_at'), end_at: required(dateTime, 'end_at'),
        decision_no: text, approving_authority: text, cancelled: (v) => (bool(v) ? 1 : 0),
      });
      if (r.data.start_at && r.data.end_at && r.data.end_at <= r.data.start_at) r.errors.push('end_at must be after start_at');
      r.mode = r.data.unit_id && get('SELECT 1 FROM acting_assignments WHERE unit_id=? AND acting_employee_id=? AND start_at=?', r.data.unit_id, r.data.acting_employee_id, r.data.start_at) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      if (mode === 'update') run('UPDATE acting_assignments SET assignment_type=?, end_at=?, decision_no=?, approving_authority=?, cancelled=? WHERE unit_id=? AND acting_employee_id=? AND start_at=?',
        d.assignment_type, d.end_at, d.decision_no, d.approving_authority, d.cancelled, d.unit_id, d.acting_employee_id, d.start_at);
      else run('INSERT INTO acting_assignments(unit_id, acting_employee_id, assignment_type, start_at, end_at, decision_no, approving_authority, cancelled) VALUES (?,?,?,?,?,?,?,?)',
        d.unit_id, d.acting_employee_id, d.assignment_type, d.start_at, d.end_at, d.decision_no, d.approving_authority, d.cancelled);
      audit(req, 'import', 'acting_assignment', `${d.unit_id}:${d.acting_employee_id}:${d.start_at}`, null, d);
    },
  },

  holidays: {
    label: 'holidays', importRoles: ['admin', 'hr'], exportRoles: ['*'],
    columns: [
      ['start_date', 'من YYYY-MM-DD', 'From YYYY-MM-DD', true],
      ['end_date', 'إلى YYYY-MM-DD', 'To YYYY-MM-DD'],
      ['name_ar', 'الاسم بالعربية', 'Arabic name', true],
      ['name_en', 'الاسم بالإنجليزية', 'English name', true],
      ['kind', 'النوع: public/company', 'Kind: public/company'],
      ['approximate', 'تاريخ تقريبي yes/no', 'Approximate date yes/no'],
    ],
    exportRows: () => all("SELECT start_date, end_date, name_ar, name_en, kind, CASE approximate WHEN 1 THEN 'yes' ELSE 'no' END approximate FROM holidays ORDER BY start_date"),
    validate(row) {
      const r = collect(row, {
        start_date: required(dateOnly, 'start_date'), end_date: dateOnly, name_ar: required(text, 'name_ar'), name_en: required(text, 'name_en'),
        kind: (v) => oneOf(v, ['public', 'company'], 'kind') || 'public', approximate: (v) => (bool(v) ? 1 : 0),
      });
      r.data.end_date = r.data.end_date || r.data.start_date;
      if (r.data.end_date && r.data.start_date && r.data.end_date < r.data.start_date) r.errors.push('end_date before start_date');
      r.mode = r.data.start_date && get('SELECT 1 FROM holidays WHERE start_date = ? AND name_en = ?', r.data.start_date, r.data.name_en) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      run(`INSERT INTO holidays(start_date, end_date, name_ar, name_en, kind, approximate) VALUES (?,?,?,?,?,?)
        ON CONFLICT(start_date, name_en) DO UPDATE SET end_date=excluded.end_date, name_ar=excluded.name_ar, kind=excluded.kind, approximate=excluded.approximate`,
        d.start_date, d.end_date, d.name_ar, d.name_en, d.kind, d.approximate);
      audit(req, 'import', 'holiday', `${d.start_date}:${d.name_en}`, null, d);
    },
  },

  point_requests: {
    label: 'points', importRoles: ['hr', 'safety', 'section_head', 'division_manager', 'department_manager', 'sector_head'], exportRoles: ['hr', 'admin', 'auditor', ...MANAGERS],
    columns: [
      ['employee_no', 'الرقم الوظيفي', 'Employee ID', true],
      ['rule_code', 'رمز القاعدة (انظر صفحة النقاط)', 'Rule code (see the points page)', true],
      ['reference', 'المرجع (رقم اجتماع/مخالفة/مشروع)', 'Reference (meeting / violation / project no.)'],
      ['reason', 'السبب', 'Reason', true],
    ],
    exportRows: () => all(`SELECT e.employee_no, p.rule_code, p.reference, p.reason, p.points, p.status, p.year FROM point_transactions p JOIN employees e ON e.id = p.employee_id ORDER BY p.id`),
    validate(row, req) {
      const r = collect(row, {
        employee_id: () => mustEmp(row.employee_no, 'employee_no').id,
        rule_code: required((v) => { const s = str(v); if (!get('SELECT 1 FROM point_rules WHERE code = ? AND active = 1 AND auto = 0', s)) throw new Error(`rule_code "${s}" not found or not requestable`); return s; }, 'rule_code'),
        reference: text, reason: required(text, 'reason'),
      });
      if (r.data.employee_id && req?.user?.id === r.data.employee_id) r.errors.push('cannot request points for yourself');
      r.mode = 'insert';
      return r;
    },
    // Imported rows become pending requests: they still need an approver
    apply(d, mode, req) {
      require('./points').request({ employeeIds: [d.employee_id], ruleCode: d.rule_code, reference: d.reference, reason: d.reason }, req);
    },
  },

  courses: {
    label: 'training', key: 'code', importRoles: ['hr', 'admin'], exportRoles: ['*'],
    columns: [
      ['code', 'رمز الدورة (فريد)', 'Course code (unique)', true],
      ['title_ar', 'العنوان بالعربية', 'Arabic title', true],
      ['title_en', 'العنوان بالإنجليزية', 'English title', true],
      ['scope', 'النطاق: local/international', 'Scope: local/international', true],
      ['category', 'التصنيف (انظر صفحة الدورات)', 'Category (see the training page)', true],
      ['country', 'الدولة', 'Country'],
      ['city', 'المدينة', 'City'],
      ['provider', 'الجهة المقدمة', 'Provider'],
      ['mode', 'remote/in_person', 'remote/in_person'],
      ['start_date', 'من YYYY-MM-DD', 'From YYYY-MM-DD', true],
      ['end_date', 'إلى YYYY-MM-DD', 'To YYYY-MM-DD', true],
      ['hours', 'الساعات', 'Hours'],
      ['capacity', 'السعة', 'Capacity'],
      ['cost', 'التكلفة', 'Cost'],
      ['language', 'اللغة', 'Language'],
      ['status', 'planned/completed/cancelled', 'planned/completed/cancelled'],
    ],
    exportRows: () => all('SELECT code, title_ar, title_en, scope, category, country, city, provider, mode, start_date, end_date, hours, capacity, cost, language, status FROM courses ORDER BY start_date'),
    validate(row) {
      const T = require('./training');
      const r = collect(row, {
        code: required(text, 'code'), title_ar: required(text, 'title_ar'), title_en: required(text, 'title_en'),
        scope: required((v) => oneOf(v, ['local', 'international'], 'scope'), 'scope'), category: required((v) => oneOf(v, T.CATEGORIES, 'category'), 'category'),
        country: text, city: text, provider: text, mode: (v) => oneOf(v, MODES, 'mode') || 'in_person',
        start_date: required(dateOnly, 'start_date'), end_date: required(dateOnly, 'end_date'),
        hours: (v) => num(v, 'hours'), capacity: (v) => num(v, 'capacity'), cost: (v) => num(v, 'cost'), language: text,
        status: (v) => oneOf(v, ['planned', 'completed', 'cancelled'], 'status') || 'planned',
      });
      if (!r.errors.length) r.errors.push(...T.courseErrors(r.data));
      r.mode = r.data.code && get('SELECT 1 FROM courses WHERE code = ?', r.data.code) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      const existing = get('SELECT id FROM courses WHERE code = ?', d.code);
      require('./training').saveCourse(d, req, existing ? existing.id : null);
    },
  },

  course_attendees: {
    label: 'attendees', importRoles: ['hr', 'admin'], exportRoles: ['hr', 'admin', 'auditor', ...MANAGERS],
    columns: [
      ['course_code', 'رمز الدورة', 'Course code', true],
      ['employee_no', 'الرقم الوظيفي', 'Employee ID', true],
      ['role', 'trainee/trainer/presenter/assessor', 'trainee/trainer/presenter/assessor'],
    ],
    exportRows: () => all(`SELECT c.code course_code, c.title_en, c.scope, c.start_date, c.end_date, e.employee_no, e.name_ar, a.role, a.attendance, a.result, a.score, a.certificate_no
      FROM course_attendees a JOIN courses c ON c.id = a.course_id JOIN employees e ON e.id = a.employee_id ORDER BY c.start_date, e.employee_no`),
    validate(row) {
      const r = collect(row, {
        course_id: () => { const c = get("SELECT id FROM courses WHERE code = ? AND status <> 'cancelled'", str(row.course_code)); if (!c) throw new Error(`course_code "${row.course_code}" not found`); return c.id; },
        employee_id: () => mustEmp(row.employee_no, 'employee_no').id,
        role: (v) => oneOf(v, ['trainee', 'trainer', 'presenter', 'assessor'], 'role') || 'trainee',
      });
      r.mode = 'insert';
      return r;
    },
    // Registration creates the linked training absence and emails the employee
    apply(d, mode, req) { require('./training').register(d.course_id, [d.employee_id], d.role, req); },
  },

  improvement_plans: {
    label: 'plans', importRoles: [], exportRoles: ['hr', 'admin', 'auditor', 'department_manager', 'sector_head'],
    columns: [['employee_no', '', 'Employee ID']],
    exportRows: () => all(`SELECT e.employee_no, e.name_ar, s.code section_code, p.start_year, p.trigger_rating, p.status, p.goals, p.actions,
        (SELECT GROUP_CONCAT(r.year || ':' || COALESCE(r.rating,''), ' | ') FROM plan_reviews r WHERE r.plan_id = p.id) reviews, t.code transferred_to, p.transfer_decision_no
      FROM improvement_plans p JOIN employees e ON e.id = p.employee_id LEFT JOIN org_units s ON s.id = e.section_id LEFT JOIN org_units t ON t.id = p.transfer_to_section_id ORDER BY p.status, e.employee_no`),
    validate() { return { data: {}, errors: ['export only'], mode: 'insert' }; },
    apply() {},
  },

  assets: {
    label: 'assets', key: 'code', importRoles: ['admin'], exportRoles: ['*'],
    columns: [
      ['code', 'رمز الأصل (فريد) مثل T-380-090', 'Asset code (unique)', true],
      ['type', `النوع: ${ASSET_TYPES.join('/')}`, `Type: ${ASSET_TYPES.join('/')}`, true],
      ['name_ar', 'الاسم بالعربية', 'Arabic name'],
      ['name_en', 'الاسم بالإنجليزية', 'English name'],
      ['voltage_kv', 'الجهد 115/230/380', 'Voltage kV'],
      ['line_code', 'رمز الخط', 'Line code'],
      ['region', 'المنطقة', 'Region'],
      ['lat', 'خط العرض', 'Latitude'],
      ['lng', 'خط الطول', 'Longitude'],
      ['status', 'الحالة', 'Status'],
    ],
    exportRows: () => all('SELECT code, type, name_ar, name_en, voltage_kv, line_code, region, lat, lng, status FROM assets ORDER BY code'),
    validate(row) {
      const r = collect(row, {
        code: required(text, 'code'), type: required((v) => oneOf(v, ASSET_TYPES, 'type'), 'type'), name_ar: text, name_en: text,
        voltage_kv: (v) => num(v, 'voltage_kv'), line_code: text, region: text, lat: (v) => num(v, 'lat'), lng: (v) => num(v, 'lng'),
        status: (v) => str(v) || 'in_service',
      });
      r.mode = r.data.code && get('SELECT 1 FROM assets WHERE code = ?', r.data.code) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      run(`INSERT INTO assets(code, type, name_ar, name_en, voltage_kv, line_code, region, lat, lng, status) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(code) DO UPDATE SET type=excluded.type, name_ar=excluded.name_ar, name_en=excluded.name_en, voltage_kv=excluded.voltage_kv,
        line_code=excluded.line_code, region=excluded.region, lat=excluded.lat, lng=excluded.lng, status=excluded.status`,
        d.code, d.type, d.name_ar, d.name_en, d.voltage_kv, d.line_code, d.region, d.lat, d.lng, d.status);
      audit(req, 'import', 'asset', d.code, null, d);
    },
  },

  equipment: {
    label: 'equipment', key: 'code', importRoles: ['admin', 'safety'], exportRoles: ['*'],
    columns: [
      ['code', 'رمز المعدة (فريد)', 'Equipment code (unique)', true],
      ['type', `النوع: ${EQUIP_TYPES.join('/')}`, `Type: ${EQUIP_TYPES.join('/')}`, true],
      ['name', 'الاسم', 'Name', true],
      ['status', `الحالة: ${EQUIP_STATUS.join('/')}`, `Status: ${EQUIP_STATUS.join('/')}`],
      ['location', 'الموقع', 'Location'],
      ['expiry_date', 'انتهاء الصلاحية/الاستمارة/التأمين YYYY-MM-DD', 'Expiry (licence/insurance) YYYY-MM-DD'],
      ['calibration_due', 'موعد المعايرة YYYY-MM-DD', 'Calibration due YYYY-MM-DD'],
      ['plate_number', 'رقم اللوحة (للمركبات)', 'Plate number (vehicles)'],
      ['vehicle_type', `نوع المركبة: ${VEHICLE_TYPES.join('/')}`, `Vehicle type: ${VEHICLE_TYPES.join('/')}`],
      ['make_model', 'الصنع والطراز', 'Make & model'],
      ['model_year', 'سنة الصنع', 'Model year'],
      ['seats', 'عدد المقاعد', 'Seats'],
      ['section_code', 'القسم المخصصة له', 'Assigned section code'],
    ],
    exportRows: () => all(`SELECT q.code, q.type, q.name, q.status, q.location, q.expiry_date, q.calibration_due, q.plate_number, q.vehicle_type, q.make_model, q.model_year, q.seats, s.code section_code
      FROM equipment q LEFT JOIN org_units s ON s.id = q.section_id ORDER BY q.type = 'vehicle' DESC, q.code`),
    validate(row) {
      const r = collect(row, {
        code: required(text, 'code'), type: required((v) => oneOf(v, EQUIP_TYPES, 'type'), 'type'), name: required(text, 'name'),
        status: (v) => oneOf(v, EQUIP_STATUS, 'status') || 'available', location: text, expiry_date: dateOnly, calibration_due: dateOnly,
        plate_number: text, vehicle_type: (v) => oneOf(v, VEHICLE_TYPES, 'vehicle_type'), make_model: text,
        model_year: (v) => num(v, 'model_year'), seats: (v) => num(v, 'seats'),
        section_id: () => (str(row.section_code) ? mustUnit(row.section_code, 'section_code').id : null),
      });
      if (r.data.type === 'vehicle' && !r.data.plate_number) r.errors.push('plate_number: required for vehicles');
      if (r.data.type === 'vehicle' && !r.data.seats) r.errors.push('seats: required for vehicles');
      r.mode = r.data.code && get('SELECT 1 FROM equipment WHERE code = ?', r.data.code) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      run(`INSERT INTO equipment(code, type, name, status, location, expiry_date, calibration_due, plate_number, vehicle_type, make_model, model_year, seats, section_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(code) DO UPDATE SET type=excluded.type, name=excluded.name, status=excluded.status, location=excluded.location,
        expiry_date=excluded.expiry_date, calibration_due=excluded.calibration_due, plate_number=excluded.plate_number, vehicle_type=excluded.vehicle_type,
        make_model=excluded.make_model, model_year=excluded.model_year, seats=excluded.seats, section_id=excluded.section_id`,
        d.code, d.type, d.name, d.status, d.location, d.expiry_date, d.calibration_due, d.plate_number, d.vehicle_type, d.make_model, d.model_year, d.seats, d.section_id);
      audit(req, 'import', 'equipment', d.code, null, d);
    },
  },

  items: {
    label: 'materials_tools', key: 'code', importRoles: ['admin', 'warehouse'], exportRoles: ['*'],
    columns: [
      ['code', 'رمز الصنف (فريد)', 'Item code (unique)', true],
      ['kind', 'النوع: material/tool/equipment (مادة/عدة/معدة)', 'Kind: material/tool/equipment', true],
      ['name_ar', 'الاسم بالعربية', 'Arabic name', true],
      ['name_en', 'الاسم بالإنجليزية', 'English name'],
      ['category', 'الفئة', 'Category'],
      ['uom', `الوحدة: ${ITEM_UOMS.join('/')}`, `Unit: ${ITEM_UOMS.join('/')}`],
      ['quantity', 'الكمية الموجودة (تُسجل كحركة مخزون)', 'Quantity on hand (recorded as a stock movement)'],
      ['min_qty', 'الحد الأدنى للتنبيه', 'Minimum (low-stock alert)'],
      ['location', 'الموقع / المستودع', 'Location / warehouse'],
      ['section_code', 'رمز القسم', 'Section code'],
      ['status', 'الحالة: active/inactive', 'Status: active/inactive'],
      ['notes', 'ملاحظات', 'Notes'],
      ['inventory_no', 'رقم المخزون (SAP)', 'Inventory number (SAP)'],
      ['reorder_qty', 'كمية إعادة الطلب', 'Reorder quantity'],
      ['supplier', 'المورد', 'Supplier'],
    ],
    exportRows: () => all(`SELECT i.code, i.kind, i.name_ar, i.name_en, i.category, i.uom, i.quantity, i.min_qty, i.location, s.code section_code, i.status, i.notes, i.inventory_no, i.reorder_qty, i.supplier
      FROM items i LEFT JOIN org_units s ON s.id = i.section_id ORDER BY i.kind, i.code`),
    validate(row) {
      const r = collect(row, {
        code: (v) => required(text, 'code')(v)?.toUpperCase(), kind: required((v) => oneOf(str(v).toLowerCase(), ['material', 'tool', 'equipment'], 'kind'), 'kind'),
        name_ar: required(text, 'name_ar'), name_en: text, category: text, uom: (v) => oneOf(str(v).toLowerCase(), ITEM_UOMS, 'uom') || 'piece',
        quantity: (v) => { const n = num(v, 'quantity'); if (n != null && n < 0) throw new Error('quantity: negative'); return n; },
        min_qty: (v) => Math.max(0, num(v, 'min_qty') || 0), location: text,
        section_id: () => (str(row.section_code) ? mustUnit(row.section_code, 'section_code').id : null),
        status: (v) => oneOf(str(v).toLowerCase(), ['active', 'inactive'], 'status') || 'active', notes: text,
        inventory_no: text, reorder_qty: (v) => num(v, 'reorder_qty'), supplier: text,
      });
      r.mode = r.data.code && get('SELECT 1 FROM items WHERE code = ?', r.data.code) ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      run(`INSERT INTO items(code, kind, name_ar, name_en, category, uom, min_qty, location, section_id, status, notes, inventory_no, reorder_qty, supplier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(code) DO UPDATE SET kind=excluded.kind, name_ar=excluded.name_ar, name_en=excluded.name_en, category=excluded.category, uom=excluded.uom,
        min_qty=excluded.min_qty, location=excluded.location, section_id=excluded.section_id, status=excluded.status, notes=excluded.notes,
        inventory_no=excluded.inventory_no, reorder_qty=excluded.reorder_qty, supplier=excluded.supplier`,
        d.code, d.kind, d.name_ar, d.name_en, d.category, d.uom, d.min_qty, d.location, d.section_id, d.status, d.notes, d.inventory_no, d.reorder_qty, d.supplier);
      const it = get('SELECT * FROM items WHERE code = ?', d.code);
      // The imported quantity becomes the stock on hand through an audited movement
      if (d.quantity != null && d.quantity !== it.quantity) {
        const delta = Math.round((d.quantity - it.quantity) * 1000) / 1000;
        run('UPDATE items SET quantity = ? WHERE id = ?', d.quantity, it.id);
        run('INSERT INTO item_movements(item_id, kind, qty, balance, note, created_by) VALUES (?,?,?,?,?,?)', it.id, mode === 'insert' ? 'receive' : 'adjust', delta, d.quantity, 'Excel import / استيراد', req.user.id);
      }
      audit(req, 'import', 'item', d.code, null, d);
    },
  },

  tasks: {
    label: 'daily_tasks', importRoles: ['admin', 'team_leader', 'foreman', 'section_head', 'division_manager', 'department_manager', 'sector_head'], exportRoles: ['*'],
    columns: [
      ['task_date', 'التاريخ YYYY-MM-DD', 'Date YYYY-MM-DD', true],
      ['start_time', 'وقت البداية HH:MM', 'Start time HH:MM'],
      ['end_time', 'وقت النهاية HH:MM', 'End time HH:MM'],
      ['title', 'عنوان المهمة', 'Task title', true],
      ['details', 'التفاصيل', 'Details'],
      ['location', 'الموقع', 'Location'],
      ['section_code', 'رمز القسم', 'Section code'],
      ['priority', 'الأولوية: normal/high/urgent', 'Priority: normal/high/urgent'],
      ['assignee_nos', 'أرقام الموظفين مفصولة بفاصلة', 'Employee IDs, comma separated', true],
      ['wo_number', 'أمر العمل المرتبط', 'Linked work order'],
      ['status', 'الحالة: open/done/cancelled', 'Status: open/done/cancelled'],
    ],
    exportRows: (q = {}) => {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '0000-00-00', to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '9999-12-31';
      return all(`SELECT t.id, t.task_date, t.start_time, t.end_time, t.title, t.details, t.location, s.code section_code, t.priority,
          (SELECT GROUP_CONCAT(e.employee_no, ',') FROM task_assignees a JOIN employees e ON e.id = a.employee_id WHERE a.task_id = t.id) assignee_nos, w.wo_number, t.status
        FROM tasks t LEFT JOIN org_units s ON s.id = t.section_id LEFT JOIN work_orders w ON w.id = t.wo_id WHERE t.task_date BETWEEN ? AND ? ORDER BY t.task_date, t.start_time`, from, to);
    },
    validate(row) {
      const time = (k) => (v) => { const x = v instanceof Date ? v.toISOString().slice(11, 16) : str(v); if (!x) return null; if (!/^\d{1,2}:\d{2}/.test(x)) throw new Error(`${k}: use HH:MM`); return x.padStart(5, '0').slice(0, 5); };
      const r = collect(row, {
        task_date: required(dateOnly, 'task_date'), start_time: time('start_time'), end_time: time('end_time'), title: required(text, 'title'), details: text, location: text,
        section_id: () => (str(row.section_code) ? mustUnit(row.section_code, 'section_code').id : null),
        priority: (v) => oneOf(str(v).toLowerCase(), ['normal', 'high', 'urgent'], 'priority') || 'normal',
        assignee_ids: () => { const nos = str(row.assignee_nos).split(/[,;\s،]+/).filter(Boolean); if (!nos.length) throw new Error('assignee_nos: required'); return nos.map((n) => mustEmp(n, 'assignee_nos').id); },
        wo_number: (v) => (str(v) ? str(v).toUpperCase() : null),
        status: (v) => oneOf(str(v).toLowerCase(), ['open', 'done', 'cancelled'], 'status') || 'open',
      });
      if (r.data.wo_number && !get('SELECT 1 FROM work_orders WHERE wo_number = ?', r.data.wo_number)) r.errors.push(`wo_number "${r.data.wo_number}" not found`);
      r.mode = 'insert';
      return r;
    },
    apply(d, mode, req) {
      require('./tasks').save({ ...d, assignee_ids: d.assignee_ids }, req);
    },
  },

  work_orders: {
    label: 'work_orders', importRoles: ['admin', 'section_head', 'division_manager', 'department_manager'], exportRoles: ['*'],
    columns: [
      ['wo_number', 'رقم أمر العمل - اتركه فارغًا ليُولَّد تلقائيًا (مسؤول النظام فقط يمكنه استيراد أرقام تاريخية)', 'Leave empty to auto-generate (admins may import historical numbers)'],
      ['type', `النوع: ${WO_TYPES.join('/')}`, `Type: ${WO_TYPES.join('/')}`, true],
      ['title', 'العنوان', 'Title', true],
      ['description', 'الوصف', 'Description'],
      ['priority', `الأولوية: ${PRIORITIES.join('/')}`, `Priority: ${PRIORITIES.join('/')}`],
      ['asset_code', 'رمز الأصل', 'Asset code'],
      ['voltage_kv', 'الجهد', 'Voltage kV'],
      ['location', 'الموقع', 'Location'],
      ['section_code', 'رمز القسم', 'Section code', true],
      ['involves_travel', 'هل تتضمن المهمة سفرًا؟ yes/no', 'Does the job involve travel? yes/no'],
      ['travel_band', 'فئة السفر: over_100 (100-200 كم) / over_200', 'Travel band: over_100 (100-200 km) / over_200'],
      ['distance_km', 'المسافة ذهابًا وعودة (كم)', 'Round-trip distance (km)'],
      ['planned_start', 'البداية YYYY-MM-DD HH:MM (الرياض)', 'Planned start YYYY-MM-DD HH:MM (Riyadh)', true],
      ['planned_end', 'النهاية YYYY-MM-DD HH:MM', 'Planned end YYYY-MM-DD HH:MM', true],
      ['team_leader_no', 'الرقم الوظيفي لقائد الفريق', 'Team leader employee ID', true],
      ['participants_nos', 'أرقام أعضاء الفريق مفصولة بفاصلة', 'Team member IDs, comma separated'],
      ['equipment_codes', 'رموز المعدات مفصولة بفاصلة', 'Equipment codes, comma separated'],
      ['materials_withdrawn', 'هل سُحبت مواد من المستودع؟ yes/no', 'Materials withdrawn from warehouse? yes/no', true],
      ['reservation_number', 'رقم الحجز (إلزامي إذا yes)', 'Reservation no. (required if yes)'],
      ['warehouse', 'المستودع', 'Warehouse'],
      ['selection_reason', 'سبب الاختيار (للمهام البعيدة)', 'Selection reason (long distance)'],
      ['overnight', 'مبيت yes/no', 'Overnight yes/no'],
      ['travel_hours', 'ساعات السفر', 'Travel hours'],
    ],
    exportColumns: ['wo_number', 'status', 'type', 'title', 'description', 'priority', 'asset_code', 'voltage_kv', 'location', 'section_code', 'involves_travel', 'distance_km', 'distance_category',
      'needs_sector_approval', 'planned_start', 'planned_end', 'due_at', 'actual_start', 'actual_end', 'arrival_at', 'restored_at', 'team_leader_no', 'participants_nos', 'equipment_codes',
      'materials_withdrawn', 'reservation_number', 'materials_used', 'result', 'action_description', 'completion_pct', 'before_photos', 'after_photos',
      'section_head_at_work', 'division_manager_at_work', 'department_manager_at_work', 'closed_at', 'cancel_reason', 'created_at', 'away_during_work'],
    exportRows: (q = {}, user) => woExportRows(q, user),
    validate(row, req) {
      const r = collect(row, {
        wo_number: (v) => {
          const s = str(v);
          if (!s) return null;
          if (req?.user?.role !== 'admin') throw new Error('wo_number: only an administrator may import existing numbers');
          if (!/^WO\d{6}$/.test(s)) throw new Error('wo_number: must be WO + 6 digits');
          if (get('SELECT 1 FROM work_orders WHERE wo_number = ?', s)) throw new Error(`wo_number: ${s} already exists`);
          return s;
        },
        type: required((v) => oneOf(v, WO_TYPES, 'type'), 'type'), title: required(text, 'title'), description: text,
        priority: (v) => oneOf(v, PRIORITIES, 'priority') || 'normal',
        asset_id: () => { if (!str(row.asset_code)) return null; const a = get('SELECT id FROM assets WHERE code = ?', str(row.asset_code)); if (!a) throw new Error(`asset_code "${row.asset_code}" not found`); return a.id; },
        voltage_kv: (v) => num(v, 'voltage_kv'), location: text,
        section_id: () => mustUnit(row.section_code, 'section_code').id,
        distance_km: (v) => num(v, 'distance_km') || 0,
        involves_travel: (v) => yesNo(v, 'involves_travel'),
        travel_band: (v) => oneOf(v, ['over_100', 'over_200'], 'travel_band'),
        planned_start: required(dateTime, 'planned_start'), planned_end: required(dateTime, 'planned_end'),
        team_leader_id: () => mustEmp(row.team_leader_no, 'team_leader_no').id,
        participant_ids: () => str(row.participants_nos).split(/[,;،\s]+/).filter(Boolean).map((no) => mustEmp(no, 'participants_nos').id),
        equipment_ids: (v) => str(row.equipment_codes).split(/[,;،\s]+/).filter(Boolean).map((c) => { const q = get('SELECT id FROM equipment WHERE code = ?', c); if (!q) throw new Error(`equipment "${c}" not found`); return q.id; }),
        materials_withdrawn: required((v) => yesNo(v, 'materials_withdrawn'), 'materials_withdrawn'),
        reservation_number: text, warehouse: text, selection_reason: text, overnight: (v) => bool(v), travel_hours: (v) => num(v, 'travel_hours'),
      });
      r.data.participant_ids = r.data.participant_ids || [];
      r.data.equipment_ids = r.data.equipment_ids || [];
      try { require('./travel').normalize(r.data); } catch (e) { r.errors.push(e.message); }
      if (r.data.materials_withdrawn === 'yes' && !r.data.reservation_number) r.errors.push('reservation_number: required when materials_withdrawn = yes');
      if (r.data.materials_withdrawn === 'no' && r.data.reservation_number) r.errors.push('reservation_number: not allowed when materials_withdrawn = no');
      if (!r.errors.length) {
        const ids = [...new Set([r.data.team_leader_id, ...r.data.participant_ids])];
        r.errors.push(...wo.availabilityErrors({ participantIds: ids, equipmentIds: r.data.equipment_ids, plannedStart: r.data.planned_start, plannedEnd: r.data.planned_end }));
      }
      r.mode = 'insert';
      return r;
    },
    apply(d, mode, req) {
      const { wo: created } = wo.createWorkOrder(d, { ...req, importing: true }, { importedNumber: d.wo_number || null });
      return created.wo_number;
    },
  },

  material_lines: {
    label: 'materials', importRoles: ['admin', 'warehouse', 'team_leader', 'foreman', 'section_head'], exportRoles: ['*'],
    columns: [
      ['wo_number', 'رقم أمر العمل', 'Work order no.', true],
      ['reservation_number', 'رقم الحجز', 'Reservation no.'],
      ['line_no', 'رقم سطر الحجز', 'Reservation line no.'],
      ['material_number', 'رقم المادة', 'Material no.', true],
      ['description', 'وصف المادة', 'Material description'],
      ['uom', 'الوحدة (قطعة/متر/كجم/لتر)', 'Unit of measure'],
      ['source', `المصدر: ${MAT_SOURCES.join('/')}`, `Source: ${MAT_SOURCES.join('/')}`],
      ['reserved_qty', 'الكمية المحجوزة', 'Reserved qty'],
      ['issued_qty', 'الكمية المصروفة', 'Issued qty'],
      ['used_qty', 'الكمية المستخدمة', 'Used qty'],
      ['returned_qty', 'الكمية المرتجعة', 'Returned qty'],
      ['damaged_qty', 'الكمية التالفة', 'Damaged qty'],
      ['transferred_qty', 'الكمية المحولة', 'Transferred qty'],
      ['transfer_wo_number', 'أمر العمل المستلم للتحويل', 'Receiving WO for transfer'],
      ['remaining_authorized_qty', 'المتبقي المعتمد', 'Authorized remaining qty'],
      ['batch', 'رقم الدفعة', 'Batch/lot'],
      ['serial', 'الرقم التسلسلي', 'Serial no.'],
      ['install_location', 'موقع التركيب', 'Installation location'],
      ['damage_reason', 'سبب التلف', 'Damage reason'],
    ],
    exportRows: () => all(`SELECT w.wo_number, r.reservation_number, m.line_no, m.material_number, m.description, m.uom, m.source, m.reserved_qty, m.issued_qty, m.used_qty,
        m.returned_qty, m.damaged_qty, m.transferred_qty, m.transfer_wo_number, m.remaining_authorized_qty, m.batch, m.serial, m.install_location, m.damage_reason
        FROM material_lines m JOIN work_orders w ON w.id = m.wo_id LEFT JOIN material_reservations r ON r.id = m.reservation_id ORDER BY w.wo_number, m.id`),
    validate(row) {
      const q = (k) => (v) => { const n = num(v, k); if (n != null && n < 0) throw new Error(`${k}: negative`); return n ?? 0; };
      const r = collect(row, {
        wo: () => {
          const w = get('SELECT * FROM work_orders WHERE wo_number = ?', str(row.wo_number));
          if (!w) throw new Error(`wo_number "${row.wo_number}" not found`);
          if (['closed', 'cancelled'].includes(w.status)) throw new Error(`${w.wo_number} is ${w.status}; material transactions are locked`);
          return w;
        },
        reservation_number: text, line_no: text, material_number: required(text, 'material_number'), description: text, uom: text,
        source: (v) => oneOf(v, MAT_SOURCES, 'source') || 'warehouse',
        reserved_qty: q('reserved_qty'), issued_qty: q('issued_qty'), used_qty: q('used_qty'), returned_qty: q('returned_qty'),
        damaged_qty: q('damaged_qty'), transferred_qty: q('transferred_qty'), transfer_wo_number: text, remaining_authorized_qty: q('remaining_authorized_qty'),
        batch: text, serial: text, install_location: text, damage_reason: text,
      });
      const d = r.data;
      if (d.wo && d.reservation_number) {
        const res = get('SELECT * FROM material_reservations WHERE reservation_number = ?', d.reservation_number);
        if (res && res.wo_id !== d.wo.id) r.errors.push(`reservation ${d.reservation_number} belongs to another work order`);
        if (!res && d.wo.materials_withdrawn !== 'yes') r.errors.push(`${d.wo.wo_number} has materials_withdrawn = no`);
      }
      if (d.source === 'warehouse' && !d.reservation_number) r.errors.push('reservation_number required for warehouse materials');
      if (d.damaged_qty > 0 && !d.damage_reason) r.errors.push('damage_reason required when damaged_qty > 0');
      r.mode = d.wo && get('SELECT 1 FROM material_lines WHERE wo_id = ? AND material_number = ? AND IFNULL(line_no,\'\') = ?', d.wo.id, d.material_number, d.line_no || '') ? 'update' : 'insert';
      return r;
    },
    apply(d, mode, req) {
      let resId = null;
      if (d.reservation_number) {
        const res = get('SELECT id FROM material_reservations WHERE reservation_number = ?', d.reservation_number);
        resId = res ? res.id : Number(run('INSERT INTO material_reservations(wo_id, reservation_number, is_primary) VALUES (?,?,0)', d.wo.id, d.reservation_number).lastInsertRowid);
      }
      const vals = [resId, d.description, d.uom, d.source, d.reserved_qty, d.issued_qty, d.used_qty, d.returned_qty, d.damaged_qty, d.transferred_qty, d.transfer_wo_number,
        d.remaining_authorized_qty, d.batch, d.serial, d.install_location, d.damage_reason, req.user.id];
      if (mode === 'update') {
        run(`UPDATE material_lines SET reservation_id=?, description=?, uom=?, source=?, reserved_qty=?, issued_qty=?, used_qty=?, returned_qty=?, damaged_qty=?, transferred_qty=?,
          transfer_wo_number=?, remaining_authorized_qty=?, batch=?, serial=?, install_location=?, damage_reason=?, recorded_by=? WHERE wo_id=? AND material_number=? AND IFNULL(line_no,'')=?`,
          ...vals, d.wo.id, d.material_number, d.line_no || '');
      } else {
        run(`INSERT INTO material_lines(reservation_id, description, uom, source, reserved_qty, issued_qty, used_qty, returned_qty, damaged_qty, transferred_qty,
          transfer_wo_number, remaining_authorized_qty, batch, serial, install_location, damage_reason, recorded_by, wo_id, material_number, line_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ...vals, d.wo.id, d.material_number, d.line_no);
      }
      const { wo: w, ...rest } = d;
      audit(req, 'import', 'material_line', `${w.wo_number}:${d.material_number}:${d.line_no || ''}`, null, rest);
    },
  },
};

function woExportRows(q = {}, user) {
  const { where, params } = woFilterSql(q, user);
  const rows = all(`SELECT w.*, a.code asset_code, s.code section_code, l.employee_no team_leader_no FROM work_orders w
    LEFT JOIN assets a ON a.id = w.asset_id LEFT JOIN org_units s ON s.id = w.section_id LEFT JOIN employees l ON l.id = w.team_leader_id
    ${where} ORDER BY w.wo_number`, ...params);
  const dt = (v) => (v ? utcToLocalInput(v).replace('T', ' ') : '');
  return rows.map((w) => {
    const o = JSON.parse(w.officials_json || '{}');
    const who = (x) => (x?.employee_no ? `${x.employee_no} ${x.name_ar}${x.acting ? ' (مكلف/acting)' : ''}` : '');
    const photos = (s) => get('SELECT COUNT(*) n FROM wo_photos WHERE wo_id = ? AND stage = ?', w.id, s).n;
    return {
      wo_number: w.wo_number, status: w.status, type: w.type, title: w.title, description: w.description, priority: w.priority, asset_code: w.asset_code,
      voltage_kv: w.voltage_kv, location: w.location, section_code: w.section_code, involves_travel: w.involves_travel, distance_km: w.distance_km, distance_category: w.distance_category,
      needs_sector_approval: w.needs_sector_approval ? 'yes' : 'no', planned_start: dt(w.planned_start), planned_end: dt(w.planned_end), due_at: dt(w.due_at),
      actual_start: dt(w.actual_start), actual_end: dt(w.actual_end), arrival_at: dt(w.arrival_at), restored_at: dt(w.restored_at), team_leader_no: w.team_leader_no,
      participants_nos: all('SELECT e.employee_no FROM wo_participants p JOIN employees e ON e.id = p.employee_id WHERE p.wo_id = ? ORDER BY e.employee_no', w.id).map((r) => r.employee_no).join(','),
      equipment_codes: all('SELECT q.code FROM wo_equipment x JOIN equipment q ON q.id = x.equipment_id WHERE x.wo_id = ?', w.id).map((r) => r.code).join(','),
      materials_withdrawn: w.materials_withdrawn, reservation_number: all('SELECT reservation_number FROM material_reservations WHERE wo_id = ?', w.id).map((r) => r.reservation_number).join(','),
      materials_used: w.materials_used, result: w.result, action_description: w.action_description, completion_pct: w.completion_pct,
      before_photos: photos('before'), after_photos: photos('after'),
      section_head_at_work: who(o.section_head), division_manager_at_work: who(o.division_manager), department_manager_at_work: who(o.department_manager),
      closed_at: dt(w.closed_at), cancel_reason: w.cancel_reason, created_at: dt(w.created_at),
      away_during_work: wo.teamAway(w).people.map((p) => `${p.employee_no} ${p.type}${p.mode ? '/' + p.mode : ''} ${p.start_date}→${p.end_date}`).join('; '),
    };
  });
}

// Shared by the list page and the export so they always match
function woFilterSql(q = {}, user) {
  const cond = [], params = [];
  if (q.status) { cond.push('w.status = ?'); params.push(q.status); }
  if (q.priority) { cond.push(q.priority === 'critical' ? "w.priority IN ('C1','C2','C3','C4')" : 'w.priority = ?'); if (q.priority !== 'critical') params.push(q.priority); }
  if (q.section) { cond.push('w.section_id = ?'); params.push(Number(q.section)); }
  if (q.type) { cond.push('w.type = ?'); params.push(q.type); }
  if (q.asset) { cond.push('w.asset_id = ?'); params.push(Number(q.asset)); }
  if (q.from) { cond.push('w.planned_start >= ?'); params.push(localToUtc(q.from)); }
  if (q.to) { cond.push('w.planned_start <= ?'); params.push(localToUtc(q.to + 'T23:59')); }
  if (q.q) { cond.push('(skey(w.wo_number) LIKE skey(?) OR skey(w.title) LIKE skey(?) OR skey(w.location) LIKE skey(?))'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (q.missing_photos) cond.push("w.status IN ('in_progress','pending_closure','closed') AND (NOT EXISTS (SELECT 1 FROM wo_photos p WHERE p.wo_id = w.id AND p.stage='before') OR NOT EXISTS (SELECT 1 FROM wo_photos p WHERE p.wo_id = w.id AND p.stage='after'))");
  if (q.mine) { cond.push('w.id IN (SELECT wo_id FROM wo_participants WHERE employee_id = ?)'); params.push(user.id); }
  if (user) { const sc = require('./access').woScope(user); if (sc.sql) { cond.push(sc.sql); params.push(...sc.params); } }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', params };
}

const canImport = (ent, user) => ENTITIES[ent]?.importRoles.includes(user.role);
const canExport = (ent, user) => { const r = ENTITIES[ent]?.exportRoles; return !!r && (r.includes('*') || r.includes(user.role)); };

module.exports = {
  ENTITIES, cellValue, woFilterSql, canImport, canExport,
  ROLES, MANAGERS, WO_TYPES, PRIORITIES, RESULTS, LEAVE_TYPES, MODE_TYPES, MODES, ASSET_TYPES, EQUIP_TYPES, EQUIP_STATUS, VEHICLE_TYPES, MAT_SOURCES,
};

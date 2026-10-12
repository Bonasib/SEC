'use strict';
// Sample data for the test environment. All people are fictional (F001-F070 from
// Appendix B of the requirements, DEMO-* for managers). Real names from Appendix A
// are intentionally NOT seeded: they must be entered after formal verification.
const { run, get, tx } = require('./db');
const { hashPassword, localToUtc, todayRiyadh } = require('./util');
const samples = require('./sample-employees.json');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@12345';

const SECTIONS = [
  ['H1', 'الخطوط الهوائية', 'Overhead Lines', 'DIV-LINES'],
  ['H2', 'الخطوط الأرضية', 'Underground Lines', 'DIV-LINES'],
  ['H3', 'التعديات والتصاريح', 'Encroachments & Permits', 'DIV-LINES'],
  ['H4', 'المرافق', 'Facilities', 'DIV-FAC'],
  ['H5', 'التشغيل الميداني', 'Field Operations', 'DIV-FAC'],
  ['H6', 'الجهد المنخفض', 'Low Voltage', 'DIV-SUB'],
  ['H7', 'القواطع الغازية', 'Gas Circuit Breakers', 'DIV-SUB'],
  ['H8', 'الحماية', 'Protection', 'DIV-SUB'],
  ['H9', 'أنظمة الحريق', 'Fire Systems', 'DIV-SUB'],
];
const TEAM_LEADERS = ['F010', 'F006', 'F014', 'F023', 'F029', 'F031', 'F035', 'F041', 'F044', 'F045'];

function seed() {
  const pw = hashPassword(DEMO_PASSWORD);
  tx(() => {
    const unit = (code, level, ar, en, parent) =>
      Number(run('INSERT INTO org_units(code, level, name_ar, name_en, parent_id) VALUES (?,?,?,?,?)', code, level, ar, en, parent ? get('SELECT id FROM org_units WHERE code = ?', parent).id : null).lastInsertRowid);
    unit('SEC-TR', 'company', 'الشركة السعودية للكهرباء - نقل الطاقة', 'Saudi Electricity Company - Transmission');
    unit('SEC-EAST', 'sector', 'قطاع النقل - الشرقية (تجريبي)', 'Transmission Sector - East (sample)', 'SEC-TR');
    unit('REG-AHSA', 'region', 'منطقة الأحساء', 'Al-Ahsa Region', 'SEC-EAST');
    unit('DEP-AM-AHSA', 'department', 'إدارة صيانة الأصول بالأحساء', 'Al-Ahsa Asset Maintenance Department', 'REG-AHSA');
    unit('DIV-LINES', 'division', 'دائرة الخطوط', 'Lines Division', 'DEP-AM-AHSA');
    unit('DIV-SUB', 'division', 'دائرة المحطات والحماية', 'Substations & Protection Division', 'DEP-AM-AHSA');
    unit('DIV-FAC', 'division', 'دائرة المرافق والتشغيل', 'Facilities & Operations Division', 'DEP-AM-AHSA');
    for (const [code, ar, en, div] of SECTIONS) unit(code, 'section', `قسم ${ar}`, `${en} Section`, div);

    const emp = (no, ar, en, role, sectionCode, title, extra = {}) =>
      Number(run(`INSERT INTO employees(employee_no, name_ar, name_en, email, nationality, section_id, job_title_en, job_title_ar, role, password_hash, is_sample, phone)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`, no, ar, en, `${no.toLowerCase()}@example.com`, extra.nationality || 'Saudi',
      sectionCode ? get('SELECT id FROM org_units WHERE code = ?', sectionCode).id : null, title, extra.title_ar || null, role, pw, extra.phone || null).lastInsertRowid);
    const setManager = (unitCode, empId) => run('UPDATE org_units SET manager_id = ? WHERE code = ?', empId, unitCode);

    setManager('SEC-EAST', emp('DEMO-SH', 'رئيس القطاع (تجريبي)', 'Sector Head (demo)', 'sector_head', null, 'Sector Head'));
    setManager('DEP-AM-AHSA', emp('DEMO-DM', 'مدير الإدارة (تجريبي)', 'Department Manager (demo)', 'department_manager', null, 'Department Manager'));
    setManager('DIV-LINES', emp('DEMO-DV1', 'مدير دائرة الخطوط (تجريبي)', 'Lines Division Manager (demo)', 'division_manager', null, 'Division Manager'));
    setManager('DIV-SUB', emp('DEMO-DV2', 'مدير دائرة المحطات (تجريبي)', 'Substations Division Manager (demo)', 'division_manager', null, 'Division Manager'));
    setManager('DIV-FAC', emp('DEMO-DV3', 'مدير دائرة المرافق (تجريبي)', 'Facilities Division Manager (demo)', 'division_manager', null, 'Division Manager'));
    for (const [code, ar, en] of SECTIONS) setManager(code, emp(`DEMO-${code}`, `رئيس قسم ${ar} (تجريبي)`, `${en} Section Head (demo)`, 'section_head', code, 'Section Head'));
    emp('DEMO-HR', 'الموارد البشرية (تجريبي)', 'HR Officer (demo)', 'hr', null, 'HR Officer');
    emp('DEMO-SAF', 'مسؤول السلامة (تجريبي)', 'Safety Officer (demo)', 'safety', null, 'Safety Officer');
    emp('DEMO-WH', 'أمين المستودع (تجريبي)', 'Warehouse Keeper (demo)', 'warehouse', null, 'Warehouse Keeper');
    emp('DEMO-AUD', 'المدقق (تجريبي)', 'Auditor (demo)', 'auditor', null, 'Auditor');
    emp('admin', 'مشغل النظام', 'System Administrator', 'admin', null, 'System Administrator');

    for (const s of samples) {
      emp(s.id, s.name_ar, null, TEAM_LEADERS.includes(s.id) ? 'team_leader' : 'employee', s.section, s.title_en, { nationality: s.nationality });
    }
    run("UPDATE employees SET name_en = employee_no || ' (sample)' WHERE name_en IS NULL");

    // Assets: a 380 kV line with towers 001-150, two 230/115 kV lines, substations
    const asset = (code, type, ar, en, kv, line, lat, lng) =>
      run('INSERT INTO assets(code, type, name_ar, name_en, voltage_kv, line_code, region, lat, lng) VALUES (?,?,?,?,?,?,?,?,?)', code, type, ar, en, kv, line, 'Al-Ahsa', lat, lng);
    asset('L-380-01', 'line', 'خط 380 ك.ف الأحساء - الدمام (تجريبي)', '380 kV Al-Ahsa - Dammam line (sample)', 380, 'L-380-01', 25.38, 49.58);
    asset('L-230-02', 'line', 'خط 230 ك.ف الهفوف - العيون (تجريبي)', '230 kV Hofuf - Uyun line (sample)', 230, 'L-230-02', 25.6, 49.55);
    asset('L-115-03', 'line', 'خط 115 ك.ف المبرز (تجريبي)', '115 kV Mubarraz line (sample)', 115, 'L-115-03', 25.41, 49.59);
    for (let i = 1; i <= 150; i++) {
      const n = String(i).padStart(3, '0');
      asset(`T-380-01-${n}`, 'tower', `برج ${n} - خط 380`, `Tower ${n} - 380 kV line`, 380, 'L-380-01', +(25.38 + i * 0.004).toFixed(5), +(49.58 + i * 0.003).toFixed(5));
    }
    asset('SS-AHSA-380', 'substation', 'محطة الأحساء 380 (تجريبي)', 'Al-Ahsa 380 kV Substation (sample)', 380, null, 25.37, 49.57);
    asset('SS-HOFUF-115', 'substation', 'محطة الهفوف 115 (تجريبي)', 'Hofuf 115 kV Substation (sample)', 115, null, 25.36, 49.59);
    asset('CB-AHSA-380-01', 'equipment', 'قاطع غازي 380-01', 'GCB 380-01', 380, null, 25.37, 49.57);

    const today = todayRiyadh();
    const plus = (d) => new Date(Date.parse(today) + d * 864e5).toISOString().slice(0, 10);
    const eq = (code, type, name, status, exp, cal) => run('INSERT INTO equipment(code, type, name, status, location, expiry_date, calibration_due) VALUES (?,?,?,?,?,?,?)', code, type, name, status, 'Al-Ahsa', exp, cal);
    const veh = (code, plate, vtype, model, seats, sec, status, exp) => run(`INSERT INTO equipment(code, type, name, status, location, expiry_date, plate_number, vehicle_type, make_model, seats, model_year, section_id)
      VALUES (?, 'vehicle', ?, ?, 'Al-Ahsa', ?, ?, ?, ?, ?, 2022, (SELECT id FROM org_units WHERE code = ?))`, code, `${model} ${plate}`, status, exp, plate, vtype, model, seats, sec);
    veh('VH-101', 'ASA 1011', 'pickup_4x4', 'Toyota Hilux', 5, 'H1', 'available', plus(200));
    veh('VH-102', 'ASA 1022', 'pickup_4x4', 'Toyota Hilux', 5, 'H1', 'available', plus(12));
    veh('VH-103', 'ASA 1033', 'crew_cab', 'Ford F-550 Crew Cab', 6, 'H2', 'under_maintenance', plus(300));
    veh('VH-104', 'ASA 1044', 'bucket_truck', 'Isuzu FVR Bucket', 3, 'H1', 'available', plus(-5));
    veh('VH-105', 'ASA 1055', 'crane_truck', 'Mercedes Actros Crane', 2, 'H1', 'available', plus(180));
    veh('VH-106', 'ASA 1066', 'line_truck', 'Volvo FMX Line Truck', 3, 'H2', 'available', plus(240));
    veh('VH-107', 'ASA 1077', 'van', 'Toyota HiAce', 12, 'H5', 'available', plus(150));
    veh('VH-108', 'ASA 1088', 'pickup_4x4', 'Nissan Patrol Pickup', 5, 'H7', 'available', plus(90));
    veh('VH-109', 'ASA 1099', 'crew_cab', 'Toyota Land Cruiser 79', 5, 'H8', 'available', plus(60));
    veh('VH-110', 'ASA 1100', 'sedan', 'Toyota Camry', 4, 'H3', 'available', plus(320));
    eq('TC-01', 'thermal_camera', 'Thermal camera FLIR-01', 'available', null, plus(120));
    eq('TC-02', 'thermal_camera', 'Thermal camera FLIR-02', 'available', null, plus(20));
    eq('BN-01', 'binoculars', 'Binoculars 10x50 - 01', 'available', null, null);
    eq('BN-02', 'binoculars', 'Binoculars 10x50 - 02', 'available', null, null);
    eq('TS-01', 'test_set', 'Relay test set - 01', 'available', null, plus(90));
    eq('FL-01', 'fault_locator', 'Cable fault locator - 01', 'available', null, plus(45));

    // A few leaves so availability rules are visible immediately
    const lv = (no, type, a, b) => run("INSERT INTO leaves(employee_id, type, start_date, end_date, status) VALUES ((SELECT id FROM employees WHERE employee_no = ?),?,?,?,'approved')", no, type, a, b);
    lv('F003', 'annual', plus(-2), plus(10));
    lv('F033', 'sick', plus(0), plus(1));
    const lv2 = (no, type, a, b, mode, location, notes) => run("INSERT INTO leaves(employee_id, type, start_date, end_date, status, mode, location, notes) VALUES ((SELECT id FROM employees WHERE employee_no = ?),?,?,?,'approved',?,?,?)", no, type, a, b, mode ?? null, location ?? null, notes || null);
    lv2('F005', 'workshop', plus(2), plus(2), 'in_person', 'Dammam', 'Live-line safety workshop');
    lv2('F009', 'workshop', plus(4), plus(5), 'remote', null, 'Digital substations webinar');
    lv2('F041', 'factory_test', plus(8), plus(12), null, 'GIS factory - Germany', 'FAT for 380 kV GIS bays');
    lv2('F039', 'factory_test', plus(15), plus(19), null, 'Breaker factory - Italy', 'FAT for SF6 breakers');
    lv2('F002', 'sick', plus(-20), plus(-18));
    lv2('F004', 'annual', plus(20), plus(34));
    lv2('F046', 'business_travel', plus(6), plus(9), null, 'Jazan');

    // Public holidays. Founding Day and National Day are fixed; Eid dates follow the
    // Hijri calendar and must be confirmed against the official announcement each year.
    const hol = (a, b, ar, en, approx) => run('INSERT INTO holidays(start_date, end_date, name_ar, name_en, kind, approximate) VALUES (?,?,?,?,?,?)', a, b, ar, en, 'public', approx);
    for (const y of [2026, 2027]) {
      hol(`${y}-02-22`, `${y}-02-22`, 'يوم التأسيس', 'Founding Day', 0);
      hol(`${y}-09-23`, `${y}-09-23`, 'اليوم الوطني', 'National Day', 0);
    }
    hol('2026-03-19', '2026-03-23', 'إجازة عيد الفطر', 'Eid al-Fitr holiday', 1);
    hol('2026-05-25', '2026-05-30', 'إجازة عيد الأضحى', 'Eid al-Adha holiday', 1);
    hol('2027-03-08', '2027-03-12', 'إجازة عيد الفطر', 'Eid al-Fitr holiday', 1);
    hol('2027-05-14', '2027-05-19', 'إجازة عيد الأضحى', 'Eid al-Adha holiday', 1);

    // Sample approved point history (fictional) so the leaderboard has something to rank
    require('./points').ensureRules();
    const year = Number(today.slice(0, 4));
    const approver = get("SELECT id FROM employees WHERE employee_no = 'DEMO-DV1'").id;
    const pts = (no, code, n, ref) => {
      const rule = get('SELECT points FROM point_rules WHERE code = ?', code);
      for (let i = 0; i < n; i++) {
        run(`INSERT INTO point_transactions(employee_id, year, rule_code, points, reference, reason, status, requested_by, decided_by, decided_at)
          VALUES ((SELECT id FROM employees WHERE employee_no = ?), ?, ?, ?, ?, 'Sample data', 'approved', ?, ?, ?)`, no, year, code, rule.points, ref, approver, approver, new Date().toISOString());
      }
    };
    pts('F010', 'project_completion', 2, 'PRJ-SAMPLE-1'); pts('F010', 'lead_drill', 2, 'DRILL-01');
    pts('F006', 'project_completion', 2, 'PRJ-SAMPLE-2'); pts('F006', 'technical_contribution', 4, 'TECH');
    pts('F044', 'project_completion', 1, 'PRJ-SAMPLE-3'); pts('F044', 'deliver_safety_meeting', 5, 'SM');
    pts('F014', 'project_completion', 1, 'PRJ-SAMPLE-4'); pts('F014', 'lesson_learned', 3, 'LL');
    pts('F001', 'wo_closed', 9, 'WO-SAMPLE'); pts('F001', 'safety_meeting_attendance', 6, 'SM');
    pts('F002', 'wo_closed', 8, 'WO-SAMPLE'); pts('F002', 'safety_meeting_attendance', 4, 'SM');
    pts('F031', 'wo_critical_closed', 4, 'WO-SAMPLE'); pts('F031', 'close_corrective_action', 2, 'CA');
    pts('F035', 'wo_closed', 5, 'WO-SAMPLE');
    pts('F045', 'lead_drill', 2, 'DRILL-02');
    pts('F012', 'technical_contribution', 6, 'TECH');
    pts('F030', 'safety_meeting_attendance', 3, 'SM');
    pts('F047', 'traffic_violation', 1, 'TRF-SAMPLE'); pts('F047', 'wo_closed', 6, 'WO-SAMPLE');
    pts('F060', 'safety_violation', 1, 'SV-SAMPLE');

    // Acting: Overhead Lines section head on leave; F010 acts for a week
    run(`INSERT INTO acting_assignments(unit_id, acting_employee_id, assignment_type, start_at, end_at, decision_no, approving_authority)
      VALUES ((SELECT id FROM org_units WHERE code='H1'), (SELECT id FROM employees WHERE employee_no='F006'), 'leave', ?, ?, 'DEC-2026-001 (sample)', 'DEMO-DM')`,
    localToUtc(plus(5) + 'T07:00'), localToUtc(plus(12) + 'T16:00'));

    run("INSERT OR REPLACE INTO sequences(name, value) VALUES ('wo', 0)");
  });
  seedPeopleModules();
  seedStockAndTasks();
  console.log(`Seeded sample data. Demo password for every account: ${DEMO_PASSWORD}`);
}

if (require.main === module) {
  if (get('SELECT 1 FROM employees LIMIT 1')) {
    console.log('Database already has data. Use `npm run reset` to wipe and reseed.');
  } else seed();
}

// Courses (from section 6.4 of the requirements), registrations, improvement plans and a sample permission.
// Runs after the main transaction because registrations open their own transactions.
function seedPeopleModules() {
  const T = require('./training');
  const hr = get("SELECT * FROM employees WHERE employee_no = 'DEMO-HR'");
  const req = { user: hr, ip: 'seed', get: () => 'seed' };
  const today = todayRiyadh();
  const plus = (d) => new Date(Date.parse(today) + d * 864e5).toISOString().slice(0, 10);
  const course = (code, ar, en, scope, cat, country, city, mode, start, days, hours, provider, status = 'planned') =>
    T.saveCourse({ code, title_ar: ar, title_en: en, scope, category: cat, country, city, mode, start_date: plus(start), end_date: plus(start + days - 1), hours, provider, capacity: scope === 'international' ? 4 : 20, language: 'ar/en', status }, req);
  const c = {
    can: course('INT-01', 'الإدارة المتقدمة لأصول نقل الطاقة', 'Advanced Transmission Asset Management', 'international', 'asset_management', 'Canada', 'Toronto', 'in_person', 75, 10, 60, 'Sample provider'),
    aus: course('INT-02', 'فحص وصيانة أبراج الجهد العالي', 'High-Voltage Tower Inspection and Maintenance', 'international', 'towers_lines', 'Australia', 'Sydney', 'in_person', 40, 12, 72, 'Sample provider'),
    chn: course('INT-03', 'تشغيل وصيانة معدات المحطات الرقمية', 'Digital Substation Equipment O&M', 'international', 'digital_substations', 'China', 'Beijing', 'in_person', -120, 14, 84, 'Sample provider', 'completed'),
    usa: course('INT-04', 'أنظمة الحماية المتقدمة وتحليل الأعطال', 'Advanced Protection and Fault Analysis', 'international', 'protection', 'USA', 'Houston', 'in_person', 30, 10, 60, 'Sample provider'),
    esp: course('INT-05', 'صيانة الكابلات الأرضية عالية الجهد', 'HV Underground Cable Maintenance', 'international', 'cables', 'Spain', 'Madrid', 'in_person', 55, 8, 48, 'Sample provider'),
    ita: course('INT-06', 'صيانة القواطع الغازية وإدارة SF6', 'SF6 / GCB Maintenance and SF6 Management', 'international', 'gcb_sf6', 'Italy', 'Milan', 'in_person', 90, 9, 54, 'Sample provider'),
    ruh: course('LOC-01', 'إدارة أصول نقل الطاقة', 'Transmission Asset Management', 'local', 'asset_management', 'Saudi Arabia', 'Riyadh', 'in_person', 0, 5, 30, 'SEC Academy'),
    jed: course('LOC-02', 'السلامة في أعمال الجهد العالي', 'High-Voltage Work Safety', 'local', 'hv_safety', 'Saudi Arabia', 'Jeddah', 'in_person', -60, 4, 24, 'SEC Academy', 'completed'),
    dmm: course('LOC-03', 'فحص الأبراج بالكاميرا الحرارية', 'Thermal Tower Inspection', 'local', 'thermal_inspection', 'Saudi Arabia', 'Dammam', 'remote', 3, 3, 18, 'SEC Academy'),
    jzn: course('LOC-04', 'الاستجابة لطوارئ الخطوط', 'Transmission Emergency Response', 'local', 'emergency', 'Saudi Arabia', 'Jazan', 'in_person', 45, 5, 30, 'SEC Academy'),
    hai: course('LOC-05', 'تشغيل الرفع والعمل على الارتفاعات', 'Lifting and Working at Height', 'local', 'lifting_height', 'Saudi Arabia', 'Hail', 'in_person', 21, 6, 36, 'SEC Academy'),
    ahs: course('LOC-06', 'تحليل مخاطر العمل', 'Job Hazard Analysis', 'local', 'job_hazard', 'Saudi Arabia', 'Al-Ahsa', 'in_person', 25, 2, 12, 'SEC Academy'),
    mak: course('LOC-07', 'إدارة فرق الصيانة الميدانية', 'Field Maintenance Team Management', 'local', 'team_management', 'Saudi Arabia', 'Makkah', 'in_person', 65, 4, 24, 'SEC Academy'),
    fire: course('LOC-08', 'صيانة أنظمة الحريق والإطفاء', 'Fire System Maintenance', 'local', 'fire_systems', 'Saudi Arabia', 'Dammam', 'remote', 35, 3, 18, 'SEC Academy'),
  };
  const id = (no) => get('SELECT id FROM employees WHERE employee_no = ?', no).id;
  // Past courses: register and mark attendance/results
  const pastReg = (courseId, nos, results) => {
    for (const no of nos) {
      run(`INSERT INTO course_attendees(course_id, employee_id, attendance, result, score, certificate_no, registered_by) VALUES (?,?,?,?,?,?,?)`,
        courseId, id(no), 'attended', results[no] || 'pass', results[no] === 'fail' ? 58 : 86, results[no] === 'fail' ? null : `CERT-${no}-${courseId}`, hr.id);
      const co = get('SELECT * FROM courses WHERE id = ?', courseId);
      run(`INSERT OR IGNORE INTO leaves(employee_id, type, start_date, end_date, status, mode, location, notes, course_id) VALUES (?, 'training', ?, ?, 'approved', ?, ?, ?, ?)`,
        id(no), co.start_date, co.end_date, co.mode, T.placeOf(co), co.title_en, courseId);
    }
  };
  pastReg(c.chn, ['F039', 'F041'], {});
  pastReg(c.jed, ['F013', 'F015', 'F018', 'F049'], { F049: 'fail' });
  // Upcoming courses go through the normal registration (creates linked absences + emails)
  T.register(c.ruh, [id('F012'), id('F026')], 'trainee', req);
  T.register(c.dmm, [id('F007')], 'trainee', req);
  T.register(c.usa, [id('F044')], 'trainee', req);
  T.register(c.aus, [id('F065')], 'trainee', req);
  T.register(c.hai, [id('F046'), id('F053')], 'trainee', req);

  // An older improvement plan close to its 3-year limit (sample), then plans from current ratings
  const pl = run(`INSERT INTO improvement_plans(employee_id, start_year, trigger_rating, goals, actions, coach_id, created_by)
    VALUES (?, ?, 'acceptable', ?, ?, (SELECT id FROM employees WHERE employee_no = 'DEMO-H1'), ?)`, id('F047'), Number(today.slice(0, 4)) - 2,
  'رفع الأداء إلى تقدير "جيد" / Reach a "Good" rating\nصفر مخالفات مرورية / Zero traffic violations', 'دورة السلامة في أعمال الجهد العالي / HV Work Safety course', hr.id).lastInsertRowid;
  run("INSERT INTO plan_reviews(plan_id, year, balance, rating, improved, notes) VALUES (?, ?, 10050, 'acceptable', 0, 'Plan opened')", pl, Number(today.slice(0, 4)) - 2);
  run("INSERT INTO plan_reviews(plan_id, year, balance, rating, improved) VALUES (?, ?, 10100, 'satisfactory', 0)", pl, Number(today.slice(0, 4)) - 1);
  require('./plans').createPlans(Number(today.slice(0, 4)), req);

  // Sample travel history this year (closed jobs): one employee over the limit, one at it, one near it
  const W = require('./workorders');
  const year = Number(today.slice(0, 4));
  const trip = (no, cat, n, km, sec) => {
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(year, 0, 4 + i * 8, 4)).toISOString();
      const e = new Date(Date.parse(d) + 10 * 3600e3).toISOString();
      const w = run(`INSERT INTO work_orders(wo_number, type, title, section_id, distance_km, distance_category, involves_travel, planned_start, planned_end, actual_start, actual_end,
          status, team_leader_id, materials_withdrawn, materials_used, result, action_description, overnight, travel_hours, closed_at, created_at)
        VALUES (?, 'inspection', ?, (SELECT id FROM org_units WHERE code = ?), ?, ?, 'yes', ?, ?, ?, ?, 'closed', ?, 'no', 'no', 'complete', 'Sample trip', ?, ?, ?, ?)`,
      W.nextWoNumber(), `Line patrol trip ${i + 1} (sample)`, sec, km, cat, d, e, d, e, id(no), km > 200 ? 1 : 0, km > 200 ? 6 : 3, e, d);
      run("INSERT INTO wo_participants(wo_id, employee_id, role) VALUES (?, ?, 'leader')", w.lastInsertRowid, id(no));
    }
  };
  trip('F046', 'C', 21, 260, 'H1');
  trip('F048', 'B', 20, 150, 'H2');
  trip('F065', 'B', 17, 140, 'H1');
  trip('F031', 'C', 12, 320, 'H5');
  trip('F031', 'B', 6, 120, 'H5');
  require('./travel').checkAlerts(year);

  // Sample permission: an employee may follow the updates of every H1 work order
  const admin = get("SELECT * FROM employees WHERE employee_no = 'admin'");
  require('./access').grant({ employeeIds: [id('F001')], permission: 'wo.view_history', sectionId: get("SELECT id FROM org_units WHERE code = 'H1'").id, note: 'Sample grant' }, { user: admin, ip: 'seed', get: () => 'seed' });
  require('./access').grant({ employeeIds: [id('F001')], permission: 'wo.view_all', sectionId: get("SELECT id FROM org_units WHERE code = 'H1'").id, note: 'Sample grant' }, { user: admin, ip: 'seed', get: () => 'seed' });
}

// Sample materials / tools / equipment catalog and today's daily tasks
function seedStockAndTasks() {
  const I = require('./items');
  const wh = get("SELECT * FROM employees WHERE employee_no = 'DEMO-WH'");
  const req = { user: wh, ip: 'seed', get: () => 'seed' };
  const sec = (c) => get('SELECT id FROM org_units WHERE code = ?', c)?.id || null;
  const items = [
    ['MAT-INS-380', 'material', 'عازل خزفي 380 ك.ف (عينة)', 'Porcelain insulator 380 kV (sample)', 'Insulators', 'piece', 40, 10, 'Main store A-01', 'H1'],
    ['MAT-INS-132', 'material', 'عازل بوليمري 132 ك.ف (عينة)', 'Polymer insulator 132 kV (sample)', 'Insulators', 'piece', 6, 8, 'Main store A-02', 'H1'],
    ['MAT-CLMP-01', 'material', 'مشبك تعليق (عينة)', 'Suspension clamp (sample)', 'Hardware', 'piece', 120, 30, 'Main store B-04', 'H1'],
    ['MAT-BOLT-M16', 'material', 'طقم مسامير M16 مجلفن (عينة)', 'Galvanized bolt set M16 (sample)', 'Hardware', 'set', 300, 50, 'Main store B-07', null],
    ['MAT-COND-ACSR', 'material', 'موصل ACSR (عينة)', 'ACSR conductor (sample)', 'Conductors', 'meter', 850, 200, 'Yard C', 'H1'],
    ['MAT-GREASE', 'material', 'شحم موصلات (عينة)', 'Conductor grease (sample)', 'Consumables', 'kg', 3, 5, 'Main store D-01', null],
    ['TL-TORQ-01', 'tool', 'مفتاح عزم (عينة)', 'Torque wrench (sample)', 'Hand tools', 'piece', 6, 2, 'Tool room', 'H1'],
    ['TL-HOTSTICK', 'tool', 'عصا التشغيل المعزولة (عينة)', 'Insulated hot stick (sample)', 'Live-line tools', 'piece', 4, 2, 'Tool room', 'H1'],
    ['TL-HARNESS', 'tool', 'حزام أمان للعمل على الارتفاعات (عينة)', 'Full-body safety harness (sample)', 'PPE', 'piece', 18, 6, 'Tool room', null],
    ['TL-LADDER', 'tool', 'سلم ألياف زجاجية (عينة)', 'Fibreglass ladder (sample)', 'Access', 'piece', 3, 1, 'Yard C', 'H2'],
    ['EQ-EARTH-KIT', 'equipment', 'طقم تأريض مؤقت (عينة)', 'Temporary earthing kit (sample)', 'Safety equipment', 'set', 8, 3, 'Tool room', 'H1'],
    ['EQ-GEN-5KVA', 'equipment', 'مولد كهربائي متنقل 5 ك.ف.أ (عينة)', 'Portable generator 5 kVA (sample)', 'Power', 'piece', 2, 1, 'Yard C', null],
    ['EQ-IR-TESTER', 'equipment', 'جهاز قياس العزل (عينة)', 'Insulation resistance tester (sample)', 'Test equipment', 'piece', 3, 1, 'Lab', 'H3'],
  ];
  for (const [code, kind, ar, en, cat, uom, qty, min, loc, s] of items) {
    I.save({ code, kind, name_ar: ar, name_en: en, category: cat, uom, quantity: qty, min_qty: min, location: loc, section_id: sec(s) }, req);
  }
  // Two sample open work orders for today that use catalog items
  const W = require('./workorders');
  const head0 = get("SELECT * FROM employees WHERE employee_no = 'DEMO-H1'");
  const emp = (no) => get('SELECT id FROM employees WHERE employee_no = ?', no)?.id;
  const free = (nos) => nos.map(emp).filter((x) => x && !get("SELECT 1 FROM leaves WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?", x, todayRiyadh(), todayRiyadh()));
  const day0 = todayRiyadh();
  const mk = (title, from, to, nos, lines) => {
    const crew = free(nos);
    if (crew.length < 2) return;
    try {
      W.createWorkOrder({ type: 'corrective', title, priority: 'normal', section_id: sec('H1'), location: 'Line 380-01', involves_travel: 'no', distance_km: 0,
        planned_start: localToUtc(`${day0}T${from}`), planned_end: localToUtc(`${day0}T${to}`), team_leader_id: crew[0], participant_ids: crew.slice(1),
        materials_withdrawn: 'no', items: lines.map(([c, q]) => ({ item_id: get('SELECT id FROM items WHERE code = ?', c).id, qty: q })) }, { user: head0, ip: 'seed', get: () => 'seed' });
    } catch (e) { console.warn('sample work order skipped:', e.message); }
  };
  mk('استبدال سلسلة عوازل على البرج 090 (عينة)', '07:00', '14:00', ['F010', 'F011', 'F012'], [['MAT-INS-380', 6], ['MAT-CLMP-01', 12], ['TL-HOTSTICK', 2], ['EQ-EARTH-KIT', 2]]);
  mk('شد مسامير قواعد الأبراج 100-110 (عينة)', '08:00', '15:00', ['F006', 'F007', 'F008'], [['MAT-BOLT-M16', 20], ['TL-TORQ-01', 1], ['TL-HARNESS', 4]]);
  I.lowStockCheck();

  const T = require('./tasks');
  const head = get("SELECT * FROM employees WHERE employee_no = 'DEMO-H1'") || get("SELECT * FROM employees WHERE role = 'section_head' LIMIT 1");
  const treq = { user: head, ip: 'seed', get: () => 'seed' };
  const today = todayRiyadh();
  const ids = (...nos) => nos.map((n) => get('SELECT id FROM employees WHERE employee_no = ?', n)?.id).filter(Boolean);
  const task = (title, start, end, loc, priority, nos, details) =>
    T.save({ task_date: today, start_time: start, end_time: end, title, location: loc, priority, section_id: sec('H1'), assignee_ids: ids(...nos), details }, treq);
  task('اجتماع السلامة الصباحي (عينة)', '06:30', '07:00', 'Al-Ahsa office', 'normal', ['F001', 'F002', 'F003', 'F004', 'F005'], 'Toolbox talk / PPE check');
  task('فحص حراري لخط 380 ك.ف (عينة)', '07:30', '11:00', 'Line 380-01 towers 80-95', 'high', ['F002', 'F003'], 'Thermal camera inspection of joints and clamps');
  task('استلام مواد من المستودع (عينة)', '08:00', '09:00', 'Main store', 'normal', ['F004'], null);
  task('معالجة بلاغ عازل مكسور (عينة)', '09:00', '13:00', 'Tower T-380-01-090', 'urgent', ['F001', 'F005'], 'Replace broken insulator string; earthing kit required');
}

module.exports = { seed, DEMO_PASSWORD };

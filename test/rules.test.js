'use strict';
// Business-rule tests against a throwaway database: `npm test`
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const test = require('node:test');
const assert = require('node:assert');
const { get, all, run } = require('../src/db');
require('../src/seed').seed();
const W = require('../src/workorders');
const { runAlertChecks } = require('../src/alerts');
const { localToUtc, todayRiyadh, distanceCategory } = require('../src/util');

// Most rules below are about other behaviour; pre-execution approval is tested on its own (it is on by default)
require('../src/db').setSetting('wo_creation_approval', '0');

const emp = (no) => get('SELECT * FROM employees WHERE employee_no = ?', no);
const unit = (code) => get('SELECT * FROM org_units WHERE code = ?', code);
const req = (no) => ({ user: emp(no), ip: '127.0.0.1', get: () => 'test' });
const day = (n) => new Date(Date.parse(todayRiyadh()) + n * 864e5).toISOString().slice(0, 10);
const base = (o = {}) => ({
  type: 'corrective', title: 'Test', priority: 'normal', section_id: unit('H1').id, distance_km: 20,
  planned_start: localToUtc(day(2) + 'T08:00'), planned_end: localToUtc(day(2) + 'T12:00'),
  team_leader_id: emp('F010').id, participant_ids: [], equipment_ids: [], materials_withdrawn: 'no', ...o,
});

test('work order numbers are sequential WO + 6 digits', () => {
  const a = W.createWorkOrder(base(), req('DEMO-H1')).wo;
  const b = W.createWorkOrder(base({ planned_start: localToUtc(day(3) + 'T08:00'), planned_end: localToUtc(day(3) + 'T12:00') }), req('DEMO-H1')).wo;
  assert.match(a.wo_number, /^WO\d{6}$/);
  assert.strictEqual(Number(b.wo_number.slice(2)), Number(a.wo_number.slice(2)) + 1);
});

test('employee on leave cannot be assigned', () => {
  assert.throws(() => W.createWorkOrder(base({ participant_ids: [emp('F003').id], planned_start: localToUtc(day(1) + 'T08:00'), planned_end: localToUtc(day(1) + 'T10:00') }), req('DEMO-H1')), /F003/);
});

test('conflicting work is blocked', () => {
  assert.throws(() => W.createWorkOrder(base({ participant_ids: [emp('F010').id] }), req('DEMO-H1')), /conflicting/);
});

test('expired and under-maintenance equipment is blocked', () => {
  const eq = (c) => get('SELECT id FROM equipment WHERE code = ?', c).id;
  assert.throws(() => W.createWorkOrder(base({ team_leader_id: emp('F002').id, equipment_ids: [eq('VH-104')] }), req('DEMO-H1')), /expired/);
  assert.throws(() => W.createWorkOrder(base({ team_leader_id: emp('F002').id, equipment_ids: [eq('VH-103')] }), req('DEMO-H1')), /under_maintenance/);
});

test('distance categories', () => {
  assert.strictEqual(distanceCategory(99.9), 'A');
  assert.strictEqual(distanceCategory(100), 'B');
  assert.strictEqual(distanceCategory(200), 'B');
  assert.strictEqual(distanceCategory(200.1), 'C');
});

test('assignment 21 over 200 km needs a reason and Sector Head authorization', () => {
  const e = emp('F047');
  for (let i = 0; i < 20; i++) {
    const s = localToUtc(day(-60 + i) + 'T08:00');
    const w = W.createWorkOrder(base({ team_leader_id: e.id, distance_km: 250, selection_reason: 'x', planned_start: s, planned_end: new Date(Date.parse(s) + 3600e3).toISOString() }), req('DEMO-H1')).wo;
    assert.strictEqual(w.status, 'open');
  }
  const o = base({ team_leader_id: e.id, distance_km: 250, planned_start: localToUtc(day(5) + 'T08:00'), planned_end: localToUtc(day(5) + 'T12:00') });
  if (o.planned_start.slice(0, 4) !== localToUtc(day(-60) + 'T08:00').slice(0, 4)) return; // year boundary: counts reset
  assert.throws(() => W.createWorkOrder(o, req('DEMO-H1')), /selection reason/);
  const w = W.createWorkOrder({ ...o, selection_reason: 'Certified operator, no alternative' }, req('DEMO-H1')).wo;
  assert.strictEqual(w.status, 'awaiting_authorization');
  assert.deepStrictEqual(all("SELECT step FROM wo_approvals WHERE wo_id = ? ORDER BY seq", w.id).map((r) => r.step), ['department_manager', 'sector_head']);
});

test('closure requires photos, description and reconciled materials; approvals close it', () => {
  const w0 = W.createWorkOrder(base({ priority: 'C3', team_leader_id: emp('F004').id, materials_withdrawn: 'yes', reservation_number: 'R-T-1',
    planned_start: localToUtc(day(0) + 'T00:00'), planned_end: localToUtc(day(0) + 'T23:00') }), req('DEMO-H1')).wo;
  assert.throws(() => W.startWork(w0, req('F004')), /verified/);
  run('UPDATE material_reservations SET verified = 1 WHERE wo_id = ?', w0.id);
  W.startWork(w0, req('F004'));
  let w = get('SELECT * FROM work_orders WHERE id = ?', w0.id);
  assert.throws(() => W.submitForClosure(w, req('F004')), /Before photo/);

  for (const stage of ['before', 'after']) run("INSERT INTO wo_photos(wo_id, stage, file_name, sha256) VALUES (?,?,?,?)", w.id, stage, 'x.jpg', 'abc');
  const res = get('SELECT id FROM material_reservations WHERE wo_id = ?', w.id).id;
  run("INSERT INTO material_lines(wo_id, reservation_id, material_number, issued_qty, used_qty, returned_qty) VALUES (?,?,?,?,?,?)", w.id, res, 'M1', 5, 3, 1);
  run("UPDATE work_orders SET result='complete', action_description='done', materials_used='yes', arrival_at=?, restored_at=? WHERE id=?", new Date().toISOString(), new Date().toISOString(), w.id);
  w = get('SELECT * FROM work_orders WHERE id = ?', w.id);
  assert.throws(() => W.submitForClosure(w, req('F004')), /reconciled/);
  run("UPDATE material_lines SET returned_qty = 2 WHERE wo_id = ?", w.id);
  W.submitForClosure(w, req('F004'));
  w = get('SELECT * FROM work_orders WHERE id = ?', w.id);
  assert.strictEqual(w.status, 'pending_closure');
  assert.throws(() => W.decide(w, 'approved', '', req('F004')), /not the approver/);
  assert.throws(() => W.decide(w, 'approved', '', req('DEMO-H1')), /not the approver/, 'the foreman signs before the head of section');
  W.decide(w, 'approved', '', req('DEMO-FM-H1'));
  W.decide(get('SELECT * FROM work_orders WHERE id = ?', w.id), 'approved', '', req('DEMO-H1'));
  assert.strictEqual(get('SELECT status FROM work_orders WHERE id = ?', w.id).status, 'pending_closure', 'division manager still to sign');
  W.decide(get('SELECT * FROM work_orders WHERE id = ?', w.id), 'approved', '', req('DEMO-DV1'));
  assert.strictEqual(get('SELECT status FROM work_orders WHERE id = ?', w.id).status, 'closed');
});

test('acting manager approves in place of the absent section head', () => {
  run("INSERT INTO acting_assignments(unit_id, acting_employee_id, start_at, end_at) VALUES (?,?,?,?)", unit('H2').id, emp('F014').id, new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 864e5).toISOString());
  const w = W.createWorkOrder(base({ section_id: unit('H2').id, team_leader_id: emp('F011').id }), req('DEMO-H2')).wo;
  assert.strictEqual(JSON.parse(w.officials_json).section_head.employee_no, 'F014');
  assert.strictEqual(JSON.parse(w.officials_json).section_head.acting, true);
});

test('every assignment queues email to the team and alerts run idempotently', () => {
  const n = get("SELECT COUNT(*) n FROM emails WHERE to_email = 'f010@example.com'").n;
  assert.ok(n >= 1);
  runAlertChecks();
  const first = get('SELECT COUNT(*) n FROM notifications').n;
  runAlertChecks();
  assert.strictEqual(get('SELECT COUNT(*) n FROM notifications').n, first);
  assert.ok(get("SELECT COUNT(*) n FROM notifications WHERE type = 'equipment_expiry'").n > 0);
});

test('audit log and WO numbers are immutable', () => {
  assert.throws(() => run('DELETE FROM audit_log'), /immutable/);
  assert.throws(() => run("UPDATE work_orders SET wo_number = 'WO123456'"), /immutable/);
  assert.throws(() => run('DELETE FROM work_orders'), /never deleted/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------- calendar, absences, points ----------
const P = require('../src/points');
const C = require('../src/calendar');

test('team away list shows section staff on leave, course, workshop or factory tests during a WO', () => {
  const w = W.createWorkOrder(base({ team_leader_id: emp('F008').id, planned_start: localToUtc(day(3) + 'T08:00'), planned_end: localToUtc(day(5) + 'T12:00') }), req('DEMO-H1')).wo;
  const away = W.teamAway(w);
  const types = away.people.map((p) => `${p.employee_no}:${p.type}:${p.mode || ''}`);
  assert.ok(types.includes('F003:annual:'), types.join(','));
  assert.ok(types.includes('F007:training:remote'), types.join(','));
  assert.ok(types.includes('F009:workshop:remote'), types.join(','));
  assert.ok(away.people.every((p) => !p.is_participant));
});

test('calendar includes holidays, work and absences for the year', () => {
  const y = todayRiyadh().slice(0, 4);
  const ev = C.eventsBetween(`${y}-01-01`, `${y}-12-31`, {});
  const kinds = new Set(ev.map((e) => e.type));
  for (const k of ['holiday', 'work', 'annual', 'training', 'workshop', 'factory_test', 'sick']) assert.ok(kinds.has(k), k);
  const h1 = C.eventsBetween(`${y}-01-01`, `${y}-12-31`, { sectionId: unit('H1').id, types: new Set(['annual']) });
  assert.ok(h1.every((e) => e.type === 'annual' && e.section_code === 'H1'));
  assert.match(C.toIcs(ev.slice(0, 3)), /BEGIN:VCALENDAR[\s\S]*BEGIN:VEVENT/);
});

test('everyone opens the year at 10,000 and only approved points count', () => {
  const st = P.standing(emp('F070').id);
  assert.strictEqual(st.balance, 10000);
  assert.strictEqual(st.awarded, false);
  const [id] = P.request({ employeeIds: [emp('F070').id], ruleCode: 'lead_drill', reason: 'Led rescue drill' }, req('DEMO-SAF'));
  assert.strictEqual(P.standing(emp('F070').id).balance, 10000, 'pending does not count');
  assert.throws(() => P.decide(id, true, '', req('DEMO-SAF')), /not an approver|Requester/i);
  P.decide(id, true, '', req('DEMO-HR'));
  assert.strictEqual(P.standing(emp('F070').id).balance, 10150);
  assert.ok(P.standing(emp('F070').id).awarded);
});

test('ranking: higher balance -> higher rating, ties share rank, tiers follow settings', () => {
  P.setTierSizes([2, 2, 2, 2]);
  const ranked = P.leaderboard().rows.filter((r) => r.awarded);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].balance >= ranked[i].balance);
  assert.strictEqual(P.ratingForRank(1), 'excellent');
  assert.strictEqual(P.ratingForRank(2), 'excellent');
  assert.strictEqual(P.ratingForRank(3), 'very_good');
  assert.strictEqual(P.ratingForRank(5), 'good');
  assert.strictEqual(P.ratingForRank(7), 'satisfactory');
  assert.strictEqual(P.ratingForRank(9), 'acceptable');
  ranked.forEach((r) => assert.strictEqual(r.rating, P.ratingForRank(r.rank)));
  const ties = ranked.filter((r, i) => i && r.balance === ranked[i - 1].balance);
  ties.forEach((r) => assert.strictEqual(r.rank, ranked.find((x) => x.balance === r.balance).rank));
  assert.ok(P.leaderboard().rows.filter((r) => !r.awarded).every((r) => r.balance <= 10000 && r.rank === null));
});

test('deductions can be appealed, reversals restore the balance, values are immutable', () => {
  const e = emp('F069');
  const [id] = P.request({ employeeIds: [e.id], ruleCode: 'safety_violation', reason: 'No harness' }, req('DEMO-SAF'));
  P.decide(id, true, '', req('DEMO-DV3'));
  assert.strictEqual(P.standing(e.id).balance, 9200);
  assert.ok(P.standing(e.id).below);
  P.appeal(id, 'Harness was worn', req('F069'));
  assert.throws(() => P.appeal(id, 'again', req('F069')), /once/);
  P.reverse(id, 'Appeal accepted', req('DEMO-HR'));
  assert.strictEqual(P.standing(e.id).balance, 10000);
  assert.throws(() => run('UPDATE point_transactions SET points = 5 WHERE id = ?', id), /immutable/);
  assert.throws(() => run('DELETE FROM point_transactions WHERE id = ?', id), /never deleted/);
});

test('closing a work order awards points to the team automatically', () => {
  const before = P.standing(emp('F004').id).balance;
  const closed = get("SELECT * FROM work_orders WHERE status = 'closed' ORDER BY id DESC LIMIT 1");
  assert.ok(closed);
  const awarded = get("SELECT COUNT(*) n FROM point_transactions WHERE reference = ? AND rule_code = 'wo_critical_closed'", closed.wo_number).n;
  assert.ok(awarded >= 1);
  assert.ok(before >= 10000);
});

test('safety-attendance points are capped at 600 a year', () => {
  const e = emp('F068');
  for (let i = 0; i < 12; i++) P.request({ employeeIds: [e.id], ruleCode: 'safety_meeting_attendance', reason: 'meeting ' + i }, req('DEMO-SAF'));
  assert.throws(() => P.request({ employeeIds: [e.id], ruleCode: 'safety_meeting_attendance', reason: 'meeting 13' }, req('DEMO-SAF')), /cap/);
});

// ---------- extensions, hand-over, fleet, training, plans, permissions ----------
const WC = require('../src/wo_changes');
const TR = require('../src/training');
const PL = require('../src/plans');
const AC = require('../src/access');
const { nowIso } = require('../src/util');
const freshWo = (o) => get('SELECT * FROM work_orders WHERE id = ?', W.createWorkOrder(base(o), req('DEMO-H1')).wo.id);

test('extension: team requests, section head approves, conflicts are blocked', () => {
  const wo = freshWo({ team_leader_id: emp('F005').id, planned_start: localToUtc(day(-30) + 'T08:00'), planned_end: localToUtc(day(-30) + 'T12:00') });
  const r = WC.requestExtension(wo, { newEnd: localToUtc(day(-30) + 'T18:00'), reason: 'Weather' }, req('F005'));
  assert.strictEqual(r.autoApproved, false);
  assert.throws(() => WC.decideExtension(wo, r.id, true, '', req('F005')), /section managers/);
  WC.decideExtension(wo, r.id, true, '', req('DEMO-H1'));
  assert.strictEqual(get('SELECT planned_end FROM work_orders WHERE id = ?', wo.id).planned_end, localToUtc(day(-30) + 'T18:00'));
  // Extending into the team leader's approved leave is refused
  const wo2 = freshWo({ team_leader_id: emp('F003').id, planned_start: localToUtc(day(-5) + 'T08:00'), planned_end: localToUtc(day(-5) + 'T12:00') });
  assert.throws(() => WC.requestExtension(wo2, { newEnd: localToUtc(day(1) + 'T12:00'), reason: 'More work' }, req('DEMO-H1')), /conflicts|unavailable/);
  // A manager's own extension is applied immediately
  const r2 = WC.requestExtension(wo2, { newEnd: localToUtc(day(-5) + 'T15:00'), reason: 'Scope' }, req('DEMO-H1'));
  assert.strictEqual(r2.autoApproved, true);
});

test('scheduled hand-over runs automatically at its time', () => {
  const wo = freshWo({ team_leader_id: emp('F065').id, planned_start: localToUtc(day(-1) + 'T06:00'), planned_end: localToUtc(day(2) + 'T20:00') });
  assert.throws(() => WC.scheduleHandover(wo, { toEmployeeId: emp('F060').id, scheduledAt: nowIso(), reason: 'x' }, req('F001')), /team leader/);
  const future = new Date(Date.now() + 2 * 3600e3).toISOString();
  WC.scheduleHandover(wo, { toEmployeeId: emp('F060').id, scheduledAt: future, reason: 'End of shift', workStatus: 'Half done' }, req('F065'));
  WC.runDueHandovers();
  assert.strictEqual(get('SELECT team_leader_id FROM work_orders WHERE id = ?', wo.id).team_leader_id, emp('F065').id, 'not before its time');
  run("UPDATE wo_handovers SET scheduled_at = ? WHERE wo_id = ?", new Date(Date.now() - 60e3).toISOString(), wo.id);
  assert.strictEqual(WC.runDueHandovers(), 1);
  assert.strictEqual(get('SELECT team_leader_id FROM work_orders WHERE id = ?', wo.id).team_leader_id, emp('F060').id);
  assert.strictEqual(get('SELECT role FROM wo_participants WHERE wo_id = ? AND employee_id = ?', wo.id, emp('F060').id).role, 'leader');
  assert.strictEqual(get('SELECT role FROM wo_participants WHERE wo_id = ? AND employee_id = ?', wo.id, emp('F065').id).role, 'member');
});

test('fleet: crew summary counts people, vehicles and seats', () => {
  const v = (c) => get('SELECT id FROM equipment WHERE code = ?', c).id;
  const { wo, warnings } = W.createWorkOrder(base({ team_leader_id: emp('F050').id, participant_ids: [emp('F066').id, emp('F070').id, emp('F032').id], equipment_ids: [v('VH-105')],
    planned_start: localToUtc(day(-40) + 'T08:00'), planned_end: localToUtc(day(-40) + 'T12:00') }), req('DEMO-H1'));
  const crew = W.crewSummary(wo.id);
  assert.strictEqual(crew.people, 4);
  assert.strictEqual(crew.vehicles.length, 1);
  assert.strictEqual(crew.seats, 2);
  assert.ok(warnings.some((w) => /seats/i.test(w)));
});

test('training: registering books a linked absence that blocks work; cancelling frees it', () => {
  const hrReq = req('DEMO-HR');
  const cid = TR.saveCourse({ code: 'T-TEST', title_ar: 'اختبار', title_en: 'Test course', scope: 'local', category: 'hv_safety', city: 'Riyadh', mode: 'in_person', start_date: day(60), end_date: day(61), status: 'planned' }, hrReq);
  TR.register(cid, [emp('F061').id], 'trainee', hrReq);
  const lv = get("SELECT * FROM leaves WHERE course_id = ? AND employee_id = ?", cid, emp('F061').id);
  assert.strictEqual(lv.type, 'training');
  assert.throws(() => W.createWorkOrder(base({ team_leader_id: emp('F061').id, planned_start: localToUtc(day(60) + 'T08:00'), planned_end: localToUtc(day(60) + 'T12:00') }), req('DEMO-H1')), /training/);
  const a = get('SELECT id FROM course_attendees WHERE course_id = ? AND employee_id = ?', cid, emp('F061').id);
  TR.updateAttendee(a.id, { attendance: 'cancelled' }, hrReq);
  assert.strictEqual(get('SELECT status FROM leaves WHERE id = ?', lv.id).status, 'cancelled');
  // Moving the course moves the linked absences
  TR.register(cid, [emp('F062').id], 'trainee', hrReq);
  TR.saveCourse({ ...get('SELECT * FROM courses WHERE id = ?', cid), start_date: day(70), end_date: day(72) }, hrReq, cid);
  assert.strictEqual(get('SELECT end_date FROM leaves WHERE course_id = ? AND employee_id = ?', cid, emp('F062').id).end_date, day(72));
  assert.ok(TR.suggestions().length > 0);
});

test('improvement plans: no improvement in 3 years -> transfer recommended -> HR confirms', () => {
  const y = Number(todayRiyadh().slice(0, 4));
  const e = emp('F047');
  const plan = get("SELECT * FROM improvement_plans WHERE employee_id = ? AND status = 'active'", e.id);
  assert.ok(plan && plan.start_year === y - 2, 'sample plan started two years ago');
  PL.reviewPlans(y, req('DEMO-HR'));
  const after = get('SELECT * FROM improvement_plans WHERE id = ?', plan.id);
  assert.strictEqual(after.status, 'transfer_recommended');
  assert.throws(() => PL.confirmTransfer(plan.id, { sectionId: e.section_id, decisionNo: 'D1' }, req('DEMO-HR')), /different/);
  assert.throws(() => PL.confirmTransfer(plan.id, { sectionId: get("SELECT id FROM org_units WHERE code = 'H5'").id, decisionNo: 'D1' }, req('DEMO-H1')), /HR/);
  PL.confirmTransfer(plan.id, { sectionId: get("SELECT id FROM org_units WHERE code = 'H5'").id, decisionNo: 'HR-2026-77' }, req('DEMO-HR'));
  assert.strictEqual(get('SELECT section_id FROM employees WHERE id = ?', e.id).section_id, get("SELECT id FROM org_units WHERE code = 'H5'").id);
  assert.strictEqual(get('SELECT status FROM improvement_plans WHERE id = ?', plan.id).status, 'transferred');
  // An employee who improves to Good or better closes the plan
  const ranked = P.leaderboard(y).rows.filter((r) => ['excellent', 'very_good', 'good'].includes(r.rating));
  const target = ranked[0];
  const p2 = run("INSERT INTO improvement_plans(employee_id, start_year, trigger_rating) VALUES (?, ?, 'acceptable')", target.id, y - 1).lastInsertRowid;
  PL.reviewPlans(y, req('DEMO-HR'));
  assert.strictEqual(get('SELECT status FROM improvement_plans WHERE id = ?', p2).status, 'improved');
});

test('permissions: employee sees others’ work only when granted, scoped and revocable', () => {
  const f = emp('F004');
  const wo = get("SELECT w.* FROM work_orders w WHERE w.section_id = ? AND w.id NOT IN (SELECT wo_id FROM wo_participants WHERE employee_id = ?) LIMIT 1", unit('H1').id, f.id);
  const { canViewWO } = require('../src/perm');
  assert.strictEqual(canViewWO(wo, f), false);
  assert.strictEqual(AC.can(f, 'wo.view_history'), false);
  AC.grant({ employeeIds: [f.id], permission: 'wo.view_all', sectionId: unit('H1').id }, req('DEMO-HR'));
  AC.grant({ employeeIds: [f.id], permission: 'wo.view_history', sectionId: unit('H1').id }, req('DEMO-HR'));
  assert.strictEqual(canViewWO(wo, f), true);
  assert.deepStrictEqual(AC.can(f, 'wo.view_history'), [unit('H1').id]);
  assert.strictEqual(AC.can(f, 'wo.view_all', unit('H2').id), false, 'scoped to H1 only');
  assert.throws(() => AC.grant({ employeeIds: [f.id], permission: 'wo.view_all' }, req('DEMO-H1')), /HR/);
  const g = get("SELECT id FROM user_permissions WHERE employee_id = ? AND permission = 'wo.view_all' AND revoked_at IS NULL", f.id);
  AC.revoke(g.id, req('DEMO-HR'));
  assert.strictEqual(canViewWO(wo, f), false);
});

// ---------- travel assignments ----------
const TV = require('../src/travel');

test('travel question: yes requires a band and a matching distance; no requires under 100 km', () => {
  assert.throws(() => TV.normalize({ involves_travel: 'no', distance_km: 150 }), /travel question/);
  assert.throws(() => TV.normalize({ involves_travel: 'yes', distance_km: 50 }), /over 100 km or over 200 km/);
  assert.throws(() => TV.normalize({ involves_travel: 'yes', travel_band: 'over_100', distance_km: 250 }), /100 to 200/);
  assert.throws(() => TV.normalize({ involves_travel: 'yes', travel_band: 'over_200', distance_km: 180 }), /above 200/);
  assert.strictEqual(TV.normalize({ involves_travel: 'yes', travel_band: 'over_200', distance_km: 260 }).category, 'C');
  assert.strictEqual(TV.normalize({ involves_travel: 'yes', travel_band: 'over_100', distance_km: 100 }).category, 'B');
  assert.strictEqual(TV.normalize({ involves_travel: 'no', distance_km: 0 }).category, 'A');
  assert.strictEqual(TV.normalize({ distance_km: 230 }).category, 'C', 'derived when the question was not asked');
});

test('travel report counts per employee and band from work orders, with limit states', () => {
  const y = Number(todayRiyadh().slice(0, 4));
  const rows = TV.report(y).rows;
  const by = (no) => rows.find((r) => r.employee_no === no);
  assert.strictEqual(by('F046').c, 21); assert.strictEqual(by('F046').state, 'over');
  assert.strictEqual(by('F048').b, 20); assert.strictEqual(by('F048').state, 'limit');
  assert.strictEqual(by('F065').state, 'near');
  assert.ok(TV.summary(y).c >= 33);
});

test('a travel job beyond 20 in a band needs Sector Head approval and alerts the employee and managers', () => {
  const before = get("SELECT COUNT(*) n FROM notifications WHERE type = 'travel_over_limit' AND employee_id = ?", emp('F048').id).n;
  const { wo } = W.createWorkOrder(base({ team_leader_id: emp('F048').id, section_id: unit('H2').id, involves_travel: 'yes', travel_band: 'over_100', distance_km: 160,
    planned_start: localToUtc(day(9) + 'T07:00'), planned_end: localToUtc(day(9) + 'T15:00') }), req('DEMO-H2'));
  assert.strictEqual(wo.status, 'awaiting_authorization');
  assert.strictEqual(wo.involves_travel, 'yes');
  const after = get("SELECT COUNT(*) n FROM notifications WHERE type = 'travel_over_limit' AND employee_id = ?", emp('F048').id).n;
  assert.strictEqual(after, before + 1, 'employee alerted');
  // Whoever heads the section now (an acting head if one is assigned) is alerted
  const headId = require('../src/org').officialsAt(unit('H2').id, new Date().toISOString()).section_head.employee_id;
  const head = get("SELECT COUNT(*) n FROM notifications WHERE type = 'travel_over_limit' AND employee_id = ?", headId).n;
  assert.ok(head >= 1, 'section head alerted');
  assert.strictEqual(TV.checkAlerts(), 0, 'alerts are not repeated');
});

// ---------- materials, tools & equipment ----------
const I = require('../src/items');
const itemOf = (code) => get('SELECT * FROM items WHERE code = ?', code);

test('items on a work order are reserved; requests over the available quantity are blocked', () => {
  const ins = itemOf('MAT-INS-380');
  const avail = I.withStock(ins).available;
  assert.throws(() => W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(20) + 'T08:00'), planned_end: localToUtc(day(20) + 'T12:00'),
    items: [{ item_id: ins.id, qty: avail + 1 }] }), req('DEMO-H1')), /available/);
  const { wo } = W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(20) + 'T08:00'), planned_end: localToUtc(day(20) + 'T12:00'),
    items: [{ item_id: ins.id, qty: 3 }, { item_id: itemOf('TL-TORQ-01').id, qty: 1 }] }), req('DEMO-H1'));
  assert.strictEqual(I.withStock(itemOf('MAT-INS-380')).available, avail - 3, 'reserved while active');
  assert.strictEqual(I.ofWo(wo.id).length, 2);
  W.cancelWorkOrder(wo, 'test', req('DEMO-H1'));
  assert.strictEqual(I.withStock(itemOf('MAT-INS-380')).available, avail, 'released on cancellation');
});

test('closure consumes used materials, writes off damaged tools and keeps a movement log', () => {
  const { wo } = W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(21) + 'T08:00'), planned_end: localToUtc(day(21) + 'T12:00'),
    items: [{ item_id: itemOf('MAT-CLMP-01').id, qty: 10 }, { item_id: itemOf('TL-HARNESS').id, qty: 2 }] }), req('DEMO-H1'));
  const clamps = itemOf('MAT-CLMP-01').quantity, harness = itemOf('TL-HARNESS').quantity;
  const lines = I.ofWo(wo.id);
  I.updateWoLine(wo, lines.find((l) => l.code === 'MAT-CLMP-01').id, { qty: 10, used_qty: 7 }, req('F013'));
  I.updateWoLine(wo, lines.find((l) => l.code === 'TL-HARNESS').id, { qty: 2, damaged_qty: 1 }, req('F013'));
  assert.throws(() => I.updateWoLine(wo, lines[0].id, { qty: 10, used_qty: 11 }, req('F013')), /between/);
  I.settle(get('SELECT * FROM work_orders WHERE id = ?', wo.id), req('DEMO-H1'));
  assert.strictEqual(itemOf('MAT-CLMP-01').quantity, clamps - 7, '7 clamps consumed');
  assert.strictEqual(itemOf('TL-HARNESS').quantity, harness - 1, 'only the damaged harness is written off');
  assert.ok(get("SELECT 1 FROM item_movements WHERE wo_id = ? AND kind = 'consume'", wo.id));
  I.settle(get('SELECT * FROM work_orders WHERE id = ?', wo.id), req('DEMO-H1'));
  assert.strictEqual(itemOf('MAT-CLMP-01').quantity, clamps - 7, 'settling twice changes nothing');
});

test('stock cannot go negative and low stock alerts the warehouse once', () => {
  const g = itemOf('MAT-GREASE');
  assert.throws(() => I.stockMove(g.id, { kind: 'adjust', qty: -(g.quantity + 1), note: 'count' }, req('DEMO-WH')), /below zero/);
  assert.throws(() => I.stockMove(g.id, { kind: 'adjust', qty: -1 }, req('DEMO-WH')), /reason/);
  const n = () => get("SELECT COUNT(*) n FROM notifications WHERE type = 'stock_low' AND employee_id = ?", emp('DEMO-WH').id).n;
  const before = n();
  I.lowStockCheck([g.id]); I.lowStockCheck([g.id]);
  assert.strictEqual(n(), before, 'already alerted during seeding, not repeated');
  I.stockMove(g.id, { kind: 'receive', qty: 50, note: 'GRN-1' }, req('DEMO-WH'));
  I.stockMove(g.id, { kind: 'adjust', qty: -50, note: 'count' }, req('DEMO-WH'));
  assert.strictEqual(n(), before + 1, 'alerted again after recovering and dropping');
});

// ---------- work order editing ----------
test('editing a work order re-checks availability, needs a reason and notifies the team', () => {
  const { wo } = W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(22) + 'T08:00'), planned_end: localToUtc(day(22) + 'T12:00') }), req('DEMO-H1'));
  const data = { ...base({ team_leader_id: emp('F013').id, participant_ids: [emp('F015').id], title: 'Edited', priority: 'C3', planned_start: localToUtc(day(22) + 'T09:00'), planned_end: localToUtc(day(22) + 'T13:00') }) };
  assert.throws(() => W.updateWorkOrder(wo, data, '', req('DEMO-H1')), /reason/);
  assert.throws(() => W.updateWorkOrder(wo, { ...data, participant_ids: [emp('F003').id], planned_start: localToUtc(day(1) + 'T08:00'), planned_end: localToUtc(day(1) + 'T10:00') }, 'x', req('DEMO-H1')), /F003/);
  const { wo: w2 } = W.updateWorkOrder(wo, data, 'Scope change', req('DEMO-H1'));
  assert.strictEqual(w2.title, 'Edited');
  assert.ok(w2.due_at, 'critical priority sets a response deadline');
  assert.strictEqual(w2.wo_number, wo.wo_number);
  assert.ok(get("SELECT 1 FROM notifications WHERE type = 'wo_assigned' AND employee_id = ? AND title LIKE ?", emp('F015').id, wo.wo_number + '%'));
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity = 'work_order' AND action = 'update' AND entity_id = ? AND reason = 'Scope change'", wo.wo_number));
});

// ---------- daily tasks ----------
const TK = require('../src/tasks');

test('daily tasks: one click sends each person only their own items; chosen recipients get the full list', () => {
  const d = day(30);
  const a = TK.save({ task_date: d, start_time: '07:00', title: 'Task A', assignee_ids: [emp('F013').id] }, req('DEMO-H1')).id;
  const b = TK.save({ task_date: d, start_time: '09:00', title: 'Task B', assignee_ids: [emp('F015').id, emp('F013').id] }, req('DEMO-H1')).id;
  assert.throws(() => TK.save({ task_date: d, title: 'No one', assignee_ids: [] }, req('DEMO-H1')), /employee/);
  const ag = TK.agenda({ day: d });
  const r = TK.dispatch({ day: d, mode: 'each', taskIds: ag.tasks.map((x) => x.id), woIds: ag.wos.map((x) => x.id) }, req('DEMO-H1'));
  const f13 = r.messages.find((m) => m.employee?.employee_no === 'F013'), f15 = r.messages.find((m) => m.employee?.employee_no === 'F015');
  assert.strictEqual(f13.lines.length, 2);
  assert.strictEqual(f15.lines.length, 1, 'F015 only receives Task B');
  assert.ok(get("SELECT 1 FROM emails WHERE subject LIKE ? AND to_email = ?", '%' + d + '%', emp('F015').email));
  const sel = TK.dispatch({ day: d, mode: 'selected', taskIds: [a, b], recipientIds: [emp('F020').id], externalEmails: TK.parseEmails('ext@contractor.com') }, req('DEMO-H1'));
  assert.strictEqual(sel.recipients, 2);
  assert.ok(sel.messages.every((m) => m.lines.length === 2));
  assert.throws(() => TK.parseEmails('bad-address'), /Invalid email/);
  assert.throws(() => TK.dispatch({ day: d, mode: 'selected', taskIds: [a] }, req('DEMO-H1')), /recipients/);
  TK.setStatus(a, 'done', req('F013'));
  assert.throws(() => TK.setStatus(b, 'done', req('F020')), /Forbidden/);
});

test('daily tasks: WhatsApp links use the international number', () => {
  assert.match(TK.waLink('0551234567', 'hi'), /^https:\/\/wa\.me\/966551234567\?text=hi$/);
  assert.strictEqual(TK.waLink('', 'x'), null);
});

// ---------- coordination & board ----------
test('closing or cancelling a work order settles its linked daily tasks; leave flags open tasks', () => {
  const { wo } = W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(40) + 'T08:00'), planned_end: localToUtc(day(40) + 'T12:00') }), req('DEMO-H1'));
  const tid = TK.save({ task_date: day(40), title: 'Linked', wo_number: wo.wo_number, assignee_ids: [emp('F013').id] }, req('DEMO-H1')).id;
  W.cancelWorkOrder(wo, 'test', req('DEMO-H1'));
  assert.strictEqual(get('SELECT status FROM tasks WHERE id = ?', tid).status, 'cancelled');
  const t2 = TK.save({ task_date: day(41), title: 'Patrol', assignee_ids: [emp('F013').id] }, req('DEMO-H1')).id;
  assert.strictEqual(require('../src/sync').onLeave(emp('F013').id, day(41), day(42)), 1);
  assert.ok(get("SELECT 1 FROM notifications WHERE type = 'task_conflict' AND employee_id = ?", emp('DEMO-H1').id));
  assert.ok(t2);
});

test('board: honor board ranks by recognition score and the feed respects permissions', () => {
  const Bd = require('../src/board');
  const data = Bd.build({ period: 'year' }, emp('DEMO-H1'));
  assert.ok(data.honor.podium.length > 0);
  for (let i = 1; i < data.honor.podium.length; i++) assert.ok(data.honor.podium[i - 1].score >= data.honor.podium[i].score);
  assert.ok(data.events.some((e) => e.type === 'wo_created'));
  const mine = Bd.events(data.p, emp('F013'));
  assert.ok(!mine.some((e) => e.type === 'absence'), 'employees do not see others’ leave');
  assert.strictEqual(data.summary.days.length, data.p.days);
});

// ---------- approval chain ----------
test('a new work order needs foreman -> head of section -> division manager before work; the creator signs their own step', () => {
  const { setSetting } = require('../src/db');
  setSetting('wo_creation_approval', '1');
  try {
    const { wo, notes } = W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(50) + 'T08:00'), planned_end: localToUtc(day(50) + 'T12:00') }), req('DEMO-H1'));
    assert.strictEqual(wo.status, 'awaiting_authorization');
    assert.ok(notes[0].includes('Foreman'));
    const steps = all("SELECT step, decision FROM wo_approvals WHERE wo_id = ? ORDER BY seq", wo.id);
    assert.deepStrictEqual(steps.map((x) => x.step), ['foreman', 'section_head', 'division_manager']);
    assert.strictEqual(steps[1].decision, 'approved', 'creator (head of section) signed automatically');
    assert.throws(() => W.startWork(wo, req('F013')), /open/);
    assert.throws(() => W.decide(wo, 'approved', '', req('DEMO-DV1')), /not the approver/, 'order is enforced');
    assert.ok(get("SELECT 1 FROM notifications WHERE type = 'approval_request' AND employee_id = ? AND title LIKE ?", emp('DEMO-FM-H1').id, wo.wo_number + '%'));
    W.decide(wo, 'approved', '', req('DEMO-FM-H1'));
    W.decide(get('SELECT * FROM work_orders WHERE id = ?', wo.id), 'approved', '', req('DEMO-DV1'));
    assert.strictEqual(get('SELECT status FROM work_orders WHERE id = ?', wo.id).status, 'open');
    // Rejection cancels the work order and needs a comment
    const w2 = W.createWorkOrder(base({ team_leader_id: emp('F013').id, planned_start: localToUtc(day(51) + 'T08:00'), planned_end: localToUtc(day(51) + 'T12:00') }), req('DEMO-H1')).wo;
    assert.throws(() => W.decide(w2, 'rejected', '', req('DEMO-FM-H1')), /comment/);
    W.decide(w2, 'rejected', 'Not needed', req('DEMO-FM-H1'));
    assert.strictEqual(get('SELECT status FROM work_orders WHERE id = ?', w2.id).status, 'cancelled');
    // Critical cases start immediately (setting) and the chain is informed
    const w3 = W.createWorkOrder(base({ priority: 'C1', team_leader_id: emp('F013').id, planned_start: localToUtc(day(52) + 'T08:00'), planned_end: localToUtc(day(52) + 'T12:00') }), req('DEMO-H1')).wo;
    assert.strictEqual(w3.status, 'open');
  } finally { setSetting('wo_creation_approval', '0'); }
});

// ---------- documents & inventory orders ----------
test('documents: employee files are private; vehicle files need fleet rights; expiry alerts fire once', () => {
  const Dc = require('../src/documents');
  const fs = require('node:fs'), pth = require('node:path');
  const file = () => { const f = pth.join(require('../src/files').UPLOAD_DIR, 'docs', 'test-' + Math.random().toString(36).slice(2) + '.pdf'); fs.mkdirSync(pth.dirname(f), { recursive: true }); fs.writeFileSync(f, '%PDF-1.4'); return { path: f, originalname: 'card.pdf', mimetype: 'application/pdf', size: 8 }; };
  Dc.add('employee', emp('F013').id, [file()], { doc_type: 'driving_license', expiry_date: day(-1) }, req('F013'));
  const d = get("SELECT * FROM documents WHERE entity = 'employee' AND entity_id = ? ORDER BY id DESC", emp('F013').id);
  assert.ok(Dc.find(d.id, emp('F013'), false));
  assert.ok(Dc.find(d.id, emp('DEMO-HR'), false));
  assert.throws(() => Dc.find(d.id, emp('F020'), false), /Forbidden/);
  assert.throws(() => Dc.add('employee', emp('F013').id, [file()], {}, req('F020')), /Forbidden/);
  const veh = get("SELECT id FROM equipment WHERE type = 'vehicle' LIMIT 1").id;
  assert.throws(() => Dc.add('vehicle', veh, [file()], { doc_type: 'insurance' }, req('F001')), /Forbidden/);
  Dc.add('vehicle', veh, [file()], { doc_type: 'insurance', expiry_date: day(5) }, req('DEMO-SAF'));
  Dc.checkExpiry();
  assert.strictEqual(Dc.checkExpiry(), 0, 'not repeated');
  assert.ok(get("SELECT 1 FROM notifications WHERE type = 'document_expiry' AND employee_id = ?", emp('F013').id), 'employee told about the expired licence');
});

test('inventory: supplier orders raise "on order", receipts add stock, transactions list every movement', () => {
  const it = itemOf('MAT-COND-ACSR');
  const before = I.withStock(it);
  const oid = I.createOrder(it.id, { qty: 100, order_no: 'PO-T-1' }, req('DEMO-WH'));
  assert.strictEqual(I.withStock(itemOf('MAT-COND-ACSR')).on_order, before.on_order + 100);
  I.receiveOrder(oid, 40, req('DEMO-WH'));
  let now = I.withStock(itemOf('MAT-COND-ACSR'));
  assert.strictEqual(now.quantity, before.quantity + 40);
  assert.strictEqual(now.on_order, before.on_order + 60);
  assert.throws(() => I.receiveOrder(oid, 61, req('DEMO-WH')), /between/);
  I.receiveOrder(oid, undefined, req('DEMO-WH'));
  now = I.withStock(itemOf('MAT-COND-ACSR'));
  assert.strictEqual(now.on_order, before.on_order);
  assert.strictEqual(get('SELECT status FROM item_orders WHERE id = ?', oid).status, 'received');
  const kinds = new Set(I.transactions({ item: it.id }).map((x) => x.kind));
  assert.ok(kinds.has('receive') && kinds.has('order_received'));
  assert.deepStrictEqual(I.parseLines({ item_ids: [String(it.id), '9999'], item_qtys: ['5', ''] }), [{ item_id: it.id, qty: 5 }], 'empty picker rows are ignored');
});

// ---------- file extraction ----------
test('extraction: headings in Arabic or English map to the right fields; "label: value" text becomes a record', () => {
  const X = require('../src/extract');
  const m = X.mapContent({ matrices: [[['كشف'], ['الرقم الوظيفي', 'الاسم', 'البريد الالكتروني', 'القسم'], ['F950', 'تجربة', 'f950@example.com', 'H1']]] }, 'auto');
  assert.strictEqual(m.entity, 'employees');
  assert.deepStrictEqual(m.rows[0], { employee_no: 'F950', name_ar: 'تجربة', email: 'f950@example.com', section_code: 'H1' });
  const t = X.rowsFromText('Item code: MAT-T-1\nKind: material\nArabic name: صنف تجربة\nQuantity: 4', 'items');
  assert.strictEqual(t.rows[0].code, 'MAT-T-1');
  assert.strictEqual(t.rows[0].quantity, '4');
});

test('extraction: an auditor (not the uploader) approves rows, and only approved valid rows are added', () => {
  const X = require('../src/extract');
  const file = { rel: 'docs/x.csv', name: 'x.csv', mime: 'text/csv', size: 1, sha256: 'x' };
  const result = { entity: 'items', method: 'local', warnings: [], unmapped: [], preview: {}, rows: [{ code: 'MAT-X-1', kind: 'material', name_ar: 'صنف أ', quantity: '5' }, { code: 'MAT-X-2', kind: 'bad-kind', name_ar: 'صنف ب' }] };
  const id = X.create({ file, entity: 'items', method: 'local' }, result, req('DEMO-WH'));
  let x = X.load(id, emp('DEMO-AUD'));
  assert.strictEqual(x.rows[0].errors.length, 0);
  assert.ok(x.rows[1].errors.length, 'invalid kind flagged');
  assert.ok(get("SELECT 1 FROM notifications WHERE type = 'extraction_review' AND employee_id = ?", emp('DEMO-AUD').id), 'auditor notified');
  assert.throws(() => X.load(id, emp('F001')), /Forbidden/);
  // The uploader cannot approve rows or export
  x = X.saveEdits(x, { entity: 'items', rows: { 0: { ...x.rows[0].data, __state: 'approved' } } }, req('DEMO-WH'));
  assert.strictEqual(x.rows[0].state, 'pending');
  assert.throws(() => X.exportApproved(X.load(id, emp('DEMO-WH')), req('DEMO-WH')), /auditor|reviewer/i);
  // Auditor approves the valid rows (the invalid one stays pending) and exports
  x = X.saveEdits(X.load(id, emp('DEMO-AUD')), { entity: 'items', action: 'approve_valid', rows: { 0: result.rows[0], 1: result.rows[1] } }, req('DEMO-AUD'));
  assert.deepStrictEqual(x.rows.map((r) => r.state), ['approved', 'pending']);
  const out = X.exportApproved(X.load(id, emp('DEMO-AUD')), req('DEMO-AUD'));
  assert.strictEqual(out.inserted, 1);
  assert.ok(get("SELECT 1 FROM items WHERE code = 'MAT-X-1' AND quantity = 5"));
  assert.ok(!get("SELECT 1 FROM items WHERE code = 'MAT-X-2'"));
  assert.strictEqual(X.load(id, emp('DEMO-AUD')).status, 'exported');
  assert.throws(() => X.exportApproved(X.load(id, emp('DEMO-AUD')), req('DEMO-AUD')), /processed/);
});

test('extraction: Word tables and PDF text are read', async () => {
  const X = require('../src/extract');
  // Minimal text PDF with a two-line table
  const lines = ['Item code   Kind   Arabic name   Quantity', 'MAT-PDF-1   material   test   7'];
  const stream = `BT /F1 12 Tf 40 760 Td ${lines.map((l, i) => `${i ? '0 -20 Td ' : ''}(${l}) Tj`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'];
  let pdf = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const raw = await X.readPdf(Buffer.from(pdf, 'latin1'));
  const m = X.mapContent(raw, 'items');
  assert.ok(m.rows.some((r) => r.code === 'MAT-PDF-1' && r.quantity === '7'), JSON.stringify(m.rows));
});

// ---------- global search and follow-ups ----------
test('global search: Arabic letter variants match, and results follow each page\'s visibility rules', () => {
  const S = require('../src/search');
  const h = { t: (k) => k, nm: (o) => o.name_ar, lbl: (g, v) => v, fmt: (d) => d, lang: 'ar' };
  run("INSERT INTO items (code, name_ar, kind, uom, quantity) VALUES ('MAT-SRCH-1', 'مادة إختبار البحث', 'material', 'pcs', 1)");
  // Typed without hamza and with ه instead of ة
  const g = S.search('اختبار البحث', emp('F001'), h);
  assert.ok(g.find((x) => x.key === 'materials_tools')?.rows.some((r) => r.code === 'MAT-SRCH-1'));
  // LIKE wildcards in the query are literal
  assert.strictEqual(S.search('%%', emp('F001'), h).length, 0);
  // An employee does not get the employees group; HR does
  assert.ok(!S.search('F00', emp('F001'), h).some((x) => x.key === 'employees'));
  assert.ok(S.search('F00', emp('DEMO-HR'), h).some((x) => x.key === 'employees'));
  // Work orders: only those the user may view
  const P = require('../src/perm');
  for (const r of (S.search('WO', emp('F001'), h).find((x) => x.key === 'work_orders')?.rows || [])) {
    assert.ok(P.canViewWO(get('SELECT * FROM work_orders WHERE id = ?', Number(r.href.split('/').pop())), emp('F001')));
  }
});

test('dashboard follow-ups: the auditor sees extracted files to review; warehouse sees stock alerts', () => {
  const { followUps } = require('../src/inbox');
  const aud = followUps(emp('DEMO-AUD'));
  const pending = get("SELECT COUNT(*) n FROM extractions WHERE status = 'pending_review' AND created_by <> ?", emp('DEMO-AUD').id).n;
  if (pending) assert.strictEqual(aud.find((f) => f.key === 'fu_extractions').n, pending);
  run("INSERT INTO items (code, name_ar, kind, uom, quantity, min_qty) VALUES ('MAT-LOW-1', 'مادة ناقصة', 'material', 'pcs', 0, 5)");
  const wh = followUps(emp('DEMO-WH'));
  assert.ok(wh.some((f) => f.key === 'fu_stock_out' && f.href === '/materials?stock=out'));
  assert.ok(!followUps(emp('F001')).some((f) => f.key.startsWith('fu_stock')));
});

test('demo databases: "(تجريبي)", "(عينة)", "(demo)" and "(sample)" are removed once; the audit log is left untouched', () => {
  const B = require('../src/bootstrap');
  require('../src/db').setSetting('demo_labels_cleaned', '0');
  run("INSERT INTO items (code, name_ar, name_en, kind, uom, quantity) VALUES ('MAT-LBL-1', 'عازل (عينة)', 'Insulator (sample)', 'material', 'pcs', 1)");
  run("UPDATE employees SET name_en = 'F001 (sample)' WHERE employee_no = 'F001'");
  assert.ok(B.cleanDemoLabels() >= 3);
  assert.deepStrictEqual({ ...get("SELECT name_ar, name_en FROM items WHERE code = 'MAT-LBL-1'") }, { name_ar: 'عازل', name_en: 'Insulator' });
  assert.strictEqual(get("SELECT name_en FROM employees WHERE employee_no = 'F001'").name_en, null);
  // Only once
  run("UPDATE items SET name_ar = 'عازل (عينة)' WHERE code = 'MAT-LBL-1'");
  assert.strictEqual(B.cleanDemoLabels(), 0);
});

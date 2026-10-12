'use strict';
// Business-rule tests against a throwaway database: `npm test`
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');

const test = require('node:test');
const assert = require('node:assert');
const { get, all, run } = require('../src/db');
require('../src/seed').seed();
const W = require('../src/workorders');
const { runAlertChecks } = require('../src/alerts');
const { localToUtc, todayRiyadh, distanceCategory } = require('../src/util');

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
  W.decide(w, 'approved', '', req('DEMO-H1'));
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

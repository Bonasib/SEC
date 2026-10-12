'use strict';
// Schedule changes on a work order: date/time extensions and scheduled hand-over to another employee.
const crypto = require('node:crypto');
const { all, get, run, tx } = require('./db');
const { nowIso, audit, HttpError, fmt } = require('./util');
const { officialsAt } = require('./org');
const { notify, idsByRole } = require('./notify');
const W = require('./workorders');

const EXTENDABLE = ['awaiting_authorization', 'open', 'in_progress'];
const MANAGER_KEYS = ['section_head', 'division_manager', 'department_manager', 'sector_head'];

function isManagerOf(wo, user) {
  const o = officialsAt(wo.section_id, nowIso());
  return MANAGER_KEYS.some((k) => o[k]?.employee_id === user.id);
}
const team = (woId) => all('SELECT employee_id FROM wo_participants WHERE wo_id = ?', woId).map((r) => r.employee_id);
const link = (wo) => `/wo/${wo.id}`;

// ---------- extensions ----------
function requestExtension(wo, { newStart, newEnd, reason }, req) {
  if (!EXTENDABLE.includes(wo.status)) throw new HttpError(400, 'This work order can no longer be extended / لا يمكن تمديد أمر العمل في حالته الحالية');
  const member = team(wo.id).includes(req.user.id) || wo.team_leader_id === req.user.id;
  if (!member && !isManagerOf(wo, req.user) && req.user.role !== 'admin') throw new HttpError(403, 'Only the team or its managers can request an extension / التمديد للفريق أو مديريه');
  if (!reason) throw new HttpError(400, 'Reason is required / سبب التمديد مطلوب');
  const start = wo.status === 'in_progress' || !newStart ? wo.planned_start : newStart;
  if (!newEnd) throw new HttpError(400, 'New end date/time is required / تاريخ النهاية الجديد مطلوب');
  if (newEnd <= start) throw new HttpError(400, 'New end must be after the start / النهاية يجب أن تكون بعد البداية');
  if (newEnd === wo.planned_end && start === wo.planned_start) throw new HttpError(400, 'Nothing changed / لا يوجد تغيير');
  if (get("SELECT 1 FROM wo_extensions WHERE wo_id = ? AND status = 'pending'", wo.id)) throw new HttpError(400, 'An extension is already awaiting approval / يوجد طلب تمديد معلق');
  checkWindow(wo, start, newEnd);
  const r = run('INSERT INTO wo_extensions(wo_id, old_start, old_end, new_start, new_end, reason, requested_by) VALUES (?,?,?,?,?,?,?)',
    wo.id, wo.planned_start, wo.planned_end, start, newEnd, reason, req.user.id);
  const id = Number(r.lastInsertRowid);
  audit(req, 'request_extension', 'work_order', wo.wo_number, { planned_start: wo.planned_start, planned_end: wo.planned_end }, { planned_start: start, planned_end: newEnd, reason });
  // A manager of the section approves their own request immediately
  if (isManagerOf(wo, req.user)) {
    decideExtension(wo, id, true, 'Requested by manager', req);
    return { id, autoApproved: true };
  }
  const o = officialsAt(wo.section_id, nowIso());
  notify([o.section_head?.employee_id || o.division_manager?.employee_id].filter(Boolean), {
    type: 'extension_request', severity: 'warning',
    title: `${wo.wo_number} - طلب تمديد بانتظار اعتمادك / Extension request awaiting your approval`,
    body: `${fmt(wo.planned_end, 'en')} → ${fmt(newEnd, 'en')}\n${reason}`, link: link(wo) + '#schedule',
  });
  return { id, autoApproved: false };
}

// The new window must still be free for the team and the vehicles/devices
function checkWindow(wo, start, end) {
  const eq = all('SELECT equipment_id FROM wo_equipment WHERE wo_id = ?', wo.id).map((r) => r.equipment_id);
  const errs = W.availabilityErrors({ participantIds: team(wo.id), equipmentIds: eq, plannedStart: start, plannedEnd: end, excludeWoId: wo.id });
  if (errs.length) throw new HttpError(400, 'The extended period conflicts / الفترة الممددة تتعارض:\n' + errs.join('\n'));
}

function decideExtension(wo, id, approve, comment, req) {
  const x = get('SELECT * FROM wo_extensions WHERE id = ? AND wo_id = ?', id, wo.id);
  if (!x || x.status !== 'pending') throw new HttpError(400, 'Not pending / ليس معلقًا');
  if (!isManagerOf(wo, req.user)) throw new HttpError(403, 'Only the section managers approve extensions / الاعتماد لمديري القسم');
  if (!approve && !comment) throw new HttpError(400, 'A comment is required to reject / التعليق مطلوب عند الرفض');
  if (approve) checkWindow(wo, x.new_start, x.new_end);
  tx(() => {
    run('UPDATE wo_extensions SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?', approve ? 'approved' : 'rejected', req.user.id, nowIso(), comment || null, id);
    if (approve) run('UPDATE work_orders SET planned_start = ?, planned_end = ? WHERE id = ?', x.new_start, x.new_end, wo.id);
    audit(req, approve ? 'approve_extension' : 'reject_extension', 'work_order', wo.wo_number, { planned_end: x.old_end }, { planned_end: approve ? x.new_end : x.old_end }, comment);
  });
  notify([...team(wo.id), x.requested_by], {
    type: approve ? 'extension_approved' : 'extension_rejected', severity: approve ? 'info' : 'warning',
    title: approve ? `${wo.wo_number} - تم تمديد أمر العمل حتى ${fmt(x.new_end, 'ar')} / Extended until ${fmt(x.new_end, 'en')}` : `${wo.wo_number} - رُفض طلب التمديد / Extension rejected`,
    body: approve ? `${fmt(x.old_end, 'en')} → ${fmt(x.new_end, 'en')}\n${x.reason}` : comment, link: link(wo) + '#schedule',
  });
}

function cancelExtension(wo, id, req) {
  const x = get('SELECT * FROM wo_extensions WHERE id = ? AND wo_id = ?', id, wo.id);
  if (!x || x.status !== 'pending') throw new HttpError(400, 'Not pending');
  if (x.requested_by !== req.user.id && !isManagerOf(wo, req.user)) throw new HttpError(403, 'Forbidden');
  run("UPDATE wo_extensions SET status = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ?", req.user.id, nowIso(), id);
  audit(req, 'cancel_extension', 'work_order', wo.wo_number, null, { extension: id });
}

// ---------- scheduled hand-over ----------
function scheduleHandover(wo, { toEmployeeId, scheduledAt, reason, workStatus, removeOutgoing }, req) {
  if (!['open', 'in_progress'].includes(wo.status)) throw new HttpError(400, 'Only open or in-progress work can be handed over / التسليم للأعمال المفتوحة أو قيد التنفيذ');
  if (wo.team_leader_id !== req.user.id && !isManagerOf(wo, req.user)) throw new HttpError(403, 'Only the team leader or section managers can schedule a hand-over / للقائد أو مديري القسم');
  const to = get("SELECT * FROM employees WHERE id = ? AND status = 'active'", Number(toEmployeeId));
  if (!to) throw new HttpError(400, 'Choose the receiving employee / اختر الموظف المستلم');
  if (to.id === wo.team_leader_id) throw new HttpError(400, 'This employee already leads the work / الموظف هو القائد الحالي');
  if (!scheduledAt) throw new HttpError(400, 'Hand-over date/time is required / تاريخ ووقت التسليم مطلوب');
  if (scheduledAt >= wo.planned_end) throw new HttpError(400, 'Hand-over must be before the planned end; extend the work order first / يجب أن يكون التسليم قبل نهاية العمل');
  if (!reason) throw new HttpError(400, 'Reason is required / السبب مطلوب');
  if (get("SELECT 1 FROM wo_handovers WHERE wo_id = ? AND status = 'scheduled'", wo.id)) throw new HttpError(400, 'A hand-over is already scheduled; cancel it first / يوجد تسليم مجدول');
  // The receiver must be free from the hand-over moment to the end of the work
  const errs = W.availabilityErrors({ participantIds: team(wo.id).includes(to.id) ? [] : [to.id], plannedStart: scheduledAt, plannedEnd: wo.planned_end, excludeWoId: wo.id });
  if (errs.length) throw new HttpError(400, errs.join('\n'));
  const r = run(`INSERT INTO wo_handovers(wo_id, from_employee_id, to_employee_id, scheduled_at, reason, work_status, remove_outgoing, created_by)
    VALUES (?,?,?,?,?,?,?,?)`, wo.id, wo.team_leader_id, to.id, scheduledAt, reason, workStatus || null, removeOutgoing ? 1 : 0, req.user.id);
  audit(req, 'schedule_handover', 'work_order', wo.wo_number, { team_leader_id: wo.team_leader_id }, { to: to.employee_no, scheduled_at: scheduledAt, reason });
  const o = officialsAt(wo.section_id, nowIso());
  notify([to.id, wo.team_leader_id, o.section_head?.employee_id], {
    type: 'handover_scheduled', title: `${wo.wo_number} - تسليم مجدول إلى ${to.name_ar} في ${fmt(scheduledAt, 'ar')} / Hand-over scheduled`,
    body: `${wo.title}\n${reason}${workStatus ? '\n' + workStatus : ''}`, link: link(wo) + '#schedule',
  });
  if (scheduledAt <= nowIso()) runDueHandovers();
  return Number(r.lastInsertRowid);
}

function cancelHandover(wo, id, req) {
  const h = get("SELECT * FROM wo_handovers WHERE id = ? AND wo_id = ? AND status = 'scheduled'", id, wo.id);
  if (!h) throw new HttpError(400, 'Not scheduled');
  if (wo.team_leader_id !== req.user.id && !isManagerOf(wo, req.user)) throw new HttpError(403, 'Forbidden');
  run("UPDATE wo_handovers SET status = 'cancelled' WHERE id = ?", id);
  audit(req, 'cancel_handover', 'work_order', wo.wo_number, null, { handover: id });
  notify([h.to_employee_id, h.from_employee_id], { type: 'handover_cancelled', email: false, title: `${wo.wo_number} - أُلغي التسليم المجدول / Scheduled hand-over cancelled`, body: '', link: link(wo) });
}

// Executed by the scheduler every minute (and immediately for past times)
function runDueHandovers() {
  let n = 0;
  for (const h of all("SELECT * FROM wo_handovers WHERE status = 'scheduled' AND scheduled_at <= ?", nowIso())) {
    const wo = get('SELECT * FROM work_orders WHERE id = ?', h.wo_id);
    const sys = { user: { id: h.created_by }, ip: 'scheduler', get: () => 'scheduler' };
    if (!wo || !['open', 'in_progress'].includes(wo.status)) {
      run("UPDATE wo_handovers SET status = 'failed', failure = ?, executed_at = ? WHERE id = ?", `work order is ${wo?.status}`, nowIso(), h.id);
      continue;
    }
    tx(() => {
      run("UPDATE wo_participants SET role = 'member' WHERE wo_id = ? AND employee_id = ?", wo.id, h.from_employee_id);
      run("INSERT INTO wo_participants(wo_id, employee_id, role) VALUES (?,?, 'leader') ON CONFLICT(wo_id, employee_id) DO UPDATE SET role = 'leader'", wo.id, h.to_employee_id);
      if (h.remove_outgoing) run('DELETE FROM wo_participants WHERE wo_id = ? AND employee_id = ?', wo.id, h.from_employee_id);
      run('UPDATE work_orders SET team_leader_id = ? WHERE id = ?', h.to_employee_id, wo.id);
      // Pending team-leader approval follows the new leader
      run("UPDATE wo_approvals SET expected_employee_id = ? WHERE wo_id = ? AND step = 'team_leader' AND decision = 'pending'", h.to_employee_id, wo.id);
      run("UPDATE wo_handovers SET status = 'completed', executed_at = ? WHERE id = ?", nowIso(), h.id);
      audit(sys, 'handover', 'work_order', wo.wo_number, { team_leader_id: h.from_employee_id }, { team_leader_id: h.to_employee_id, verification: crypto.randomBytes(4).toString('hex').toUpperCase() }, h.reason);
    });
    const to = get('SELECT name_ar, name_en FROM employees WHERE id = ?', h.to_employee_id);
    const o = officialsAt(wo.section_id, nowIso());
    notify([h.to_employee_id, h.from_employee_id, ...team(wo.id), o.section_head?.employee_id], {
      type: 'handover_done', title: `${wo.wo_number} - تم تسليم العمل إلى ${to.name_ar} / Work handed over`,
      body: `${wo.title}\n${h.reason}${h.work_status ? '\n' + h.work_status : ''}`, link: link(wo) + '#schedule', details: W.woDetails(get('SELECT * FROM work_orders WHERE id = ?', wo.id)),
    });
    n++;
  }
  return n;
}

// Alert receivers 1 hour before a hand-over (deduped)
function handoverReminders(once) {
  const soon = new Date(Date.now() + 3600e3).toISOString();
  for (const h of all("SELECT h.*, w.wo_number, w.id wid FROM wo_handovers h JOIN work_orders w ON w.id = h.wo_id WHERE h.status = 'scheduled' AND h.scheduled_at <= ? AND h.scheduled_at > ?", soon, nowIso())) {
    once(`handover-soon-${h.id}`, () => notify([h.to_employee_id, h.from_employee_id], {
      type: 'handover_soon', severity: 'warning', title: `${h.wo_number} - التسليم خلال ساعة / Hand-over within one hour`, body: h.reason, link: `/wo/${h.wid}#schedule`,
    }));
  }
}

const extensionsOf = (woId) => all(`SELECT x.*, r.name_ar req_ar, r.name_en req_en, d.name_ar dec_ar, d.name_en dec_en FROM wo_extensions x
  LEFT JOIN employees r ON r.id = x.requested_by LEFT JOIN employees d ON d.id = x.decided_by WHERE x.wo_id = ? ORDER BY x.id DESC`, woId);
const handoversOf = (woId) => all(`SELECT h.*, f.name_ar from_ar, f.name_en from_en, f.employee_no from_no, t.name_ar to_ar, t.name_en to_en, t.employee_no to_no FROM wo_handovers h
  JOIN employees f ON f.id = h.from_employee_id JOIN employees t ON t.id = h.to_employee_id WHERE h.wo_id = ? ORDER BY h.id DESC`, woId);

module.exports = { requestExtension, decideExtension, cancelExtension, scheduleHandover, cancelHandover, runDueHandovers, handoverReminders, extensionsOf, handoversOf, isManagerOf };

'use strict';
const { all, get, setting } = require('./db');
const { notify, idsByRole, once } = require('./notify');
const { officialsAt } = require('./org');
const { nowIso, todayRiyadh, fmt } = require('./util');
const { both } = require('./i18n');

const officials = (wo) => JSON.parse(wo.officials_json || '{}');
const ids = (...xs) => xs.map((x) => (typeof x === 'object' ? x?.employee_id : x)).filter(Boolean);
const team = (woId) => all('SELECT employee_id FROM wo_participants WHERE wo_id = ?', woId).map((r) => r.employee_id);
const addDays = (dateStr, n) => new Date(Date.parse(dateStr + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Each check is idempotent: alert_keys guarantees one alert per condition.
function runAlertChecks() {
  const now = nowIso();
  const nowMs = Date.now();
  const today = todayRiyadh();
  let count = 0;
  const fire = (key, fn) => once(key, () => { count++; fn(); });

  // 1. Critical response SLA: warning at 75 %, escalation on breach
  for (const wo of all(`SELECT * FROM work_orders WHERE due_at IS NOT NULL AND status IN ('open','in_progress') AND arrival_at IS NULL`)) {
    const o = officials(wo);
    const total = Date.parse(wo.due_at) - Date.parse(wo.created_at);
    const elapsed = nowMs - Date.parse(wo.created_at);
    if (nowMs > Date.parse(wo.due_at)) {
      fire(`sla-breach-${wo.id}`, () => notify(ids(wo.team_leader_id, o.section_head, o.division_manager, o.department_manager, ...idsByRole('safety')), {
        type: 'sla_breach', severity: 'critical',
        title: `${wo.wo_number} - تجاوز زمن الاستجابة ${wo.priority} - تصعيد / Response time breached - escalated`,
        body: `${wo.title}\nالموعد / Due: ${fmt(wo.due_at, 'en')}`, link: `/wo/${wo.id}`,
      }));
    } else if (elapsed > total * 0.75) {
      fire(`sla-warn-${wo.id}`, () => notify(ids(wo.team_leader_id, o.section_head, ...team(wo.id)), {
        type: 'sla_warning', severity: 'warning',
        title: `${wo.wo_number} - اقتراب موعد الاستجابة / Response deadline approaching`,
        body: `${wo.title}\nالموعد / Due: ${fmt(wo.due_at, 'en')}`, link: `/wo/${wo.id}`,
      }));
    }
  }

  // 2. Work past planned end and not closed
  for (const wo of all(`SELECT * FROM work_orders WHERE status IN ('open','in_progress') AND planned_end < ?`, now)) {
    fire(`overdue-${wo.id}-${wo.planned_end}`, () => notify(ids(wo.team_leader_id, officials(wo).section_head), {
      type: 'wo_overdue', severity: 'warning',
      title: `${wo.wo_number} - تجاوز موعد الانتهاء المخطط / Past planned end`,
      body: `${wo.title}\n${both('st_' + wo.status)}`, link: `/wo/${wo.id}`,
    }));
  }

  // 3. Open work that has not started by planned start (+1h)
  for (const wo of all(`SELECT * FROM work_orders WHERE status = 'open' AND planned_start < ?`, new Date(nowMs - 3600e3).toISOString())) {
    fire(`not-started-${wo.id}`, () => notify(ids(wo.team_leader_id, ...team(wo.id)), {
      type: 'wo_not_started', severity: 'warning', email: false,
      title: `${wo.wo_number} - لم يبدأ العمل بعد / Work not started yet`, body: wo.title, link: `/wo/${wo.id}`,
    }));
  }

  // 4. In progress for too long without a before photo
  const photoHours = Number(setting('missing_photo_hours'));
  for (const wo of all(`SELECT w.* FROM work_orders w WHERE w.status = 'in_progress' AND w.actual_start < ?
      AND NOT EXISTS (SELECT 1 FROM wo_photos p WHERE p.wo_id = w.id AND p.stage = 'before')`, new Date(nowMs - photoHours * 3600e3).toISOString())) {
    fire(`no-before-photo-${wo.id}`, () => notify(ids(wo.team_leader_id, ...team(wo.id)), {
      type: 'missing_photo', severity: 'warning',
      title: `${wo.wo_number} - لا توجد صورة قبل العمل / No before photo uploaded`, body: wo.title, link: `/wo/${wo.id}`,
    }));
  }

  // 5. Approval reminders (repeat once per reminder window)
  const remindH = Number(setting('approval_reminder_hours'));
  for (const a of all(`SELECT a.*, w.wo_number, w.title, w.section_id, w.team_leader_id FROM wo_approvals a JOIN work_orders w ON w.id = a.wo_id
      WHERE a.decision = 'pending' AND a.requested_at < ?`, new Date(nowMs - remindH * 3600e3).toISOString())) {
    const holder = a.step === 'team_leader' ? a.team_leader_id : a.step === 'foreman' ? (a.expected_employee_id || require('./org').foremenOf(a.section_id)[0]) : (officialsAt(a.section_id, now)[a.step]?.employee_id || a.expected_employee_id);
    const windowNo = Math.floor((nowMs - Date.parse(a.requested_at)) / (remindH * 3600e3));
    fire(`approval-remind-${a.id}-${windowNo}`, () => notify(ids(holder), {
      type: 'approval_reminder', severity: 'warning',
      title: `${a.wo_number} - تذكير: اعتماد معلق (${both('step_' + a.step)}) / Reminder: approval pending`,
      body: a.title, link: `/wo/${a.wo_id}`,
    }));
  }

  // 6. Equipment expiry / calibration
  const expDays = Number(setting('expiry_alert_days'));
  const horizon = addDays(today, expDays);
  for (const q of all(`SELECT * FROM equipment WHERE (expiry_date IS NOT NULL AND expiry_date <= ?) OR (calibration_due IS NOT NULL AND calibration_due <= ?)`, horizon, horizon)) {
    for (const [field, label] of [['expiry_date', 'انتهاء الصلاحية / expiry'], ['calibration_due', 'المعايرة / calibration']]) {
      const d = q[field];
      if (!d || d > horizon) continue;
      const expired = d < today;
      fire(`eq-${field}-${q.id}-${d}-${expired ? 'x' : 'soon'}`, () => notify(idsByRole('admin', 'safety'), {
        type: 'equipment_expiry', severity: expired ? 'critical' : 'warning',
        title: `${q.code} ${q.name} - ${expired ? 'منتهية / expired' : 'قريبة الانتهاء / expiring soon'} (${label}: ${d})`,
        body: both('et_' + q.type), link: q.type === 'vehicle' ? `/fleet/${q.id}` : '/equipment',
      }));
    }
  }

  // 7. Acting assignments starting/expiring soon
  const actDays = Number(setting('acting_alert_days'));
  for (const a of all(`SELECT a.*, u.code, u.name_ar, u.name_en FROM acting_assignments a JOIN org_units u ON u.id = a.unit_id
      WHERE a.cancelled = 0 AND a.end_at > ? AND a.end_at < ?`, now, new Date(nowMs + actDays * 864e5).toISOString())) {
    fire(`acting-expiring-${a.id}`, () => notify([a.acting_employee_id, ...idsByRole('hr')], {
      type: 'acting_expiring', severity: 'info',
      title: `انتهاء تكليف قريب: ${a.name_ar} / Acting assignment ending: ${a.name_en}`,
      body: `${fmt(a.end_at, 'en')}`, link: '/acting',
    }));
  }
  for (const a of all(`SELECT a.*, u.name_ar, u.name_en FROM acting_assignments a JOIN org_units u ON u.id = a.unit_id
      WHERE a.cancelled = 0 AND a.start_at <= ? AND a.end_at > ?`, now, now)) {
    fire(`acting-started-${a.id}`, () => notify([a.acting_employee_id], {
      type: 'acting_started', title: `بدأ تكليفك: ${a.name_ar} / Your acting assignment started: ${a.name_en}`,
      body: `${fmt(a.start_at, 'en')} → ${fmt(a.end_at, 'en')}`, link: '/acting',
    }));
  }

  // 8. Unverified reservations on open work
  for (const r of all(`SELECT r.*, w.wo_number, w.id wid, w.planned_start FROM material_reservations r JOIN work_orders w ON w.id = r.wo_id
      WHERE r.verified = 0 AND w.status IN ('open','in_progress')`)) {
    fire(`res-unverified-${r.id}`, () => notify(idsByRole('warehouse'), {
      type: 'reservation_unverified', severity: 'warning',
      title: `${r.wo_number} - حجز بانتظار التحقق ${r.reservation_number} / Reservation awaiting verification`,
      body: `Planned start: ${fmt(r.planned_start, 'en')}`, link: `/wo/${r.wid}`,
    }));
  }

  // 9. Temporary repairs need follow-up
  for (const wo of all(`SELECT * FROM work_orders WHERE status = 'closed' AND result IN ('temporary','follow_up')`)) {
    fire(`temp-repair-${wo.id}`, () => notify(ids(officials(wo).section_head, officials(wo).division_manager), {
      type: 'temporary_repair', severity: 'warning',
      title: `${wo.wo_number} - إصلاح مؤقت يحتاج متابعة / Temporary repair needs follow-up`, body: wo.title, link: `/wo/${wo.id}`,
    }));
  }

  // 10. Employees starting leave today who are on active work
  for (const r of all(`SELECT DISTINCT l.id lid, e.id eid, e.employee_no, e.name_ar, w.id wid, w.wo_number, w.team_leader_id, w.officials_json
      FROM leaves l JOIN employees e ON e.id = l.employee_id
      JOIN wo_participants p ON p.employee_id = e.id JOIN work_orders w ON w.id = p.wo_id
      WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? AND w.status IN ('open','in_progress')
      AND substr(w.planned_end,1,10) >= ?`, today, today, today)) {
    fire(`leave-conflict-${r.lid}-${r.wid}`, () => notify(ids(r.team_leader_id, officials(r).section_head), {
      type: 'leave_conflict', severity: 'warning',
      title: `${r.wo_number} - موظف في إجازة: ${r.employee_no} ${r.name_ar} / Team member on leave`,
      body: '', link: `/wo/${r.wid}`,
    }));
  }

  // 11. Hand-overs: remind 1 hour before, then execute when due
  const WC = require('./wo_changes');
  WC.handoverReminders(fire);
  count += WC.runDueHandovers();

  // 12a. Travel limits (catches imports and hand-overs too)
  count += require('./travel').checkAlerts();

  // Automatic daily task send (Settings: daily_dispatch_time) and low-stock checks
  count += require('./tasks').autoDispatch();
  require('./items').lowStockCheck();

  // Overdue daily tasks and the Sunday weekly summary for managers
  count += require('./sync').overdueTasks();
  count += require('./documents').checkExpiry();
  count += require('./sync').weeklyDigest();

  // 12. Pending extension requests older than the reminder window
  for (const x of all(`SELECT x.*, w.wo_number, w.section_id FROM wo_extensions x JOIN work_orders w ON w.id = x.wo_id WHERE x.status = 'pending' AND x.requested_at < ?`, new Date(nowMs - remindH * 3600e3).toISOString())) {
    const o = officialsAt(x.section_id, now);
    fire(`ext-remind-${x.id}`, () => notify(ids(o.section_head, o.division_manager), {
      type: 'extension_reminder', severity: 'warning', title: `${x.wo_number} - تذكير: طلب تمديد معلق / Reminder: extension request pending`, body: x.reason, link: `/wo/${x.wo_id}#schedule`,
    }));
  }

  // 13. Annual review of improvement plans (runs once per year, in January, for the previous year)
  if (today.slice(5, 7) === '01') fire(`plans-review-${Number(today.slice(0, 4)) - 1}`, () => require('./plans').annualReview(Number(today.slice(0, 4)) - 1));

  return count;
}

module.exports = { runAlertChecks };

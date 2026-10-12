'use strict';
// Annual points: every employee opens the year with the opening balance (default 10,000).
// Only approved transactions move the balance; values are never edited, only reversed.
const { all, get, run, tx, setting, setSetting } = require('./db');
const { nowIso, audit, HttpError, todayRiyadh } = require('./util');
const { notify, idsByRole } = require('./notify');
const { officialsAt } = require('./org');

const REQUESTERS = ['team_leader', 'section_head', 'division_manager', 'department_manager', 'sector_head', 'safety', 'hr'];
const APPROVERS = ['division_manager', 'department_manager', 'sector_head', 'hr'];
const RATINGS = ['excellent', 'very_good', 'good', 'satisfactory', 'acceptable'];
const SAFETY_ATTENDANCE_CAP = 600;
const EXCLUDED_ROLES = ['admin', 'auditor'];

// Values from section 11 of the requirements (configurable, pending policy approval)
const DEFAULT_RULES = [
  ['wo_closed', 'إغلاق أمر عمل معتمد', 'Approved work order closed', 100, 'work', 1],
  ['wo_critical_closed', 'إغلاق حالة حرجة معتمدة', 'Approved critical case closed', 200, 'work', 1],
  ['project_completion', 'إنجاز مشروع معتمد', 'Approved project completion', 1500, 'work', 0],
  ['safety_meeting_attendance', 'حضور اجتماع سلامة معتمد', 'Approved safety meeting attendance', 50, 'safety_attendance', 0],
  ['deliver_safety_meeting', 'تقديم اجتماع سلامة', 'Delivering a safety meeting', 100, 'safety', 0],
  ['lead_drill', 'قيادة تمرين إخلاء/إنقاذ', 'Leading an evacuation/rescue drill', 150, 'safety', 0],
  ['lesson_learned', 'درس مستفاد معتمد', 'Approved lesson learned', 75, 'safety', 0],
  ['close_corrective_action', 'إغلاق إجراء تصحيحي', 'Closing a corrective action', 50, 'safety', 0],
  ['technical_contribution', 'مساهمة فنية موثقة', 'Documented technical contribution', 25, 'general', 0],
  ['safety_violation', 'مخالفة سلامة', 'Safety violation', -800, 'violation', 0],
  ['ethical_misconduct', 'مخالفة سلوكية', 'Ethical misconduct', -2500, 'violation', 0],
  ['traffic_violation', 'مخالفة مرورية', 'Traffic violation', -3000, 'violation', 0],
  ['reversal', 'عكس عملية', 'Reversal of a transaction', 0, 'system', 1],
];

function ensureRules() {
  for (const [code, ar, en, pts, cat, auto] of DEFAULT_RULES) {
    run('INSERT OR IGNORE INTO point_rules(code, name_ar, name_en, points, category, auto) VALUES (?,?,?,?,?,?)', code, ar, en, pts, cat, auto);
  }
}

const opening = () => Number(setting('points_opening_balance'));
const currentYear = () => Number(todayRiyadh().slice(0, 4));

function tierSizes() {
  const raw = get("SELECT value FROM settings WHERE key = 'rating_tiers'")?.value || '2,2,2,2';
  return raw.split(',').map((n) => Math.max(0, parseInt(n, 10) || 0)).slice(0, 4);
}
function setTierSizes(sizes) { setSetting('rating_tiers', sizes.map((n) => Math.max(0, parseInt(n, 10) || 0)).join(',')); }

// Rating from rank position: the first N get Excellent, the next M Very good, ... rest Acceptable
function ratingForRank(rank, sizes = tierSizes()) {
  let cum = 0;
  for (let i = 0; i < sizes.length; i++) {
    cum += sizes[i];
    if (rank <= cum) return RATINGS[i];
  }
  return 'acceptable';
}

/**
 * Leaderboard for a year. Employees whose balance exceeds the opening balance are ranked
 * (ties share a rank) and awarded a rating; the rest are listed as not eligible.
 */
function leaderboard(year = currentYear(), { sectionId } = {}) {
  const open = opening();
  const rows = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.job_title_en, e.role, s.code section_code,
      COALESCE((SELECT SUM(points) FROM point_transactions p WHERE p.employee_id = e.id AND p.year = ? AND p.status IN ('approved','reversed')), 0) delta,
      (SELECT COUNT(*) FROM point_transactions p WHERE p.employee_id = e.id AND p.year = ? AND p.status = 'pending') pending
    FROM employees e LEFT JOIN org_units s ON s.id = e.section_id
    WHERE e.status = 'active' AND e.role NOT IN (${EXCLUDED_ROLES.map(() => '?').join(',')}) ${sectionId ? 'AND e.section_id = ?' : ''}`,
  year, year, ...EXCLUDED_ROLES, ...(sectionId ? [sectionId] : []));
  rows.forEach((r) => { r.balance = open + r.delta; });
  rows.sort((a, b) => b.balance - a.balance || a.employee_no.localeCompare(b.employee_no));
  // Ranking is always computed over everyone so a section filter does not change ranks
  const ranked = sectionId ? leaderboard(year).rows : null;
  const sizes = tierSizes();
  let rank = 0, prev = null, pos = 0;
  for (const r of rows) {
    if (r.balance > open) {
      pos++;
      if (r.balance !== prev) { rank = pos; prev = r.balance; }
      r.rank = ranked ? ranked.find((x) => x.id === r.id).rank : rank;
      r.rating = ranked ? ranked.find((x) => x.id === r.id).rating : ratingForRank(r.rank, sizes);
      r.awarded = true;
    } else {
      r.rank = null;
      r.rating = null;
      r.awarded = false;
      r.below = r.balance < open;
    }
  }
  return { rows, opening: open, sizes, year };
}

function standing(employeeId, year = currentYear()) {
  return leaderboard(year).rows.find((r) => r.id === employeeId) || null;
}

function statement(employeeId, year = currentYear()) {
  return all(`SELECT p.*, r.name_ar rule_ar, r.name_en rule_en, q.name_ar req_ar, q.name_en req_en, d.name_ar dec_ar, d.name_en dec_en
    FROM point_transactions p JOIN point_rules r ON r.code = p.rule_code
    LEFT JOIN employees q ON q.id = p.requested_by LEFT JOIN employees d ON d.id = p.decided_by
    WHERE p.employee_id = ? AND p.year = ? ORDER BY p.id DESC`, employeeId, year);
}

function approversFor(employeeId) {
  const e = get('SELECT section_id FROM employees WHERE id = ?', employeeId);
  const o = e?.section_id ? officialsAt(e.section_id, nowIso()) : {};
  return [o.division_manager?.employee_id, ...idsByRole('hr')].filter(Boolean);
}

function request({ employeeIds, ruleCode, reference, reason }, req) {
  if (!REQUESTERS.includes(req.user.role)) throw new HttpError(403, 'Not allowed to request points / غير مصرح');
  const rule = get('SELECT * FROM point_rules WHERE code = ? AND active = 1 AND auto = 0', ruleCode);
  if (!rule) throw new HttpError(400, 'Choose an active point rule / اختر قاعدة نقاط');
  if (!reason) throw new HttpError(400, 'Reason is required / السبب مطلوب');
  const ids = [...new Set((employeeIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new HttpError(400, 'Choose at least one employee / اختر موظفًا');
  if (ids.includes(req.user.id)) throw new HttpError(400, 'You cannot request points for yourself / لا يمكنك طلب نقاط لنفسك');
  const year = currentYear();
  const created = tx(() => ids.map((id) => {
    if (rule.category === 'safety_attendance') {
      const used = get(`SELECT COALESCE(SUM(p.points),0) n FROM point_transactions p JOIN point_rules r ON r.code = p.rule_code
        WHERE p.employee_id = ? AND p.year = ? AND r.category = 'safety_attendance' AND p.status IN ('pending','approved')`, id, year).n;
      if (used + rule.points > SAFETY_ATTENDANCE_CAP) {
        const e = get('SELECT employee_no FROM employees WHERE id = ?', id);
        throw new HttpError(400, `${e.employee_no}: annual safety-attendance cap of ${SAFETY_ATTENDANCE_CAP} points reached / تم بلوغ الحد السنوي`);
      }
    }
    const r = run('INSERT INTO point_transactions(employee_id, year, rule_code, points, reference, reason, requested_by) VALUES (?,?,?,?,?,?,?)',
      id, year, rule.code, rule.points, reference || null, reason, req.user.id);
    audit(req, 'request', 'points', r.lastInsertRowid, null, { employee_id: id, rule: rule.code, points: rule.points, reference, reason });
    return Number(r.lastInsertRowid);
  }));
  const approvers = new Set(ids.flatMap(approversFor));
  approvers.delete(req.user.id);
  notify([...approvers], {
    type: 'points_request', severity: rule.points < 0 ? 'warning' : 'info',
    title: `طلب ${rule.points < 0 ? 'خصم' : 'منح'} نقاط بانتظار اعتمادك / Points ${rule.points < 0 ? 'deduction' : 'award'} awaiting your approval`,
    body: `${rule.name_ar} / ${rule.name_en}: ${rule.points > 0 ? '+' : ''}${rule.points} × ${ids.length}\n${reason}`, link: '/points#pending',
  });
  return created;
}

function decide(id, approve, comment, req) {
  const p = get('SELECT p.*, r.name_ar, r.name_en FROM point_transactions p JOIN point_rules r ON r.code = p.rule_code WHERE p.id = ?', id);
  if (!p || p.status !== 'pending') throw new HttpError(400, 'Not pending / ليس بانتظار الاعتماد');
  if (!APPROVERS.includes(req.user.role)) throw new HttpError(403, 'Not an approver / لست معتمدًا');
  if (p.requested_by === req.user.id || p.employee_id === req.user.id) throw new HttpError(403, 'Requester or employee cannot approve / لا يجوز لمقدم الطلب أو الموظف الاعتماد');
  if (!approve && !comment) throw new HttpError(400, 'A comment is required to reject / التعليق مطلوب عند الرفض');
  const status = approve ? 'approved' : 'rejected';
  run('UPDATE point_transactions SET status = ?, decided_by = ?, decided_at = ?, decision_comment = ? WHERE id = ?', status, req.user.id, nowIso(), comment || null, id);
  audit(req, approve ? 'approve' : 'reject', 'points', id, { status: 'pending' }, { status }, comment);
  const sign = p.points > 0 ? '+' : '';
  notify([p.employee_id], {
    type: 'points_decision', severity: approve && p.points < 0 ? 'warning' : 'info',
    title: approve ? `${sign}${p.points} نقطة: ${p.name_ar} / ${sign}${p.points} points: ${p.name_en}` : `رُفض طلب نقاط / Points request rejected`,
    body: `${p.reason || ''}${approve && p.points < 0 ? '\nيمكنك الاعتراض من صفحة النقاط / You may appeal from the points page' : ''}`,
    link: `/points/employee/${p.employee_id}`,
  });
  if (p.requested_by) notify([p.requested_by], { type: 'points_decision', email: false, title: `${approve ? 'اعتُمد' : 'رُفض'} طلب النقاط / Points request ${status}`, body: p.reason, link: '/points' });
}

function reverse(id, reason, req) {
  if (!['hr', 'department_manager', 'sector_head'].includes(req.user.role)) throw new HttpError(403, 'Not allowed / غير مصرح');
  if (!reason) throw new HttpError(400, 'Reason is required / السبب مطلوب');
  const p = get('SELECT * FROM point_transactions WHERE id = ?', id);
  if (!p || p.status !== 'approved' || p.rule_code === 'reversal') throw new HttpError(400, 'Only approved transactions can be reversed / يمكن عكس العمليات المعتمدة فقط');
  tx(() => {
    run('UPDATE point_transactions SET status = ? WHERE id = ?', 'reversed', id);
    run(`INSERT INTO point_transactions(employee_id, year, rule_code, points, reference, reason, status, requested_by, decided_by, decided_at, reversal_of)
      VALUES (?,?,?,?,?,?, 'approved', ?, ?, ?, ?)`, p.employee_id, p.year, 'reversal', -p.points, p.reference, reason, req.user.id, req.user.id, nowIso(), id);
    audit(req, 'reverse', 'points', id, { status: 'approved', points: p.points }, { status: 'reversed', reversal_points: -p.points }, reason);
  });
  notify([p.employee_id], { type: 'points_reversed', title: `عُكست عملية نقاط (${-p.points > 0 ? '+' : ''}${-p.points}) / Points transaction reversed`, body: reason, link: `/points/employee/${p.employee_id}` });
}

function appeal(id, reason, req) {
  const p = get('SELECT * FROM point_transactions WHERE id = ?', id);
  if (!p || p.employee_id !== req.user.id) throw new HttpError(403, 'Forbidden');
  if (p.status !== 'approved' || p.points >= 0 || p.appeal_at) throw new HttpError(400, 'Only approved deductions can be appealed once / يمكن الاعتراض على الخصم المعتمد مرة واحدة');
  if (!reason) throw new HttpError(400, 'Reason is required / السبب مطلوب');
  run('UPDATE point_transactions SET appeal_reason = ?, appeal_at = ? WHERE id = ?', reason, nowIso(), id);
  audit(req, 'appeal', 'points', id, null, { reason });
  notify([...idsByRole('hr'), ...approversFor(p.employee_id)], {
    type: 'points_appeal', severity: 'warning', title: `اعتراض على خصم نقاط / Appeal against a points deduction`,
    body: reason, link: `/points/employee/${p.employee_id}`,
  });
}

// Called when a work order is finally approved and closed: the closure is the approved event.
function awardClosure(wo, participantIds, approverId) {
  const code = ['C1', 'C2', 'C3', 'C4'].includes(wo.priority) || wo.type === 'critical' ? 'wo_critical_closed' : 'wo_closed';
  const rule = get('SELECT * FROM point_rules WHERE code = ? AND active = 1', code);
  if (!rule || !rule.points) return;
  const year = currentYear();
  for (const id of participantIds) {
    if (get('SELECT 1 FROM point_transactions WHERE employee_id = ? AND reference = ? AND rule_code = ? AND status <> \'reversed\'', id, wo.wo_number, code)) continue;
    run(`INSERT INTO point_transactions(employee_id, year, rule_code, points, reference, reason, status, requested_by, decided_by, decided_at)
      VALUES (?,?,?,?,?,?, 'approved', ?, ?, ?)`, id, year, code, rule.points, wo.wo_number, wo.title, approverId, approverId, nowIso());
  }
  notify(participantIds, { type: 'points_award', email: false, title: `+${rule.points} نقطة - ${wo.wo_number} / +${rule.points} points`, body: `${rule.name_ar} / ${rule.name_en}`, link: '/points' });
}

module.exports = {
  ensureRules, leaderboard, standing, statement, request, decide, reverse, appeal, awardClosure, ratingForRank,
  tierSizes, setTierSizes, opening, currentYear, REQUESTERS, APPROVERS, RATINGS, DEFAULT_RULES, SAFETY_ATTENDANCE_CAP,
};

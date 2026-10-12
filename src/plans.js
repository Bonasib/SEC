'use strict';
// Improvement plans: employees rated Satisfactory or Acceptable (or below the opening balance)
// get a plan. Each year the plan is reviewed against the new rating:
//   Good or better            -> plan closed as "improved"
//   no improvement in 3 years -> transfer to another department is RECOMMENDED;
//                                HR / management confirm it (never automatic).
const { all, get, run, tx } = require('./db');
const { nowIso, audit, HttpError } = require('./util');
const { notify, idsByRole } = require('./notify');
const { officialsAt } = require('./org');
const P = require('./points');

const TRIGGERS = ['satisfactory', 'acceptable'];
const IMPROVED = ['excellent', 'very_good', 'good'];
const PLAN_YEARS = 3;
const DECIDERS = ['hr', 'department_manager', 'sector_head'];

const ratingKey = (row) => (!row ? 'not_ranked' : row.rating || (row.below ? 'below' : 'not_ranked'));
const sys = (req) => req || { user: { id: null }, ip: 'scheduler', get: () => 'scheduler' };

function defaultGoals(rating) {
  return [
    'رفع الأداء إلى تقدير "جيد" أو أعلى خلال السنة / Reach a "Good" rating or higher this year',
    'إغلاق أوامر العمل بصور قبل/بعد كاملة واعتماد في الوقت / Close work orders with complete before/after photos, on time',
    'حضور اجتماعات السلامة وعدم تسجيل مخالفات / Attend safety meetings with zero violations',
    rating === 'below' ? 'معالجة أسباب الخصومات مع الرئيس المباشر / Address the causes of deductions with the supervisor' : null,
  ].filter(Boolean).join('\n');
}

/** Create plans for everyone whose rating for `year` triggers one (skips existing open plans). */
function createPlans(year, req) {
  const board = P.leaderboard(year).rows;
  const created = [];
  for (const r of board) {
    const key = ratingKey(r);
    if (![...TRIGGERS, 'below'].includes(key)) continue;
    if (get("SELECT 1 FROM improvement_plans WHERE employee_id = ? AND status IN ('active','transfer_recommended')", r.id)) continue;
    const e = get('SELECT section_id FROM employees WHERE id = ?', r.id);
    const coach = e.section_id ? officialsAt(e.section_id, nowIso()).section_head?.employee_id : null;
    const T = require('./training');
    const sug = T.suggestions({ limit: 500 }).find((s) => s.id === r.id);
    const actions = sug ? sug.courses.map((c) => `دورة / Course: ${c.title_ar} / ${c.title_en} (${c.start_date})`).join('\n') : null;
    const res = run(`INSERT INTO improvement_plans(employee_id, start_year, trigger_rating, goals, actions, coach_id, created_by) VALUES (?,?,?,?,?,?,?)`,
      r.id, year, key, defaultGoals(key), actions, coach || null, sys(req).user.id);
    const id = Number(res.lastInsertRowid);
    run('INSERT INTO plan_reviews(plan_id, year, balance, rating, improved, notes) VALUES (?,?,?,?,0,?)', id, year, r.balance, key, 'Plan opened');
    audit(sys(req), 'create', 'improvement_plan', id, null, { employee_id: r.id, year, rating: key });
    notify([r.id, coach], {
      type: 'plan_created', severity: 'warning',
      title: `خطة تحسين للأداء ${year} / Performance improvement plan ${year}`,
      body: `التقدير / Rating: ${key}\nالمدة القصوى ${PLAN_YEARS} سنوات / Maximum ${PLAN_YEARS} years`, link: `/plans/${id}`,
    });
    created.push(id);
  }
  if (created.length) notify(idsByRole('hr'), { type: 'plans_created', email: false, title: `أُنشئت ${created.length} خطة تحسين / ${created.length} improvement plans created`, body: String(year), link: '/plans' });
  return created;
}

/** Review open plans for `year`; recommend transfer after three years without improvement. */
function reviewPlans(year, req) {
  const board = Object.fromEntries(P.leaderboard(year).rows.map((r) => [r.id, r]));
  const out = { improved: 0, continued: 0, transfer: 0 };
  for (const p of all("SELECT * FROM improvement_plans WHERE status = 'active' AND start_year <= ?", year)) {
    if (get('SELECT 1 FROM plan_reviews WHERE plan_id = ? AND year = ?', p.id, year)) continue;
    const row = board[p.employee_id];
    const key = ratingKey(row);
    const improved = IMPROVED.includes(key);
    const yearsReviewed = year - p.start_year + 1;
    tx(() => {
      run('INSERT INTO plan_reviews(plan_id, year, balance, rating, improved) VALUES (?,?,?,?,?)', p.id, year, row ? row.balance : P.opening(), key, improved ? 1 : 0);
      if (improved) run("UPDATE improvement_plans SET status = 'improved', closed_at = ? WHERE id = ?", nowIso(), p.id);
      else if (yearsReviewed >= PLAN_YEARS) run("UPDATE improvement_plans SET status = 'transfer_recommended' WHERE id = ?", p.id);
      audit(sys(req), 'review', 'improvement_plan', p.id, { status: p.status }, { year, rating: key, improved });
    });
    const e = get('SELECT employee_no, name_ar, section_id FROM employees WHERE id = ?', p.employee_id);
    const o = e.section_id ? officialsAt(e.section_id, nowIso()) : {};
    if (improved) {
      out.improved++;
      notify([p.employee_id, p.coach_id], { type: 'plan_improved', title: `تحسن الأداء - أُغلقت خطة التحسين / Performance improved - plan closed`, body: `${year}: ${key}`, link: `/plans/${p.id}` });
    } else if (yearsReviewed >= PLAN_YEARS) {
      out.transfer++;
      notify([...idsByRole('hr'), o.department_manager?.employee_id, p.coach_id], {
        type: 'plan_transfer', severity: 'critical',
        title: `توصية بنقل ${e.employee_no} ${e.name_ar} إلى إدارة أخرى / Transfer recommended`,
        body: `لم يتحسن الأداء خلال ${PLAN_YEARS} سنوات (${p.start_year}–${year}). يتطلب قرارًا من الموارد البشرية.\nNo improvement within ${PLAN_YEARS} years. HR decision required.`, link: `/plans/${p.id}`,
      });
      notify([p.employee_id], { type: 'plan_transfer', severity: 'warning', title: 'نتيجة المراجعة السنوية لخطة التحسين / Improvement plan annual review', body: `${year}: ${key}`, link: `/plans/${p.id}` });
    } else {
      out.continued++;
      notify([p.employee_id, p.coach_id], {
        type: 'plan_review', severity: 'warning', title: `المراجعة السنوية ${year}: تستمر خطة التحسين (السنة ${yearsReviewed} من ${PLAN_YEARS}) / Plan continues (year ${yearsReviewed} of ${PLAN_YEARS})`,
        body: key, link: `/plans/${p.id}`,
      });
    }
  }
  return out;
}

/** Full annual cycle: review existing plans, then open new ones. Runs automatically each January. */
function annualReview(year, req) {
  const reviewed = reviewPlans(year, req);
  const created = createPlans(year, req);
  return { ...reviewed, created: created.length };
}

function confirmTransfer(planId, { sectionId, decisionNo }, req) {
  if (!DECIDERS.includes(req.user.role)) throw new HttpError(403, 'Only HR or management can confirm a transfer / القرار للموارد البشرية أو الإدارة');
  const p = get('SELECT * FROM improvement_plans WHERE id = ?', planId);
  if (!p || p.status !== 'transfer_recommended') throw new HttpError(400, 'Transfer is not recommended for this plan / لا توجد توصية نقل');
  const e = get('SELECT * FROM employees WHERE id = ?', p.employee_id);
  const to = get("SELECT * FROM org_units WHERE id = ? AND level = 'section'", Number(sectionId));
  if (!to) throw new HttpError(400, 'Choose the new section / اختر القسم الجديد');
  if (to.id === e.section_id) throw new HttpError(400, 'Choose a different section / اختر قسمًا مختلفًا');
  if (!decisionNo) throw new HttpError(400, 'Decision number is required / رقم القرار مطلوب');
  const fromHead = e.section_id ? officialsAt(e.section_id, nowIso()).section_head?.employee_id : null;
  tx(() => {
    run('UPDATE employees SET section_id = ? WHERE id = ?', to.id, e.id);
    run("UPDATE improvement_plans SET status = 'transferred', transfer_to_section_id = ?, transfer_decision_no = ?, closed_at = ? WHERE id = ?", to.id, decisionNo, nowIso(), p.id);
    audit(req, 'transfer', 'employee', e.employee_no, { section_id: e.section_id }, { section_id: to.id, decision_no: decisionNo, plan: p.id });
  });
  const toHead = officialsAt(to.id, nowIso()).section_head?.employee_id;
  notify([e.id, fromHead, toHead], {
    type: 'employee_transferred', severity: 'warning', title: `نقل ${e.name_ar} إلى ${to.name_ar} / Transfer to ${to.name_en}`,
    body: `قرار رقم / Decision: ${decisionNo}`, link: `/employees/${e.id}`,
  });
}

// HR may instead keep the employee for one more year (documented decision)
function extendPlan(planId, note, req) {
  if (!DECIDERS.includes(req.user.role)) throw new HttpError(403, 'Forbidden');
  const p = get('SELECT * FROM improvement_plans WHERE id = ?', planId);
  if (!p || p.status !== 'transfer_recommended') throw new HttpError(400, 'Not awaiting a transfer decision');
  if (!note) throw new HttpError(400, 'Justification is required / المبرر مطلوب');
  run("UPDATE improvement_plans SET status = 'active', start_year = start_year + 1 WHERE id = ?", p.id);
  audit(req, 'extend', 'improvement_plan', p.id, { status: p.status, start_year: p.start_year }, { status: 'active', start_year: p.start_year + 1 }, note);
  notify([p.employee_id, p.coach_id], { type: 'plan_extended', title: 'تمديد خطة التحسين سنة إضافية / Improvement plan extended by one year', body: note, link: `/plans/${p.id}` });
}

function updatePlan(planId, { goals, actions, coachId }, req) {
  const p = get('SELECT * FROM improvement_plans WHERE id = ?', planId);
  if (!p) throw new HttpError(404, 'Not found');
  const allowed = DECIDERS.includes(req.user.role) || p.coach_id === req.user.id || req.user.role === 'admin';
  if (!allowed) throw new HttpError(403, 'Forbidden');
  run('UPDATE improvement_plans SET goals = ?, actions = ?, coach_id = ? WHERE id = ?', goals || null, actions || null, Number(coachId) || p.coach_id, p.id);
  audit(req, 'update', 'improvement_plan', p.id, { goals: p.goals, actions: p.actions }, { goals, actions });
  notify([p.employee_id], { type: 'plan_updated', email: false, title: 'تم تحديث خطة التحسين / Improvement plan updated', body: '', link: `/plans/${p.id}` });
}

function closePlan(planId, note, req) {
  if (!DECIDERS.includes(req.user.role)) throw new HttpError(403, 'Forbidden');
  const p = get('SELECT * FROM improvement_plans WHERE id = ?', planId);
  if (!p || !['active', 'transfer_recommended'].includes(p.status)) throw new HttpError(400, 'Not open');
  if (!note) throw new HttpError(400, 'Reason is required / السبب مطلوب');
  run("UPDATE improvement_plans SET status = 'closed', closed_at = ? WHERE id = ?", nowIso(), p.id);
  audit(req, 'close', 'improvement_plan', p.id, { status: p.status }, { status: 'closed' }, note);
}

module.exports = { createPlans, reviewPlans, annualReview, confirmTransfer, extendPlan, updatePlan, closePlan, PLAN_YEARS, TRIGGERS, IMPROVED, DECIDERS, ratingKey };

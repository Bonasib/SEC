'use strict';
// Cross-module coordination: keeps work orders, daily tasks, leave, stock and summaries in step.
const { all, get, run } = require('./db');
const { audit, nowIso, todayRiyadh } = require('./util');
const { notify, once, emailHtml } = require('./notify');

const assignees = (taskId) => all('SELECT employee_id FROM task_assignees WHERE task_id = ?', taskId).map((r) => r.employee_id);

/** A work order closed or cancelled settles its linked daily tasks. */
function onWorkOrderStatus(wo, status, req) {
  const next = status === 'closed' ? 'done' : status === 'cancelled' ? 'cancelled' : null;
  if (!next) return 0;
  const tasks = all("SELECT * FROM tasks WHERE wo_id = ? AND status = 'open'", wo.id);
  for (const t of tasks) {
    run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', next, nowIso(), t.id);
    audit(req, 'status', 'task', t.id, { status: 'open' }, { status: next }, `${wo.wo_number} ${status}`);
    notify(assignees(t.id), {
      type: 'task_updated', email: false, title: `${t.title} - ${next === 'done' ? 'أُنجزت مع إغلاق' : 'أُلغيت مع إلغاء'} ${wo.wo_number} / ${next === 'done' ? 'Done with' : 'Cancelled with'} ${wo.wo_number}`,
      body: t.task_date, link: `/tasks?day=${t.task_date}`,
    });
  }
  return tasks.length;
}

/** New or changed leave: warn about open daily tasks the employee can no longer do. */
function onLeave(employeeId, from, to) {
  const tasks = all(`SELECT t.* FROM tasks t JOIN task_assignees a ON a.task_id = t.id WHERE a.employee_id = ? AND t.status = 'open' AND t.task_date BETWEEN ? AND ?`, employeeId, from, to);
  const e = get('SELECT employee_no, name_ar FROM employees WHERE id = ?', employeeId);
  for (const t of tasks) {
    notify([t.created_by], {
      type: 'task_conflict', severity: 'warning', email: false,
      title: `${t.title} - المكلف في إجازة: ${e.employee_no} ${e.name_ar} / Assignee on leave`,
      body: `${t.task_date} · أعد إسناد المهمة / Please reassign`, link: `/tasks/${t.id}/edit#task-form`,
    });
  }
  return tasks.length;
}

/** Yesterday's (or older) open tasks: remind the creator and the assignees once. */
function overdueTasks() {
  let n = 0;
  for (const t of all("SELECT * FROM tasks WHERE status = 'open' AND task_date < ? AND task_date >= date(?, '-14 days')", todayRiyadh(), todayRiyadh())) {
    once(`task-overdue-${t.id}`, () => {
      n++;
      notify([t.created_by, ...assignees(t.id)], {
        type: 'task_overdue', severity: 'warning', email: false,
        title: `${t.title} - لم تُنجز في موعدها / Not completed on time`, body: t.task_date, link: `/tasks?day=${t.task_date}`,
      });
    });
  }
  return n;
}

/** Sunday morning (Riyadh): managers receive last week's summary and the outstanding employees. */
function weeklyDigest() {
  const now = new Date(Date.now() + 3 * 3600e3);
  if (now.getUTCDay() !== 0 || now.getUTCHours() < 7) return 0;
  const today = now.toISOString().slice(0, 10);
  let sent = 0;
  once(`weekly-digest-${today}`, () => {
    const B = require('./board');
    const D = require('./i18n').D;
    const recipients = all("SELECT * FROM employees WHERE status = 'active' AND role IN ('section_head','division_manager','department_manager','sector_head','admin')");
    for (const u of recipients) {
      const data = B.build({ period: 'week' }, u);
      const tot = data.summary.totals;
      const details = Object.keys(tot).map((k) => [`${D['bev_' + k][0]} / ${D['bev_' + k][1]}`, String(tot[k])]);
      data.honor.podium.forEach((p, i) => details.push([`المتميز ${i + 1} / Outstanding #${i + 1}`, `${p.employee_no} ${p.name_ar} · ${p.score}`]));
      const title = `${data.p.from} → ${data.p.to} - الملخص الأسبوعي / Weekly summary`;
      notify([u.id], { type: 'weekly_digest', email: false, title, body: `${data.events.length} أحداث / events`, link: '/board?period=week' });
      if (u.email) {
        run('INSERT INTO emails(to_email, to_name, subject, html) VALUES (?,?,?,?)', u.email, u.name_ar, title,
          emailHtml({ title, body: 'ملخص أحداث الأسبوع الماضي ولوحة الشرف\nLast week’s events and the honor board', details, link: '/board?period=week' }));
      }
      sent++;
    }
  });
  return sent;
}

module.exports = { onWorkOrderStatus, onLeave, overdueTasks, weeklyDigest };

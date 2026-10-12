'use strict';
// "Needs attention": the next step waiting for this user in every section, in one place on the dashboard.
// Each entry links to the page (already filtered) where the step is done.
const { get, all, setting } = require('./db');
const { can } = require('./access');
const { todayRiyadh } = require('./util');

function followUps(user) {
  const out = [];
  const push = (key, icon, n, href, tone = 'warn') => { if (n > 0) out.push({ key, icon, n, href, tone }); };
  const today = todayRiyadh();
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);
  const D = require('./documents');
  const docCount = (entity, ids) => Object.entries(D.expirySummary(entity)).filter(([id]) => !ids || ids.includes(Number(id)));

  // Files read by the extraction tool, waiting for an auditor (four-eyes: not the uploader's own)
  const X = require('./extract');
  if (X.canReview(user)) push('fu_extractions', 'image', get("SELECT COUNT(*) n FROM extractions WHERE status = 'pending_review' AND created_by <> ?", user.id).n, '/extract?status=pending_review');
  // My own extractions that came back rejected
  push('fu_my_rejected_extractions', 'x-circle', get("SELECT COUNT(*) n FROM extractions WHERE status = 'rejected' AND created_by = ? AND reviewed_at >= ?", user.id, new Date(Date.now() - 7 * 864e5).toISOString()).n, '/extract?status=rejected', 'bad');

  // Inventory
  const I = require('./items');
  if (I.canManage(user)) {
    const s = I.stats();
    push('fu_stock_out', 'boxes', s.out, '/materials?stock=out', 'bad');
    push('fu_stock_low', 'boxes', s.low, '/materials?stock=low');
    push('fu_orders_late', 'package', get("SELECT COUNT(*) n FROM item_orders WHERE status = 'open' AND expected_date IS NOT NULL AND expected_date < ?", today).n, '/materials/transactions?kind=order');
  }

  // Vehicle papers and registration
  if (can(user, 'fleet.manage') === true) {
    const papers = docCount('vehicle').length;
    const reg = get("SELECT COUNT(*) n FROM equipment WHERE type = 'vehicle' AND expiry_date IS NOT NULL AND expiry_date <= ?", horizon).n;
    push('fu_vehicle_docs', 'truck', papers + reg, '/fleet?docs=expiring');
  }
  // Devices and safety equipment due for calibration / expiry
  if (['admin', 'safety'].includes(user.role)) {
    push('fu_devices_due', 'wrench', get("SELECT COUNT(*) n FROM equipment WHERE type <> 'vehicle' AND ((expiry_date IS NOT NULL AND expiry_date <= ?) OR (calibration_due IS NOT NULL AND calibration_due <= ?))", horizon, horizon).n, '/equipment');
  }
  // Employee cards, licences and certificates
  if (can(user, 'employees.manage') === true) push('fu_employee_docs', 'user', docCount('employee').length, '/employees?docs=expiring');
  else push('fu_my_docs', 'user', docCount('employee', [user.id]).length, `/employees/${user.id}#documents`);

  // Improvement plans waiting for the transfer decision
  const PL = require('./plans');
  if (PL.DECIDERS.includes(user.role)) push('fu_plans_transfer', 'route', get("SELECT COUNT(*) n FROM improvement_plans WHERE status = 'transfer_recommended'").n, '/plans?status=transfer_recommended');

  // My open daily tasks from earlier days (not marked done)
  push('fu_tasks_overdue', 'tasks', get(`SELECT COUNT(*) n FROM tasks t WHERE t.status = 'open' AND t.task_date < ? AND t.id IN (SELECT task_id FROM task_assignees WHERE employee_id = ?)`, today, user.id).n, `/tasks?day=${all("SELECT MIN(t.task_date) d FROM tasks t WHERE t.status = 'open' AND t.task_date < ? AND t.id IN (SELECT task_id FROM task_assignees WHERE employee_id = ?)", today, user.id)[0]?.d || today}&to=${today}`);
  return out;
}

module.exports = { followUps };

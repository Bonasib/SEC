'use strict';
const express = require('express');
const { all, get, setting } = require('../db');
const { nowIso, todayRiyadh } = require('../util');
const W = require('../workorders');

const router = express.Router();

router.get('/', (req, res) => {
  const now = nowIso();
  const today = todayRiyadh();
  const year = today.slice(0, 4);
  const n = (sql, ...p) => get(sql, ...p).n;
  const scope = require('../access').woScopeLiteral(req.user);
  const horizon = new Date(Date.parse(today) + Number(setting('expiry_alert_days')) * 864e5).toISOString().slice(0, 10);

  const kpi = {
    open: n(`SELECT COUNT(*) n FROM work_orders w WHERE status = 'open'${scope}`),
    in_progress: n(`SELECT COUNT(*) n FROM work_orders w WHERE status = 'in_progress'${scope}`),
    pending_closure: n(`SELECT COUNT(*) n FROM work_orders w WHERE status = 'pending_closure'${scope}`),
    awaiting_auth: n(`SELECT COUNT(*) n FROM work_orders w WHERE status = 'awaiting_authorization'${scope}`),
    critical_open: n(`SELECT COUNT(*) n FROM work_orders w WHERE priority IN ('C1','C2','C3','C4') AND status IN ('open','in_progress','pending_closure')${scope}`),
    critical_overdue: n(`SELECT COUNT(*) n FROM work_orders w WHERE due_at < ? AND arrival_at IS NULL AND status IN ('open','in_progress')${scope}`, now),
    missing_photos: n(`SELECT COUNT(*) n FROM work_orders w WHERE status IN ('in_progress','pending_closure') AND (NOT EXISTS (SELECT 1 FROM wo_photos p WHERE p.wo_id=w.id AND p.stage='before') OR NOT EXISTS (SELECT 1 FROM wo_photos p WHERE p.wo_id=w.id AND p.stage='after'))${scope}`),
    temporary: n(`SELECT COUNT(*) n FROM work_orders w WHERE status = 'closed' AND result IN ('temporary','follow_up')${scope}`),
    closed_month: n(`SELECT COUNT(*) n FROM work_orders w WHERE status = 'closed' AND closed_at >= ?${scope}`, today.slice(0, 8) + '01'),
    on_leave: n(`SELECT COUNT(DISTINCT employee_id) n FROM leaves WHERE status = 'approved' AND start_date <= ? AND end_date >= ?`, today, today),
    unverified_res: n(`SELECT COUNT(*) n FROM material_reservations r JOIN work_orders w ON w.id = r.wo_id WHERE r.verified = 0 AND w.status IN ('open','in_progress')`),
    expiring_eq: n(`SELECT COUNT(*) n FROM equipment WHERE expiry_date <= ? OR calibration_due <= ?`, horizon, horizon),
  };
  const busy = n(`SELECT COUNT(DISTINCT p.employee_id) n FROM wo_participants p JOIN work_orders w ON w.id = p.wo_id WHERE w.status = 'in_progress'`);
  kpi.available = n("SELECT COUNT(*) n FROM employees WHERE status = 'active' AND role IN ('employee','team_leader')") - kpi.on_leave - busy;

  const dispatcher = require('../tasks').canDispatch(req.user);
  kpi.tasks_today = dispatcher ? n("SELECT COUNT(*) n FROM tasks WHERE task_date = ? AND status = 'open'", today)
    : n("SELECT COUNT(*) n FROM tasks t JOIN task_assignees a ON a.task_id = t.id WHERE t.task_date = ? AND t.status = 'open' AND a.employee_id = ?", today, req.user.id);
  kpi.stock_low = require('../items').list({ stock: 'low' }).length;
  const myTasks = all(`SELECT t.* FROM tasks t JOIN task_assignees a ON a.task_id = t.id WHERE a.employee_id = ? AND t.task_date = ? AND t.status <> 'cancelled' ORDER BY IFNULL(t.start_time, '99')`, req.user.id, today);
  const stars = require('../board').honor(require('../board').period({ period: 'month' })).podium;
  const unreconciled = all(`SELECT m.* FROM material_lines m JOIN work_orders w ON w.id = m.wo_id WHERE w.status IN ('in_progress','pending_closure')`).filter((l) => W.lineErrors(l).length).length;
  kpi.unreconciled = unreconciled;

  const byStatus = all(`SELECT status, COUNT(*) n FROM work_orders w WHERE 1=1${scope} GROUP BY status`);
  const byDistance = all(`SELECT distance_category c, COUNT(*) n, ROUND(SUM(distance_km)) km FROM work_orders w WHERE status <> 'cancelled' AND substr(planned_start,1,4) = ?${scope} GROUP BY distance_category`, year);
  const acting = all(`SELECT a.*, u.name_ar u_ar, u.name_en u_en, e.name_ar, e.name_en FROM acting_assignments a JOIN org_units u ON u.id = a.unit_id JOIN employees e ON e.id = a.acting_employee_id
    WHERE a.cancelled = 0 AND a.start_at <= ? AND a.end_at >= ? ORDER BY a.end_at`, now, now);
  const myApprovals = all(`SELECT a.*, w.wo_number, w.title, w.priority, w.section_id, w.team_leader_id FROM wo_approvals a JOIN work_orders w ON w.id = a.wo_id
    WHERE a.decision = 'pending' AND a.id = (SELECT MIN(id) FROM wo_approvals x WHERE x.wo_id = a.wo_id AND x.decision = 'pending') ORDER BY a.id`)
    .filter((a) => W.canDecide({ id: a.wo_id, section_id: a.section_id, team_leader_id: a.team_leader_id }, a, req.user).ok);
  const myWork = all(`SELECT w.* FROM work_orders w JOIN wo_participants p ON p.wo_id = w.id WHERE p.employee_id = ? AND w.status IN ('awaiting_authorization','open','in_progress','pending_closure') ORDER BY w.planned_start LIMIT 10`, req.user.id);
  const critical = all(`SELECT w.* FROM work_orders w WHERE priority IN ('C1','C2','C3','C4') AND status IN ('open','in_progress','pending_closure')${scope} ORDER BY due_at LIMIT 10`);
  const alerts = all('SELECT * FROM notifications WHERE employee_id = ? ORDER BY id DESC LIMIT 8', req.user.id);
  const points = require('../points');
  const board = points.leaderboard();
  const top = req.user.role === 'employee' ? [] : board.rows.filter((r) => r.awarded).slice(0, 5);
  const me = board.rows.find((r) => r.id === req.user.id);
  const upcoming = require('../calendar').eventsBetween(todayRiyadh(), require('../calendar').addDays(todayRiyadh(), 14), { sectionId: req.user.section_id || null })
    .filter((e) => e.kind !== 'work').slice(0, 8);
  const WC = require('../wo_changes');
  const myExtensions = all(`SELECT x.*, w.wo_number, w.title, w.section_id, w.id wid FROM wo_extensions x JOIN work_orders w ON w.id = x.wo_id WHERE x.status = 'pending'`)
    .filter((x) => WC.isManagerOf({ section_id: x.section_id }, req.user));
  const myHandovers = all(`SELECT h.*, w.wo_number, w.title, w.id wid FROM wo_handovers h JOIN work_orders w ON w.id = h.wo_id
    WHERE h.status = 'scheduled' AND (h.to_employee_id = ? OR h.from_employee_id = ?) ORDER BY h.scheduled_at`, req.user.id, req.user.id);
  res.render('dashboard', { myTasks, stars, dispatcher, myExtensions, myHandovers, top, me, opening: board.opening, upcoming, kpi, byStatus, byDistance, acting, myApprovals, myWork, critical, alerts, now, year });
});

module.exports = router;

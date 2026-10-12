'use strict';
// Board: the outstanding employees (honor board) and a summary of everything that happened in a period.
const { all, get } = require('./db');
const { todayRiyadh } = require('./util');
const { can, woScopeLiteral } = require('./access');

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
// Riyadh calendar day of a stored UTC timestamp, in SQL
const rday = (col) => `date(${col}, '+3 hours')`;

function period(q = {}) {
  const today = todayRiyadh();
  const p = ['week', 'month', 'quarter', 'year', 'custom'].includes(q.period) ? q.period : 'month';
  let from, to = today;
  if (p === 'week') from = addDays(today, -6);
  else if (p === 'month') from = today.slice(0, 8) + '01';
  else if (p === 'quarter') { const m = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1; from = `${today.slice(0, 5)}${String(m).padStart(2, '0')}-01`; }
  else if (p === 'year') from = today.slice(0, 5) + '01-01';
  else {
    from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : addDays(today, -29);
    to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') && q.to >= from ? q.to : today;
  }
  return { period: p, from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1 };
}

/** Outstanding employees: points earned in the period, closed work, tasks done; plus the year ranking. */
function honor({ from, to }, sectionId) {
  const sec = sectionId ? 'AND e.section_id = ' + Number(sectionId) : '';
  const people = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.job_title_ar, e.job_title_en, s.code section_code,
      COALESCE((SELECT SUM(p.points) FROM point_transactions p WHERE p.employee_id = e.id AND p.status = 'approved' AND p.points > 0
        AND ${rday('COALESCE(p.decided_at, p.requested_at)')} BETWEEN ? AND ?), 0) pts,
      (SELECT COUNT(*) FROM wo_participants x JOIN work_orders w ON w.id = x.wo_id WHERE x.employee_id = e.id AND w.status = 'closed' AND ${rday('w.closed_at')} BETWEEN ? AND ?) closed,
      (SELECT COUNT(*) FROM task_assignees a JOIN tasks t ON t.id = a.task_id WHERE a.employee_id = e.id AND t.status = 'done' AND t.task_date BETWEEN ? AND ?) tasks_done,
      (SELECT COUNT(*) FROM course_attendees c JOIN courses k ON k.id = c.course_id WHERE c.employee_id = e.id AND c.attendance = 'attended' AND k.end_date BETWEEN ? AND ?) courses
    FROM employees e LEFT JOIN org_units s ON s.id = e.section_id
    WHERE e.status = 'active' AND e.role NOT IN ('admin','auditor','hr','warehouse') ${sec}`, from, to, from, to, from, to, from, to);
  // Points already include closed work orders (+100 each); daily tasks and completed courses add to recognition
  people.forEach((p) => { p.score = p.pts + p.tasks_done * 25 + p.courses * 100; });
  const top = people.filter((p) => p.score > 0).sort((a, b) => b.score - a.score || b.pts - a.pts || a.employee_no.localeCompare(b.employee_no));
  const best = (k) => people.filter((p) => p[k] > 0).sort((a, b) => b[k] - a[k] || a.employee_no.localeCompare(b.employee_no))[0] || null;
  const lb = require('./points').leaderboard(Number(to.slice(0, 4)), { sectionId: sectionId ? Number(sectionId) : undefined });
  return {
    podium: top.slice(0, 3), runners: top.slice(3, 10),
    badges: { points: best('pts'), closer: best('closed'), helper: best('tasks_done'), learner: best('courses') },
    yearTop: lb.rows.filter((r) => r.rank).slice(0, 5),
  };
}

/** Every event in the period as one feed (respecting what the user may see). */
function events({ from, to }, user, sectionId) {
  const scope = woScopeLiteral(user);
  const ws = sectionId ? ` AND w.section_id = ${Number(sectionId)}` : '';
  const seeAll = can(user, 'calendar.view_all') === true;
  const out = [];
  const push = (rows, type, map) => rows.forEach((r) => out.push({ type, ...map(r) }));
  const woCols = 'w.id, w.wo_number, w.title, w.priority, w.status, s.code section_code';
  const woFrom = 'FROM work_orders w LEFT JOIN org_units s ON s.id = w.section_id';

  push(all(`SELECT ${woCols}, w.created_at at FROM work_orders w LEFT JOIN org_units s ON s.id = w.section_id WHERE ${rday('w.created_at')} BETWEEN ? AND ?${ws}${scope}`, from, to),
    'wo_created', (r) => ({ at: r.at, title: `${r.wo_number} · ${r.title}`, link: `/wo/${r.id}`, critical: /^C/.test(r.priority), section: r.section_code }));
  push(all(`SELECT ${woCols}, w.closed_at at ${woFrom} WHERE w.status = 'closed' AND ${rday('w.closed_at')} BETWEEN ? AND ?${ws}${scope}`, from, to),
    'wo_closed', (r) => ({ at: r.at, title: `${r.wo_number} · ${r.title}`, link: `/wo/${r.id}`, section: r.section_code }));
  push(all(`SELECT ${woCols}, a.at at, a.reason ${woFrom} JOIN audit_log a ON a.entity = 'work_order' AND a.entity_id = w.wo_number AND a.action = 'cancel'
      WHERE ${rday('a.at')} BETWEEN ? AND ?${ws}${scope}`, from, to),
    'wo_cancelled', (r) => ({ at: r.at, title: `${r.wo_number} · ${r.title}`, sub: r.reason, link: `/wo/${r.id}`, section: r.section_code }));
  push(all(`SELECT ${woCols}, x.decided_at at, x.new_end ${woFrom} JOIN wo_extensions x ON x.wo_id = w.id WHERE x.status = 'approved' AND ${rday('x.decided_at')} BETWEEN ? AND ?${ws}${scope}`, from, to),
    'extension', (r) => ({ at: r.at, title: `${r.wo_number} · ${r.title}`, link: `/wo/${r.id}#schedule`, section: r.section_code }));
  push(all(`SELECT ${woCols}, h.executed_at at, e.name_ar, e.name_en ${woFrom} JOIN wo_handovers h ON h.wo_id = w.id JOIN employees e ON e.id = h.to_employee_id
      WHERE h.status = 'completed' AND ${rday('h.executed_at')} BETWEEN ? AND ?${ws}${scope}`, from, to),
    'handover', (r) => ({ at: r.at, title: `${r.wo_number} · ${r.title}`, who: { name_ar: r.name_ar, name_en: r.name_en }, link: `/wo/${r.id}#schedule`, section: r.section_code }));

  const tsec = sectionId ? ` AND t.section_id = ${Number(sectionId)}` : '';
  const tscope = seeAll || can(user, 'tasks.dispatch') === true ? '' : ` AND t.id IN (SELECT task_id FROM task_assignees WHERE employee_id = ${Number(user.id)})`;
  push(all(`SELECT t.*, s.code section_code FROM tasks t LEFT JOIN org_units s ON s.id = t.section_id WHERE t.status = 'done' AND t.task_date BETWEEN ? AND ?${tsec}${tscope}`, from, to),
    'task_done', (r) => ({ at: `${r.task_date}T${r.end_time || '12:00'}:00+03:00`, title: r.title, link: `/tasks?day=${r.task_date}`, section: r.section_code }));

  if (seeAll) {
    const lsec = sectionId ? ` AND e.section_id = ${Number(sectionId)}` : '';
    push(all(`SELECT l.*, e.name_ar, e.name_en, e.employee_no FROM leaves l JOIN employees e ON e.id = l.employee_id
        WHERE l.status = 'approved' AND l.start_date BETWEEN ? AND ?${lsec}`, from, to),
      'absence', (r) => ({ at: `${r.start_date}T07:00:00+03:00`, title: r.employee_no, who: { name_ar: r.name_ar, name_en: r.name_en }, leave: r.type, sub: `${r.start_date} → ${r.end_date}`, link: `/employees/${r.employee_id}` }));
  }
  push(all('SELECT * FROM courses WHERE start_date BETWEEN ? AND ? AND status <> \'cancelled\'', from, to),
    'course', (r) => ({ at: `${r.start_date}T08:00:00+03:00`, title: r.title_ar, title_en: r.title_en, sub: `${r.start_date} → ${r.end_date}`, link: `/training/${r.id}` }));
  push(all('SELECT * FROM holidays WHERE start_date BETWEEN ? AND ?', from, to),
    'holiday', (r) => ({ at: `${r.start_date}T00:00:00+03:00`, title: r.name_ar, title_en: r.name_en, sub: r.end_date !== r.start_date ? `${r.start_date} → ${r.end_date}` : r.start_date }));
  const psec = sectionId ? ` AND e.section_id = ${Number(sectionId)}` : '';
  push(all(`SELECT p.*, e.name_ar, e.name_en, e.employee_no, r.name_ar rule_ar, r.name_en rule_en FROM point_transactions p JOIN employees e ON e.id = p.employee_id
      JOIN point_rules r ON r.code = p.rule_code WHERE p.status = 'approved' AND p.points > 0 AND ${rday('COALESCE(p.decided_at, p.requested_at)')} BETWEEN ? AND ?${psec}`, from, to),
    'points', (r) => ({ at: r.decided_at || r.requested_at, title: `+${r.points} · ${r.rule_ar}`, title_en: `+${r.points} · ${r.rule_en}`, who: { name_ar: r.name_ar, name_en: r.name_en }, link: `/points/employee/${r.employee_id}` }));
  if (can(user, 'materials.manage') === true || ['section_head', 'division_manager', 'department_manager', 'sector_head'].includes(user.role)) {
    push(all(`SELECT m.*, i.code, i.name_ar, i.name_en, i.uom FROM item_movements m JOIN items i ON i.id = m.item_id WHERE m.kind IN ('receive','damage') AND ${rday('m.created_at')} BETWEEN ? AND ?`, from, to),
      'stock', (r) => ({ at: r.created_at, title: `${r.code} · ${r.name_ar}`, title_en: `${r.code} · ${r.name_en || r.name_ar}`, sub: `${r.qty > 0 ? '+' : ''}${r.qty} ${r.uom}`, move: r.kind, link: `/materials/${r.item_id}` }));
  }
  out.forEach((e) => { e.day = new Date(Date.parse(e.at) + 3 * 3600e3).toISOString().slice(0, 10); });
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}

/** Created vs closed per day (for the chart) and totals per event type. */
function summary(p, evs) {
  const days = [];
  for (let d = p.from, i = 0; d <= p.to && i < 400; d = addDays(d, 1), i++) days.push({ day: d, created: 0, closed: 0, other: 0 });
  const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
  const totals = {};
  for (const e of evs) {
    totals[e.type] = (totals[e.type] || 0) + 1;
    const d = byDay[e.day];
    if (!d) continue;
    if (e.type === 'wo_created') d.created++; else if (e.type === 'wo_closed') d.closed++; else d.other++;
  }
  return { days, totals, critical: evs.filter((e) => e.critical).length };
}

function upcoming(user, days = 14) {
  const from = todayRiyadh(), to = addDays(from, days);
  return {
    holidays: all('SELECT * FROM holidays WHERE end_date >= ? AND start_date <= ? ORDER BY start_date', from, to),
    courses: all("SELECT * FROM courses WHERE status = 'planned' AND start_date BETWEEN ? AND ? ORDER BY start_date", from, to),
    wos: all(`SELECT w.id, w.wo_number, w.title, w.planned_start, w.priority FROM work_orders w WHERE w.status IN ('open','awaiting_authorization')
      AND ${rday('w.planned_start')} BETWEEN ? AND ?${woScopeLiteral(user)} ORDER BY w.planned_start LIMIT 8`, from, to),
  };
}

function build(q, user) {
  const p = period(q);
  const evs = events(p, user, q.section);
  return { p, honor: honor(p, q.section), events: evs, summary: summary(p, evs), upcoming: upcoming(user) };
}

module.exports = { build, period, honor, events, summary };

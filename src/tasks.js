'use strict';
// Daily tasks: short jobs assigned to employees for a given day, plus the day's active work orders.
// The daily agenda can be sent with one click: each person receives only their own items, or the
// full list goes to chosen employees and external email addresses. Optionally sent automatically.
const { all, get, run, tx, setting } = require('./db');
const { audit, HttpError, todayRiyadh, nowIso, fmt } = require('./util');
const { notify, emailHtml, once } = require('./notify');

const PRIORITIES = ['normal', 'high', 'urgent'];
const STATUSES = ['open', 'done', 'cancelled'];
const WO_ACTIVE = "('awaiting_authorization','open','in_progress')";
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;
const placeholders = (a) => a.map(() => '?').join(',');
const riyadhDate = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10);
const riyadhTime = (iso) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(11, 16);

const canDispatch = (user) => require('./access').can(user, 'tasks.dispatch') === true;

function fromBody(b) {
  const d = {
    task_date: String(b.task_date || '').slice(0, 10), start_time: /^\d{2}:\d{2}$/.test(b.start_time || '') ? b.start_time : null,
    end_time: /^\d{2}:\d{2}$/.test(b.end_time || '') ? b.end_time : null, title: String(b.title || '').trim(), details: String(b.details || '').trim() || null,
    location: String(b.location || '').trim() || null, section_id: Number(b.section_id) || null,
    priority: PRIORITIES.includes(b.priority) ? b.priority : 'normal', status: STATUSES.includes(b.status) ? b.status : 'open',
    wo_id: null,
  };
  const woNo = String(b.wo_number || '').trim().toUpperCase();
  if (woNo) {
    const w = get('SELECT id FROM work_orders WHERE wo_number = ?', woNo);
    if (!w) throw new HttpError(400, `Work order ${woNo} not found / أمر العمل غير موجود`);
    d.wo_id = w.id;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.task_date)) throw new HttpError(400, 'Task date is required / تاريخ المهمة مطلوب');
  if (!d.title) throw new HttpError(400, 'Task title is required / عنوان المهمة مطلوب');
  if (d.start_time && d.end_time && d.end_time < d.start_time) throw new HttpError(400, 'End time is before start time / وقت النهاية قبل البداية');
  const assignees = [...new Set([].concat(b.assignee_ids || []).map(Number).filter(Boolean))];
  if (!assignees.length) throw new HttpError(400, 'Choose at least one employee / اختر موظفًا واحدًا على الأقل');
  return { d, assignees };
}

/** Assignees already on leave that day (warning only: the task may be reassigned). */
function awayWarnings(day, ids) {
  if (!ids.length) return [];
  return all(`SELECT e.employee_no, e.name_ar, l.type FROM leaves l JOIN employees e ON e.id = l.employee_id
    WHERE l.status = 'approved' AND l.start_date <= ? AND l.end_date >= ? AND l.employee_id IN (${placeholders(ids)})`, day, day, ...ids)
    .map((r) => `${r.employee_no} ${r.name_ar}: ${r.type} / غير متاح`);
}

function save(body, req, id) {
  const { d, assignees } = fromBody(body);
  const old = id ? get('SELECT * FROM tasks WHERE id = ?', id) : null;
  if (id && !old) throw new HttpError(404, 'Not found');
  const before = old ? all('SELECT employee_id FROM task_assignees WHERE task_id = ?', id).map((r) => r.employee_id) : [];
  const taskId = tx(() => {
    let tid = id;
    if (id) {
      run(`UPDATE tasks SET task_date=?, start_time=?, end_time=?, title=?, details=?, location=?, section_id=?, priority=?, status=?, wo_id=?, updated_at=? WHERE id=?`,
        ...Object.values(d), nowIso(), id);
      run('DELETE FROM task_assignees WHERE task_id = ?', id);
    } else {
      tid = Number(run(`INSERT INTO tasks(task_date, start_time, end_time, title, details, location, section_id, priority, status, wo_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ...Object.values(d), req.user.id).lastInsertRowid);
    }
    for (const e of assignees) run('INSERT INTO task_assignees(task_id, employee_id) VALUES (?,?)', tid, e);
    audit(req, id ? 'update' : 'create', 'task', tid, old ? { ...old, assignees: before } : null, { ...d, assignees });
    return tid;
  });
  const added = assignees.filter((x) => !before.includes(x));
  const when = `${d.task_date}${d.start_time ? ' ' + d.start_time : ''}${d.end_time ? '–' + d.end_time : ''}`;
  if (added.length) notify(added, { type: 'task_assigned', email: false, severity: d.priority === 'urgent' ? 'warning' : 'info', title: `مهمة يومية: ${d.title} / Daily task`, body: `${when}${d.location ? '\n' + d.location : ''}${d.details ? '\n' + d.details : ''}`, link: `/tasks?day=${d.task_date}` });
  if (old && (old.task_date !== d.task_date || old.start_time !== d.start_time || old.status !== d.status)) {
    const kept = assignees.filter((x) => before.includes(x));
    notify(kept, { type: 'task_updated', email: false, title: `تحديث مهمة: ${d.title} / Task updated`, body: `${when} · ${d.status}`, link: `/tasks?day=${d.task_date}` });
  }
  return { id: taskId, warnings: awayWarnings(d.task_date, assignees) };
}

function setStatus(id, status, req) {
  const t = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!t) throw new HttpError(404, 'Not found');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Bad status');
  const mine = !!get('SELECT 1 FROM task_assignees WHERE task_id = ? AND employee_id = ?', id, req.user.id);
  if (!mine && !canDispatch(req.user)) throw new HttpError(403, 'Forbidden');
  run('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);
  audit(req, 'status', 'task', id, { status: t.status }, { status });
  if (status === 'done' && t.created_by && t.created_by !== req.user.id) {
    notify([t.created_by], { type: 'task_done', email: false, title: `تم إنجاز المهمة: ${t.title} / Task done`, body: `${req.user.employee_no} ${req.user.name_ar}`, link: `/tasks?day=${t.task_date}` });
  }
  return t;
}

const SORTS = { time: "t.task_date, IFNULL(t.start_time,'99')", priority: "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, t.start_time", title: 't.title', status: 't.status, t.start_time', section: 's.code, t.start_time' };

/** Tasks and work orders for a day (or range), with filters. userScope limits to the user's own items. */
function agenda({ day, to, section, status, priority, assignee, q, sort, kinds } = {}, userScope) {
  const from = day || todayRiyadh(), until = to && to >= from ? to : from;
  const tc = ['t.task_date BETWEEN ? AND ?'], tp = [from, until];
  if (section) { tc.push('t.section_id = ?'); tp.push(Number(section)); }
  if (status) { tc.push('t.status = ?'); tp.push(status); } else tc.push("t.status <> 'cancelled'");
  if (priority) { tc.push('t.priority = ?'); tp.push(priority); }
  if (assignee) { tc.push('t.id IN (SELECT task_id FROM task_assignees WHERE employee_id = ?)'); tp.push(Number(assignee)); }
  if (userScope) { tc.push('(t.id IN (SELECT task_id FROM task_assignees WHERE employee_id = ?) OR t.created_by = ?)'); tp.push(userScope.id, userScope.id); }
  if (q) { tc.push('(t.title LIKE ? OR t.details LIKE ? OR t.location LIKE ?)'); tp.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const tasks = kinds === 'wo' ? [] : all(`SELECT t.*, s.code section_code, w.wo_number FROM tasks t LEFT JOIN org_units s ON s.id = t.section_id LEFT JOIN work_orders w ON w.id = t.wo_id
    WHERE ${tc.join(' AND ')} ORDER BY ${SORTS[sort] || SORTS.time}`, ...tp);
  for (const t of tasks) t.people = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.email, e.phone FROM task_assignees a JOIN employees e ON e.id = a.employee_id WHERE a.task_id = ? ORDER BY e.employee_no`, t.id);

  // Work orders whose planned window touches the day(s) (Riyadh dates)
  const wc = [`w.status IN ${WO_ACTIVE}`, "date(w.planned_start, '+3 hours') <= ?", "date(w.planned_end, '+3 hours') >= ?"], wp = [until, from];
  if (section) { wc.push('w.section_id = ?'); wp.push(Number(section)); }
  if (assignee) { wc.push('w.id IN (SELECT wo_id FROM wo_participants WHERE employee_id = ?)'); wp.push(Number(assignee)); }
  if (priority === 'urgent') wc.push("w.priority IN ('C1','C2','C3','C4')");
  else if (priority) wc.push('0');
  if (status && status !== 'open') wc.push('0');
  if (q) { wc.push('(w.wo_number LIKE ? OR w.title LIKE ? OR w.location LIKE ?)'); wp.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (userScope) { const sc = require('./access').woScope(userScope); if (sc.sql) { wc.push(sc.sql); wp.push(...sc.params); } }
  const wos = kinds === 'tasks' ? [] : all(`SELECT w.*, s.code section_code FROM work_orders w LEFT JOIN org_units s ON s.id = w.section_id WHERE ${wc.join(' AND ')} ORDER BY w.planned_start`, ...wp);
  for (const w of wos) {
    w.people = all(`SELECT e.id, e.employee_no, e.name_ar, e.name_en, e.email, e.phone, p.role FROM wo_participants p JOIN employees e ON e.id = p.employee_id WHERE p.wo_id = ? ORDER BY p.role DESC, e.employee_no`, w.id);
    w.vehicles = all("SELECT q.plate_number, q.code FROM wo_equipment x JOIN equipment q ON q.id = x.equipment_id WHERE x.wo_id = ? AND q.type = 'vehicle'", w.id);
  }
  return { from, until, tasks, wos };
}

// One line per item, used for emails, notifications and the WhatsApp text
function taskLine(t) {
  const time = t.start_time ? `${t.start_time}${t.end_time ? '–' + t.end_time : ''}` : '—';
  return { when: `${t.task_date !== undefined && t.multi ? t.task_date + ' ' : ''}${time}`, what: `${t.title}${t.location ? ' · ' + t.location : ''}${t.priority !== 'normal' ? ` [${t.priority}]` : ''}${t.wo_number ? ' · ' + t.wo_number : ''}${t.details ? '\n' + t.details : ''}` };
}
function woLine(w) {
  const lead = w.people.find((p) => p.role === 'leader');
  return {
    when: `${w.wo_number} · ${riyadhTime(w.planned_start)}`,
    what: `${w.title}${w.location ? ' · ' + w.location : ''}${w.priority !== 'normal' ? ` [${w.priority}]` : ''}${lead ? ` · قائد/Leader: ${lead.name_ar}` : ''}${w.vehicles.length ? ' · ' + w.vehicles.map((v) => v.plate_number || v.code).join(', ') : ''}`,
  };
}

function plainText(day, lines, message) {
  return [`المهام اليومية / Daily tasks — ${day}`, message || null, ...lines.map((l, i) => `${i + 1}. ${l.when} — ${l.what}`)].filter(Boolean).join('\n');
}

function waLink(phone, text) {
  let p = String(phone || '').replace(/\D/g, '');
  if (!p) return null;
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('05') && p.length === 10) p = '966' + p.slice(1);
  if (p.startsWith('5') && p.length === 9) p = '966' + p;
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

/**
 * Build the messages without sending them (used for the preview and by dispatch()).
 * mode 'each': every assigned person gets only their items. mode 'selected': chosen recipients get all selected items.
 */
function buildMessages({ day, to, taskIds = [], woIds = [], mode = 'each', recipientIds = [], externalEmails = [], message } = {}) {
  const a = agenda({ day, to });
  const tIds = new Set(taskIds.map(Number)), wIds = new Set(woIds.map(Number));
  const tasks = a.tasks.filter((t) => tIds.has(t.id) && t.status === 'open');
  const wos = a.wos.filter((w) => wIds.has(w.id));
  const multi = a.from !== a.until;
  tasks.forEach((t) => { t.multi = multi; });
  const label = multi ? `${a.from} → ${a.until}` : a.from;
  const out = [];
  if (mode === 'each') {
    const byPerson = new Map();
    const add = (p, line) => { if (!byPerson.has(p.id)) byPerson.set(p.id, { person: p, lines: [] }); byPerson.get(p.id).lines.push(line); };
    tasks.forEach((t) => t.people.forEach((p) => add(p, taskLine(t))));
    wos.forEach((w) => w.people.forEach((p) => add(p, woLine(w))));
    for (const { person, lines } of byPerson.values()) out.push({ employee: person, email: person.email, lines });
  } else {
    const lines = [...tasks.map(taskLine), ...wos.map(woLine)];
    const people = recipientIds.length ? all(`SELECT id, employee_no, name_ar, name_en, email, phone FROM employees WHERE status = 'active' AND id IN (${placeholders(recipientIds)})`, ...recipientIds.map(Number)) : [];
    people.forEach((p) => out.push({ employee: p, email: p.email, lines }));
    const known = new Set(people.map((p) => (p.email || '').toLowerCase()));
    externalEmails.filter((e) => !known.has(e.toLowerCase())).forEach((e) => out.push({ employee: null, email: e, lines }));
  }
  for (const m of out) {
    m.text = plainText(label, m.lines, message);
    m.wa = m.employee ? waLink(m.employee.phone, m.text) : null;
  }
  return { label, messages: out.filter((m) => m.lines.length), items: tasks.length + wos.length, tasks, wos };
}

function parseEmails(s) {
  const list = String(s || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const bad = list.filter((x) => !EMAIL_RE.test(x));
  if (bad.length) throw new HttpError(400, `Invalid email: ${bad.join(', ')} / بريد غير صالح`);
  return [...new Set(list)];
}

function dispatch(opts, req, { automatic = false } = {}) {
  if (!opts.taskIds?.length && !opts.woIds?.length) throw new HttpError(400, 'Select at least one task or work order / اختر مهمة أو أمر عمل');
  if (opts.mode === 'selected' && !opts.recipientIds?.length && !opts.externalEmails?.length) throw new HttpError(400, 'Choose the recipients / اختر المستلمين');
  const built = buildMessages(opts);
  if (!built.messages.length) throw new HttpError(400, 'Nobody to send to: the selected items have no assigned employees / لا يوجد مستلمون');
  let emails = 0;
  const title = `المهام اليومية ${built.label} / Daily tasks`;
  for (const m of built.messages) {
    const details = m.lines.map((l) => [l.when, l.what]);
    const body = `${opts.message ? opts.message + '\n\n' : ''}${m.lines.length} ${m.lines.length === 1 ? 'مهمة / item' : 'مهام / items'}`;
    if (m.employee) {
      // In-app alert always; email when the employee has an address (even if alerts by email are off: this is an explicit send)
      notify([m.employee.id], { type: 'daily_tasks', title, body: m.text, link: `/tasks?day=${opts.day || todayRiyadh()}`, email: false });
    }
    if (m.email) {
      run('INSERT INTO emails(to_email, to_name, subject, html) VALUES (?,?,?,?)', m.email, m.employee ? m.employee.name_ar : null, title,
        emailHtml({ title, body, details, link: m.employee ? `/tasks?day=${opts.day || todayRiyadh()}` : null }));
      emails++;
    }
  }
  const r = run('INSERT INTO task_dispatches(day, mode, recipients, emails, items, message, detail_json, sent_by, automatic) VALUES (?,?,?,?,?,?,?,?,?)',
    built.label, opts.mode || 'each', built.messages.length, emails, built.items, opts.message || null,
    JSON.stringify(built.messages.map((m) => ({ employee_no: m.employee?.employee_no || null, name: m.employee?.name_ar || null, email: m.email || null, items: m.lines.length }))),
    req?.user?.id ?? null, automatic ? 1 : 0);
  audit(req, 'dispatch', 'daily_tasks', built.label, null, { mode: opts.mode, recipients: built.messages.length, emails, items: built.items, automatic });
  return { id: Number(r.lastInsertRowid), recipients: built.messages.length, emails, items: built.items, messages: built.messages };
}

/** Automatic morning send (Settings → daily_dispatch_time, e.g. 06:00): every person receives their own items. */
function autoDispatch() {
  const at = setting('daily_dispatch_time');
  if (!/^\d{2}:\d{2}$/.test(at || '')) return 0;
  const now = new Date(Date.now() + 3 * 3600e3).toISOString();
  const day = now.slice(0, 10), time = now.slice(11, 16);
  if (time < at) return 0;
  let sent = 0;
  once(`daily-dispatch-${day}`, () => {
    const a = agenda({ day });
    const opts = { day, mode: 'each', taskIds: a.tasks.filter((t) => t.status === 'open').map((t) => t.id), woIds: a.wos.map((w) => w.id) };
    if (!opts.taskIds.length && !opts.woIds.length) return;
    try { sent = dispatch(opts, { user: null, ip: 'scheduler', get: () => 'scheduler' }, { automatic: true }).recipients; } catch (e) { if (e.status !== 400) throw e; }
  });
  return sent;
}

function history(limit = 20) {
  return all(`SELECT d.*, e.name_ar, e.name_en FROM task_dispatches d LEFT JOIN employees e ON e.id = d.sent_by ORDER BY d.id DESC LIMIT ?`, limit);
}

module.exports = { PRIORITIES, STATUSES, canDispatch, save, setStatus, agenda, buildMessages, dispatch, autoDispatch, parseEmails, history, waLink, riyadhDate };

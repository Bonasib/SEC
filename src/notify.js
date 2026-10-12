'use strict';
const nodemailer = require('nodemailer');
const { all, get, run } = require('./db');
const { esc, nowIso } = require('./util');

const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const SMTP_ON = !!process.env.SMTP_HOST;

const transporter = SMTP_ON
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;
const FROM = process.env.MAIL_FROM || 'Transmission WMS <no-reply@example.com>';

const SEVERITY_COLOR = { info: '#1f4e79', warning: '#b7791f', critical: '#c53030' };

function emailHtml({ title, body, link, severity = 'info', details }) {
  const rows = (details || [])
    .map(([k, v]) => `<tr><td style="padding:6px 10px;border:1px solid #e2e8f0;background:#f7fafc;font-weight:bold">${esc(k)}</td><td style="padding:6px 10px;border:1px solid #e2e8f0">${esc(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html><body style="font-family:Tahoma,Arial,sans-serif;background:#f1f5f9;padding:20px">
  <div style="max-width:620px;margin:auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0">
    <div style="background:${SEVERITY_COLOR[severity] || SEVERITY_COLOR.info};color:#fff;padding:14px 18px;font-size:16px;font-weight:bold">${esc(title)}</div>
    <div style="padding:18px;line-height:1.7;color:#1a202c">
      <p style="white-space:pre-line">${esc(body || '')}</p>
      ${rows ? `<table style="border-collapse:collapse;width:100%;margin:12px 0">${rows}</table>` : ''}
      ${link ? `<p><a href="${APP_URL}${link}" style="display:inline-block;background:#1f4e79;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">فتح في النظام / Open in system</a></p>` : ''}
    </div>
    <div style="padding:10px 18px;font-size:11px;color:#718096;background:#f7fafc">نظام نقل الطاقة - رسالة آلية / SEC Transmission WMS - automated message</div>
  </div></body></html>`;
}

/**
 * Create an in-app alert for each recipient and queue an email to those who
 * have an address and email notifications enabled.
 */
function notify(employeeIds, { type, severity = 'info', title, body, link, details, email = true }) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  for (const id of ids) {
    run('INSERT INTO notifications(employee_id, type, severity, title, body, link) VALUES (?,?,?,?,?,?)', id, type, severity, title, body || null, link || null);
    if (!email) continue;
    const e = get('SELECT email, name_ar, name_en, email_notifications, status FROM employees WHERE id = ?', id);
    if (e && e.email && e.email_notifications && e.status === 'active') {
      run('INSERT INTO emails(to_email, to_name, subject, html) VALUES (?,?,?,?)', e.email, e.name_ar, title, emailHtml({ title, body, link, severity, details }));
    }
  }
}

// Employees holding any of the given roles
const idsByRole = (...roles) =>
  all(`SELECT id FROM employees WHERE status = 'active' AND role IN (${roles.map(() => '?').join(',')})`, ...roles).map((r) => r.id);

// Run fn only the first time `key` is seen (dedupes scheduled alerts)
function once(key, fn) {
  const r = run('INSERT OR IGNORE INTO alert_keys(key, created_at) VALUES (?, ?)', key, nowIso());
  if (r.changes) fn();
}

let sending = false;
async function processEmailQueue() {
  if (sending) return;
  sending = true;
  try {
    const batch = all("SELECT * FROM emails WHERE status = 'queued' OR (status = 'failed' AND attempts < 5) ORDER BY id LIMIT 20");
    for (const m of batch) {
      if (!transporter) {
        run("UPDATE emails SET status = 'outbox' WHERE id = ?", m.id);
        continue;
      }
      try {
        await transporter.sendMail({ from: FROM, to: m.to_name ? `"${m.to_name}" <${m.to_email}>` : m.to_email, subject: m.subject, html: m.html });
        run("UPDATE emails SET status = 'sent', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?", nowIso(), m.id);
      } catch (err) {
        run("UPDATE emails SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?", String(err.message).slice(0, 500), m.id);
      }
    }
  } finally {
    sending = false;
  }
}

module.exports = { notify, idsByRole, once, processEmailQueue, emailHtml, SMTP_ON, APP_URL };

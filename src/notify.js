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

const SEVERITY = {
  info: { color: '#0e5aa7', soft: '#eff6ff', ar: 'إشعار', en: 'Notice' },
  warning: { color: '#b45309', soft: '#fffbeb', ar: 'تنبيه', en: 'Warning' },
  critical: { color: '#c53030', soft: '#fef2f2', ar: 'عاجل', en: 'Urgent' },
};
const AR = /[؀-ۿ]/;

// "عربي / English" -> { ar, en } so both languages get their own direction and line
function splitBilingual(text) {
  const s = String(text ?? '');
  const i = s.lastIndexOf(' / ');
  if (i > 0 && AR.test(s.slice(0, i)) && !AR.test(s.slice(i + 3))) {
    const ar = s.slice(0, i);
    // Keep a shared prefix such as "WO000123 - " on the English line too
    const prefix = (ar.match(/^[^\u0600-\u06FF]+? - /) || [''])[0];
    return { ar, en: prefix + s.slice(i + 3) };
  }
  return AR.test(s) ? { ar: s, en: '' } : { ar: '', en: s };
}
const line = (txt, size, color, weight = 400) => {
  const { ar, en } = splitBilingual(txt);
  return [ar && `<div dir="rtl" style="text-align:right;font-size:${size}px;color:${color};font-weight:${weight};line-height:1.6">${esc(ar)}</div>`,
    en && `<div dir="ltr" style="text-align:left;font-size:${Math.max(12, size - 2)}px;color:${color};font-weight:${weight};line-height:1.6;opacity:.85">${esc(en)}</div>`].filter(Boolean).join('');
};

/**
 * One email template for every message: brand header, severity, bilingual title,
 * body (each line in its own direction), a details table, an action button and a footer.
 */
function emailHtml({ title, body, link, severity = 'info', details }) {
  const sev = SEVERITY[severity] || SEVERITY.info;
  const bodyHtml = String(body || '').split('\n').filter((l) => l.trim()).map((l) => `<div dir="auto" style="margin:0 0 6px;font-size:14px;color:#1e293b;line-height:1.7">${esc(l)}</div>`).join('');
  const rows = (details || []).map(([k, v], i) => {
    const { ar, en } = splitBilingual(k);
    return `<tr style="background:${i % 2 ? '#ffffff' : '#f8fafc'}">
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;width:38%;vertical-align:top"><div dir="rtl" style="text-align:right;font-weight:700;color:#334155;font-size:13px">${esc(ar || en)}</div>${ar && en ? `<div dir="ltr" style="text-align:left;color:#64748b;font-size:11px">${esc(en)}</div>` : ''}</td>
      <td dir="auto" style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:13px;white-space:pre-line">${esc(v)}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#eef2f7;font-family:Tahoma,'Segoe UI',Arial,sans-serif">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dbe3ee">
    <div style="background:#0b2545;padding:14px 20px">
      <table role="presentation" width="100%" style="border-collapse:collapse"><tr>
        <td style="color:#ffffff;font-size:15px;font-weight:700">⚡ نقل الطاقة · Transmission WMS</td>
        <td style="text-align:end"><span style="display:inline-block;background:${sev.color};color:#ffffff;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700">${sev.ar} · ${sev.en}</span></td>
      </tr></table>
    </div>
    <div style="height:4px;background:${sev.color}"></div>
    <div style="padding:20px 22px 6px;background:${sev.soft}">${line(title, 18, '#0f172a', 700)}</div>
    <div style="padding:16px 22px">
      ${bodyHtml}
      ${rows ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:14px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">${rows}</table>` : ''}
      ${link ? `<div style="text-align:center;margin:20px 0 8px"><a href="${APP_URL}${link}" style="display:inline-block;background:#0e5aa7;color:#ffffff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">فتح في النظام · Open in system</a></div>` : ''}
    </div>
    <div style="padding:12px 22px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;line-height:1.7">
      <div dir="rtl" style="text-align:right">رسالة آلية من نظام إدارة أوامر العمل والصيانة - نقل الطاقة. لا ترد على هذه الرسالة.</div>
      <div dir="ltr" style="text-align:left">Automated message from the SEC Transmission work order system. Please do not reply.</div>
    </div>
  </div>
</body></html>`;
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

module.exports = { notify, idsByRole, once, processEmailQueue, emailHtml, splitBilingual, SMTP_ON, APP_URL };

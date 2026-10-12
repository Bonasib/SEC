'use strict';
const crypto = require('node:crypto');
const { run } = require('./db');

// Asia/Riyadh is UTC+3 all year (no DST), so conversion is a fixed offset.
const RIYADH_OFFSET_MS = 3 * 3600 * 1000;

const nowIso = () => new Date().toISOString();

// "2026-10-12T08:30" typed in Riyadh local time -> UTC ISO string
function localToUtc(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).trim();
  if (!s) return null;
  if (/[zZ]|[+-]\d\d:\d\d$/.test(s)) return new Date(s).toISOString();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) {
    const d = new Date(s);
    if (isNaN(d)) throw new Error(`Invalid date: ${s}`);
    return d.toISOString();
  }
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - RIYADH_OFFSET_MS;
  return new Date(utc).toISOString();
}

// UTC ISO -> "YYYY-MM-DDTHH:MM" Riyadh local (for datetime-local inputs and exports)
function utcToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + RIYADH_OFFSET_MS);
  return d.toISOString().slice(0, 16);
}

function fmt(iso, lang = 'ar', withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

// Today's date (YYYY-MM-DD) in Riyadh
const todayRiyadh = () => new Date(Date.now() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function audit(req, action, entity, entityId, before, after, reason) {
  run(
    'INSERT INTO audit_log(employee_id, action, entity, entity_id, before_json, after_json, reason, ip, device) VALUES (?,?,?,?,?,?,?,?,?)',
    req?.user?.id ?? null, action, entity, entityId == null ? null : String(entityId),
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason || null,
    req?.ip || null, req?.get ? (req.get('user-agent') || '').slice(0, 200) : 'system',
  );
}

function distanceCategory(km) {
  const n = Number(km) || 0;
  if (n < 100) return 'A';
  if (n <= 200) return 'B';
  return 'C';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

module.exports = {
  nowIso, localToUtc, utcToLocalInput, fmt, todayRiyadh, hashPassword, verifyPassword,
  audit, distanceCategory, esc, HttpError,
};

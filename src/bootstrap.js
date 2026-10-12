'use strict';
// First start in production: no sample data. Creates the company root unit, the point rules,
// the fixed public holidays and one administrator account. Everything else (organization,
// employees, assets, fleet, courses...) is entered or imported from Excel by the administrator/HR.
const crypto = require('node:crypto');
const { run, get, tx } = require('./db');
const { hashPassword, todayRiyadh } = require('./util');

function bootstrapProduction() {
  const adminNo = (process.env.ADMIN_EMPLOYEE_NO || 'admin').trim();
  let password = process.env.ADMIN_PASSWORD || '';
  let generated = false;
  if (password.length < 10) {
    password = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  tx(() => {
    run(`INSERT INTO org_units(code, level, name_ar, name_en) VALUES ('SEC-TR', 'company', ?, ?)`,
      process.env.COMPANY_NAME_AR || 'الشركة السعودية للكهرباء - نقل الطاقة', process.env.COMPANY_NAME_EN || 'Saudi Electricity Company - Transmission');
    run(`INSERT INTO employees(employee_no, name_ar, name_en, email, role, password_hash, is_sample) VALUES (?, 'مشغل النظام', 'System Administrator', ?, 'admin', ?, 0)`,
      adminNo, process.env.ADMIN_EMAIL || null, hashPassword(password));
    const y = Number(todayRiyadh().slice(0, 4));
    for (const year of [y, y + 1]) {
      run("INSERT OR IGNORE INTO holidays(start_date, end_date, name_ar, name_en, kind, approximate) VALUES (?, ?, 'يوم التأسيس', 'Founding Day', 'public', 0)", `${year}-02-22`, `${year}-02-22`);
      run("INSERT OR IGNORE INTO holidays(start_date, end_date, name_ar, name_en, kind, approximate) VALUES (?, ?, 'اليوم الوطني', 'National Day', 'public', 0)", `${year}-09-23`, `${year}-09-23`);
    }
    run("INSERT OR REPLACE INTO sequences(name, value) VALUES ('wo', 0)");
  });
  require('./points').ensureRules();
  console.log('──────────────────────────────────────────────────────────────');
  console.log(' Production database created (no sample data).');
  console.log(` Administrator login: ${adminNo}`);
  if (generated) {
    console.log(` Temporary password:  ${password}`);
    console.log(' ADMIN_PASSWORD was not set (min 10 chars). Sign in and change this password now.');
  } else {
    console.log(' Password: the ADMIN_PASSWORD you configured.');
  }
  console.log(' Next: Import & Export → organization, employees, assets, fleet, courses.');
  console.log('──────────────────────────────────────────────────────────────');
}

const isDemoDatabase = () => !!get('SELECT 1 FROM employees WHERE is_sample = 1 LIMIT 1');

/**
 * Older demo databases carried "(تجريبي)", "(عينة)", "(demo)" and "(sample)" after names and titles.
 * Remove those words once, from every text column. Runs only on a demo database, never on real data.
 */
function cleanDemoLabels() {
  const { db, setting, setSetting } = require('./db');
  if (setting('demo_labels_cleaned') === '1' || !isDemoDatabase()) return 0;
  const RE = /\s*\((?:تجريبي|تجريبية|عينة|demo|sample)\)/gi;
  db.function('strip_demo_label', { deterministic: true }, (v) => (typeof v === 'string' ? v.replace(RE, '') : v));
  const like = ['(تجريبي)', '(تجريبية)', '(عينة)', '(demo)', '(sample)'];
  let n = 0;
  const { tx } = require('./db');
  tx(() => {
    // Sample employees had "F001 (sample)" as their English name: they have no English name
    n += Number(db.prepare("UPDATE employees SET name_en = NULL WHERE is_sample = 1 AND name_en = employee_no || ' (sample)'").run().changes);
    // The audit log is immutable and the email outbox is a record of what was sent: both stay as they are
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('audit_log', 'emails')").all()) {
      for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) {
        if (!/TEXT/i.test(c.type) || c.name === 'password_hash') continue;
        const where = like.map(() => `"${c.name}" LIKE ?`).join(' OR ');
        n += Number(db.prepare(`UPDATE "${name}" SET "${c.name}" = strip_demo_label("${c.name}") WHERE ${where}`).run(...like.map((l) => `%${l}%`)).changes);
      }
    }
  });
  setSetting('demo_labels_cleaned', '1');
  if (n) console.log(`Removed demo/sample labels from ${n} values.`);
  return n;
}

module.exports = { bootstrapProduction, isDemoDatabase, cleanDemoLabels };

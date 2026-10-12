'use strict';
// Consistent online backup of the SQLite database (safe while the app is running).
// Usage: npm run backup            -> <DATA_DIR or ./data>/backups/app-YYYYMMDD-HHMM.db
// Keeps the newest BACKUP_KEEP files (default 14). Back up the uploads folder separately (photos).
const fs = require('node:fs');
const path = require('node:path');
const { db, DB_PATH } = require('./db');

const dir = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
const file = path.join(dir, `app-${stamp}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log(`Backup written: ${file}`);
const keep = Number(process.env.BACKUP_KEEP || 14);
const old = fs.readdirSync(dir).filter((f) => /^app-\d{8}-\d{4}\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.rmSync(path.join(dir, f));
if (old.length) console.log(`Removed ${old.length} old backup(s)`);

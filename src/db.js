'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// DATA_DIR keeps the database (and uploads) outside the code folder so redeploys never touch them
const DB_PATH = process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

-- Company > Sector > Region > Department > Division > Section > Team
CREATE TABLE IF NOT EXISTS org_units (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL CHECK (level IN ('company','sector','region','department','division','section','team')),
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  parent_id INTEGER REFERENCES org_units(id),
  manager_id INTEGER REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  employee_no TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  email TEXT,
  phone TEXT,
  nationality TEXT,
  section_id INTEGER REFERENCES org_units(id),
  job_title_ar TEXT,
  job_title_en TEXT,
  grade TEXT,
  hire_date TEXT,
  employment_type TEXT,
  shift TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  role TEXT NOT NULL DEFAULT 'employee',
  password_hash TEXT,
  email_notifications INTEGER NOT NULL DEFAULT 1,
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Historical acting assignments: who held a position on a given date
CREATE TABLE IF NOT EXISTS acting_assignments (
  id INTEGER PRIMARY KEY,
  unit_id INTEGER NOT NULL REFERENCES org_units(id),
  acting_employee_id INTEGER NOT NULL REFERENCES employees(id),
  assignment_type TEXT NOT NULL DEFAULT 'temporary',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  decision_no TEXT,
  approving_authority TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved',
  notes TEXT,
  UNIQUE (employee_id, type, start_date)
);

-- Public / company holidays shown on the calendar (editable: Hijri-based dates move every year)
CREATE TABLE IF NOT EXISTS holidays (
  id INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'public',
  approximate INTEGER NOT NULL DEFAULT 0,
  UNIQUE (start_date, name_en)
);

-- Points: configurable rules + immutable transactions (opening balance is a setting)
CREATE TABLE IF NOT EXISTS point_rules (
  code TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  name_en TEXT NOT NULL,
  points INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  auto INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS point_transactions (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  year INTEGER NOT NULL,
  rule_code TEXT NOT NULL REFERENCES point_rules(code),
  points INTEGER NOT NULL,
  reference TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','reversed')),
  requested_by INTEGER REFERENCES employees(id),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES employees(id),
  decided_at TEXT,
  decision_comment TEXT,
  reversal_of INTEGER REFERENCES point_transactions(id),
  appeal_reason TEXT,
  appeal_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_points_emp ON point_transactions(employee_id, year, status);
CREATE TRIGGER IF NOT EXISTS points_no_delete BEFORE DELETE ON point_transactions
BEGIN SELECT RAISE(ABORT, 'point transactions are reversed, never deleted'); END;
CREATE TRIGGER IF NOT EXISTS points_value_immutable BEFORE UPDATE OF points, employee_id, rule_code ON point_transactions
BEGIN SELECT RAISE(ABORT, 'point values are immutable; use a reversal'); END;

-- Work order schedule extensions (approved by the section head)
CREATE TABLE IF NOT EXISTS wo_extensions (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  old_start TEXT NOT NULL,
  old_end TEXT NOT NULL,
  new_start TEXT NOT NULL,
  new_end TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by INTEGER REFERENCES employees(id),
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_by INTEGER REFERENCES employees(id),
  decided_at TEXT,
  decision_comment TEXT
);

-- Scheduled hand-over of a work order to another employee (executed automatically at scheduled_at)
CREATE TABLE IF NOT EXISTS wo_handovers (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  from_employee_id INTEGER NOT NULL REFERENCES employees(id),
  to_employee_id INTEGER NOT NULL REFERENCES employees(id),
  scheduled_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  work_status TEXT,
  remove_outgoing INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','failed')),
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  executed_at TEXT,
  failure TEXT
);

-- Training course catalog (local and international) and attendance
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title_ar TEXT NOT NULL,
  title_en TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('local','international')),
  category TEXT NOT NULL DEFAULT 'general',
  country TEXT,
  city TEXT,
  provider TEXT,
  mode TEXT NOT NULL DEFAULT 'in_person' CHECK (mode IN ('remote','in_person')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  hours REAL,
  language TEXT,
  capacity INTEGER,
  cost REAL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS course_attendees (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  role TEXT NOT NULL DEFAULT 'trainee',
  attendance TEXT NOT NULL DEFAULT 'registered' CHECK (attendance IN ('registered','attended','absent','cancelled')),
  result TEXT,
  score REAL,
  certificate_no TEXT,
  leave_id INTEGER REFERENCES leaves(id),
  registered_by INTEGER REFERENCES employees(id),
  registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (course_id, employee_id)
);

-- Improvement plans for Satisfactory / Acceptable / below-opening ratings, reviewed yearly
CREATE TABLE IF NOT EXISTS improvement_plans (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_year INTEGER NOT NULL,
  trigger_rating TEXT NOT NULL,
  goals TEXT,
  actions TEXT,
  coach_id INTEGER REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','improved','transfer_recommended','transferred','closed')),
  transfer_to_section_id INTEGER REFERENCES org_units(id),
  transfer_decision_no TEXT,
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS plan_reviews (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES improvement_plans(id),
  year INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  rating TEXT,
  improved INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  reviewed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (plan_id, year)
);

-- Extra permissions granted to individual employees (on top of their role)
CREATE TABLE IF NOT EXISTS user_permissions (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  permission TEXT NOT NULL,
  section_id INTEGER REFERENCES org_units(id),
  expires_at TEXT,
  granted_by INTEGER REFERENCES employees(id),
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by INTEGER REFERENCES employees(id),
  note TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  name_ar TEXT,
  name_en TEXT,
  voltage_kv INTEGER,
  line_code TEXT,
  region TEXT,
  lat REAL,
  lng REAL,
  status TEXT NOT NULL DEFAULT 'in_service'
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  location TEXT,
  expiry_date TEXT,
  calibration_due TEXT
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY,
  wo_number TEXT NOT NULL UNIQUE CHECK (wo_number GLOB 'WO[0-9][0-9][0-9][0-9][0-9][0-9]'),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  asset_id INTEGER REFERENCES assets(id),
  voltage_kv INTEGER,
  location TEXT,
  section_id INTEGER REFERENCES org_units(id),
  distance_km REAL NOT NULL DEFAULT 0,
  distance_category TEXT NOT NULL DEFAULT 'A',
  needs_sector_approval INTEGER NOT NULL DEFAULT 0,
  selection_reason TEXT,
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  due_at TEXT,
  actual_start TEXT,
  actual_end TEXT,
  arrival_at TEXT,
  restored_at TEXT,
  overnight INTEGER NOT NULL DEFAULT 0,
  travel_hours REAL,
  status TEXT NOT NULL DEFAULT 'open',
  team_leader_id INTEGER REFERENCES employees(id),
  officials_json TEXT,
  materials_withdrawn TEXT CHECK (materials_withdrawn IN ('yes','no')),
  materials_used TEXT CHECK (materials_used IN ('yes','no')),
  alt_material_source TEXT,
  result TEXT,
  action_description TEXT,
  completion_pct INTEGER,
  non_completion_reason TEXT,
  cancel_reason TEXT,
  split_warning TEXT,
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT,
  imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wo_status ON work_orders(status);

CREATE TABLE IF NOT EXISTS wo_participants (
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (wo_id, employee_id)
);

CREATE TABLE IF NOT EXISTS wo_equipment (
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  PRIMARY KEY (wo_id, equipment_id)
);

CREATE TABLE IF NOT EXISTS wo_photos (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  stage TEXT NOT NULL CHECK (stage IN ('before','during','after')),
  file_name TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  sha256 TEXT NOT NULL,
  caption TEXT,
  defect_location TEXT,
  pair_photo_id INTEGER REFERENCES wo_photos(id),
  lat REAL,
  lng REAL,
  uploaded_by INTEGER REFERENCES employees(id),
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS wo_approvals (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  phase TEXT NOT NULL CHECK (phase IN ('authorization','closure')),
  step TEXT NOT NULL,
  seq INTEGER NOT NULL,
  expected_employee_id INTEGER REFERENCES employees(id),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','superseded')),
  decided_by INTEGER REFERENCES employees(id),
  acting INTEGER NOT NULL DEFAULT 0,
  comment TEXT,
  verification_code TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS material_reservations (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  reservation_number TEXT NOT NULL UNIQUE,
  is_primary INTEGER NOT NULL DEFAULT 1,
  warehouse TEXT,
  storage_location TEXT,
  issued_at TEXT,
  issued_by TEXT,
  received_by INTEGER REFERENCES employees(id),
  verified INTEGER NOT NULL DEFAULT 0,
  verified_by INTEGER REFERENCES employees(id),
  status TEXT NOT NULL DEFAULT 'submitted'
);

CREATE TABLE IF NOT EXISTS material_lines (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  reservation_id INTEGER REFERENCES material_reservations(id),
  line_no TEXT,
  material_number TEXT NOT NULL,
  description TEXT,
  uom TEXT,
  source TEXT NOT NULL DEFAULT 'warehouse',
  reserved_qty REAL NOT NULL DEFAULT 0,
  issued_qty REAL NOT NULL DEFAULT 0,
  used_qty REAL NOT NULL DEFAULT 0,
  returned_qty REAL NOT NULL DEFAULT 0,
  damaged_qty REAL NOT NULL DEFAULT 0,
  transferred_qty REAL NOT NULL DEFAULT 0,
  transfer_wo_number TEXT,
  remaining_authorized_qty REAL NOT NULL DEFAULT 0,
  batch TEXT,
  serial TEXT,
  install_location TEXT,
  damage_reason TEXT,
  recorded_by INTEGER REFERENCES employees(id),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Catalog of materials (consumed), tools and equipment (returned) with stock on hand
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('material','tool','equipment')),
  category TEXT,
  uom TEXT NOT NULL DEFAULT 'piece',
  quantity REAL NOT NULL DEFAULT 0,
  min_qty REAL NOT NULL DEFAULT 0,
  location TEXT,
  section_id INTEGER REFERENCES org_units(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Every stock change (receipt, consumption on closure, damage, manual adjustment)
CREATE TABLE IF NOT EXISTS item_movements (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  wo_id INTEGER REFERENCES work_orders(id),
  kind TEXT NOT NULL CHECK (kind IN ('receive','consume','damage','adjust')),
  qty REAL NOT NULL,
  balance REAL NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Catalog items specified on a work order (reserved while the work order is active)
CREATE TABLE IF NOT EXISTS wo_items (
  id INTEGER PRIMARY KEY,
  wo_id INTEGER NOT NULL REFERENCES work_orders(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL,
  used_qty REAL,
  damaged_qty REAL NOT NULL DEFAULT 0,
  notes TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES employees(id),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (wo_id, item_id)
);

-- Daily tasks (short jobs that are not full work orders) and their assignees
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  task_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  title TEXT NOT NULL,
  details TEXT,
  location TEXT,
  section_id INTEGER REFERENCES org_units(id),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  wo_id INTEGER REFERENCES work_orders(id),
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(task_date);
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  PRIMARY KEY (task_id, employee_id)
);
-- Log of daily task messages sent (who sent, for which day, to whom)
CREATE TABLE IF NOT EXISTS task_dispatches (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  mode TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  emails INTEGER NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  detail_json TEXT,
  sent_by INTEGER REFERENCES employees(id),
  automatic INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_emp ON notifications(employee_id, read_at);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  to_name TEXT,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);

-- One row per alert condition so scheduled checks never alert twice
CREATE TABLE IF NOT EXISTS alert_keys (key TEXT PRIMARY KEY, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  file_name TEXT,
  status TEXT NOT NULL DEFAULT 'preview',
  total INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  rows_json TEXT,
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  committed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  employee_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  ip TEXT,
  device TEXT
);

-- Audit log is append-only
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is immutable'); END;

-- Work order numbers are never edited or reused
CREATE TRIGGER IF NOT EXISTS wo_number_immutable BEFORE UPDATE OF wo_number ON work_orders
WHEN OLD.wo_number <> NEW.wo_number
BEGIN SELECT RAISE(ABORT, 'wo_number is immutable'); END;
CREATE TRIGGER IF NOT EXISTS wo_no_delete BEFORE DELETE ON work_orders
BEGIN SELECT RAISE(ABORT, 'work orders are cancelled, never deleted'); END;
`);

// Columns added after the first release
for (const [table, col, def] of [
  ['leaves', 'mode', 'TEXT'], ['leaves', 'location', 'TEXT'], ['leaves', 'course_id', 'INTEGER'],
  ['equipment', 'plate_number', 'TEXT'], ['equipment', 'vehicle_type', 'TEXT'], ['equipment', 'make_model', 'TEXT'],
  ['equipment', 'seats', 'INTEGER'], ['equipment', 'section_id', 'INTEGER'], ['equipment', 'model_year', 'INTEGER'],
  ['employees', 'national_id', 'TEXT'], ['employees', 'notes', 'TEXT'], ['work_orders', 'involves_travel', 'TEXT'],
  ['material_lines', 'item_id', 'INTEGER'],
]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

// Older work orders: derive the travel answer from the recorded distance
db.exec("UPDATE work_orders SET involves_travel = CASE WHEN distance_category IN ('B','C') THEN 'yes' ELSE 'no' END WHERE involves_travel IS NULL");

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

const DEFAULT_SETTINGS = {
  points_opening_balance: '10000',
  sla_hours_C1: '1',
  sla_hours_C2: '4',
  sla_hours_C3: '24',
  sla_hours_C4: '72',
  distance_threshold: '20',
  expiry_alert_days: '30',
  acting_alert_days: '3',
  approval_reminder_hours: '24',
  missing_photo_hours: '4',
  wo_sequence_warn_at: '990000',
  daily_dispatch_time: '',
};

function setting(key) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : DEFAULT_SETTINGS[key];
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

module.exports = { db, tx, all, get, run, setting, setSetting, DEFAULT_SETTINGS, DB_PATH };

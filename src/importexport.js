'use strict';
const ExcelJS = require('exceljs');
const { Readable } = require('node:stream');
const { ENTITIES, cellValue } = require('./entities');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };

function columnsFor(entity, forExport) {
  const def = ENTITIES[entity];
  if (forExport && def.exportColumns) return def.exportColumns.map((k) => [k, k, k]);
  return def.columns;
}

const BORDER = { style: 'thin', color: { argb: 'FFD5DDE8' } };

// Shared look for every sheet: branded header, frozen first row, filters, borders, zebra rows, sensible widths
function styleSheet(ws, { required = [], notes = {} } = {}) {
  const head = ws.getRow(1);
  head.height = 24;
  head.eachCell((c, i) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    c.fill = required.includes(i) ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC53030' } } : HEADER_FILL;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    if (notes[c.value]) c.note = notes[c.value];
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (ws.columnCount) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.eachCell({ includeEmpty: true }, (c) => {
      c.border = { bottom: BORDER, left: BORDER, right: BORDER };
      c.alignment = { vertical: 'top', wrapText: true };
      if (n % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F8FC' } };
    });
  });
  ws.columns.forEach((col) => {
    let w = String(col.header || '').length + 4;
    col.eachCell?.({ includeEmpty: false }, (c, n) => { if (n > 1) w = Math.max(w, Math.min(50, String(c.value ?? '').length + 2)); });
    col.width = Math.max(12, Math.min(50, w));
  });
}

function addSheet(wb, entity, rows, forExport) {
  const cols = forExport && rows.length ? Object.keys(rows[0]).map((k) => [k]) : columnsFor(entity, forExport);
  const ws = wb.addWorksheet(entity.slice(0, 31));
  ws.columns = cols.map(([k]) => ({ header: k, key: k }));
  rows.forEach((r) => ws.addRow(r));
  const def = ENTITIES[entity];
  const notes = Object.fromEntries((def?.columns || []).map(([k, ar, en]) => [k, `${ar}\n${en}`]));
  const required = forExport ? [] : (def?.columns || []).map((c, i) => (c[3] ? i + 1 : 0)).filter(Boolean);
  styleSheet(ws, { required, notes });
  return ws;
}

// Template: data sheet with the exact headers (hover a header for its meaning) + a bilingual instructions sheet
async function templateWorkbook(entity) {
  const def = ENTITIES[entity];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEC Transmission WMS';
  addSheet(wb, entity, [], false);
  const help = wb.addWorksheet('instructions', { views: [{ rightToLeft: false }] });
  help.columns = [{ header: 'column', key: 'k' }, { header: 'إلزامي / Required', key: 'r' }, { header: 'الوصف', key: 'ar' }, { header: 'Description', key: 'en' }];
  def.columns.forEach(([k, ar, en, req]) => help.addRow({ k, r: req ? 'نعم / Yes' : '', ar, en }));
  help.addRow({});
  help.addRow({ k: 'notes', ar: 'التواريخ بصيغة YYYY-MM-DD والأوقات بتوقيت الرياض YYYY-MM-DD HH:MM. لا تغيّر أسماء الأعمدة في الصف الأول. الأعمدة الحمراء إلزامية.', en: 'Dates as YYYY-MM-DD, times in Riyadh time as YYYY-MM-DD HH:MM. Do not rename the header row. Red columns are required.' });
  styleSheet(help);
  help.getColumn('ar').alignment = { horizontal: 'right', wrapText: true, vertical: 'top' };
  return wb;
}

async function exportWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEC Transmission WMS';
  wb.created = new Date();
  for (const [entity, rows] of sheets) addSheet(wb, entity, rows, true);
  return wb;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  // BOM so Excel opens Arabic text correctly
  return '﻿' + [keys.join(','), ...rows.map((r) => keys.map((k) => q(r[k])).join(','))].join('\r\n');
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

// Returns [{ __row: n, col: value, ... }] keyed by header names
async function parseUpload(buffer, fileName, entity) {
  let matrix;
  if (/\.csv$/i.test(fileName)) {
    matrix = parseCsv(buffer.toString('utf8'));
  } else if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.read(Readable.from(buffer));
    const ws = wb.getWorksheet(entity) || wb.worksheets.find((w) => w.name !== 'instructions');
    if (!ws) throw new Error('No worksheet found / لا توجد ورقة بيانات');
    matrix = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        const v = cellValue(r.getCell(c).value);
        // Excel datetimes carry wall-clock time; keep them as plain text so the preview
        // (stored as JSON) and the commit interpret them identically as Riyadh time.
        vals.push(v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ').replace(/ 00:00:00$/, '') : v);
      }
      if (vals.some((v) => v !== '' && v != null)) matrix.push(vals);
    });
  } else {
    throw new Error('Only .xlsx or .csv files are supported / يدعم النظام ملفات xlsx و csv فقط');
  }
  if (!matrix.length) throw new Error('File is empty / الملف فارغ');
  const headers = matrix[0].map((h) => String(h ?? '').trim());
  const known = new Set(ENTITIES[entity].columns.map(([k]) => k));
  const unknown = headers.filter((h) => h && !known.has(h));
  const missing = ENTITIES[entity].columns.filter(([k, , , req]) => req && !headers.includes(k)).map(([k]) => k);
  if (missing.length) throw new Error(`Missing required columns / أعمدة إلزامية مفقودة: ${missing.join(', ')}`);
  const rows = matrix.slice(1).map((vals, i) => {
    const o = { __row: i + 2 };
    headers.forEach((h, j) => { if (h) o[h] = vals[j] ?? ''; });
    return o;
  });
  if (rows.length > 5000) throw new Error('Max 5000 rows per import / الحد الأقصى 5000 صف');
  return { rows, unknown };
}

/**
 * Apply validated rows to the system (used by Excel import and by reviewed file extraction).
 * results: [{ raw, errors }]. Each row is re-validated; work orders and similar commit row by row
 * (own transactions and emails), other data in one transaction with a savepoint per row.
 */
function commitRows(entity, results, req) {
  const { db } = require('./db');
  const def = ENTITIES[entity];
  const wrap = !['work_orders', 'point_requests', 'courses', 'course_attendees'].includes(entity);
  let inserted = 0, updated = 0, failed = 0;
  if (wrap) db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of results) {
      if (r.errors && r.errors.length) { r.outcome = 'skipped'; continue; }
      const v = def.validate(r.raw, req);
      if (v.errors.length) { r.errors = v.errors; r.outcome = 'failed'; failed++; continue; }
      if (wrap) db.exec('SAVEPOINT row');
      try {
        const ref = def.apply(v.data, v.mode, req);
        if (wrap) db.exec('RELEASE row');
        r.outcome = v.mode === 'update' ? 'updated' : 'inserted';
        if (ref) r.ref = ref;
        v.mode === 'update' ? updated++ : inserted++;
      } catch (e) {
        if (wrap) { db.exec('ROLLBACK TO row'); db.exec('RELEASE row'); }
        r.errors = [e.message]; r.outcome = 'failed'; failed++;
      }
    }
    if (wrap) db.exec('COMMIT');
  } catch (e) {
    if (wrap) db.exec('ROLLBACK');
    throw e;
  }
  return { inserted, updated, failed };
}

module.exports = { templateWorkbook, exportWorkbook, toCsv, parseUpload, parseCsv, commitRows };

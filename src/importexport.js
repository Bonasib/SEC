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

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function addSheet(wb, entity, rows, forExport) {
  const cols = forExport && rows.length ? Object.keys(rows[0]).map((k) => [k]) : columnsFor(entity, forExport);
  const ws = wb.addWorksheet(entity);
  ws.columns = cols.map(([k]) => ({ header: k, key: k, width: Math.min(40, Math.max(12, k.length + 4)) }));
  rows.forEach((r) => ws.addRow(r));
  styleHeader(ws);
  return ws;
}

// Template: data sheet with the exact headers + an instructions sheet in both languages
async function templateWorkbook(entity) {
  const def = ENTITIES[entity];
  const wb = new ExcelJS.Workbook();
  const ws = addSheet(wb, entity, [], false);
  def.columns.forEach(([k, , , req], i) => { if (req) ws.getRow(1).getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC53030' } }; });
  const help = wb.addWorksheet('instructions');
  help.columns = [{ header: 'column', key: 'k', width: 26 }, { header: 'إلزامي / Required', key: 'r', width: 16 }, { header: 'الوصف', key: 'ar', width: 60 }, { header: 'Description', key: 'en', width: 60 }];
  def.columns.forEach(([k, ar, en, req]) => help.addRow({ k, r: req ? 'نعم / Yes' : '', ar, en }));
  help.addRow({});
  help.addRow({ k: 'notes', ar: 'التواريخ بصيغة YYYY-MM-DD والأوقات بتوقيت الرياض YYYY-MM-DD HH:MM. لا تغيّر أسماء الأعمدة في الصف الأول.', en: 'Dates as YYYY-MM-DD, times in Riyadh time as YYYY-MM-DD HH:MM. Do not rename the header row.' });
  styleHeader(help);
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

module.exports = { templateWorkbook, exportWorkbook, toCsv, parseUpload, parseCsv };

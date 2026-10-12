'use strict';
// Extract records from Excel/CSV, Word, PDF and images, map them to the system's data types,
// keep them for an auditor to review and correct, then add the approved rows to the system.
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run } = require('./db');
const { audit, HttpError, nowIso } = require('./util');
const { notify, idsByRole } = require('./notify');
const { ENTITIES, cellValue } = require('./entities');
const F = require('./files');

// Data types that can be filled from a document (export-only types are left out)
const TARGETS = ['work_orders', 'employees', 'items', 'tasks', 'leaves', 'assets', 'equipment', 'courses', 'course_attendees', 'holidays', 'material_lines', 'acting_assignments', 'org_units', 'point_requests'];
const AI_ON = () => !!process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.EXTRACT_AI_MODEL || 'claude-opus-5-5';

// ---------- header / label matching ----------
const norm = (s) => String(s ?? '').toLowerCase()
  .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
const clean = (label) => String(label || '').split(/[:(،,]| YYYY| - /)[0].trim();

// Common alternative headings seen in SEC sheets and forms
const SYNONYMS = {
  employee_no: ['رقم الموظف', 'الرقم الوظيفي', 'employee id', 'emp no', 'staff no', 'badge'],
  name_ar: ['الاسم', 'اسم الموظف', 'الاسم بالعربي', 'الاسم الكامل'], name_en: ['name', 'full name', 'english name'],
  email: ['البريد', 'البريد الالكتروني', 'e mail', 'mail'], phone: ['الجوال', 'رقم الجوال', 'mobile', 'tel'],
  section_code: ['القسم', 'رمز القسم', 'section', 'dept'], job_title_en: ['job title', 'position', 'المسمى'],
  title: ['العنوان', 'الموضوع', 'المهمة', 'description of work', 'subject'], description: ['الوصف', 'التفاصيل', 'details'],
  planned_start: ['البداية', 'تاريخ البداية', 'start', 'start date', 'from'], planned_end: ['النهاية', 'تاريخ النهاية', 'end', 'end date', 'to'],
  start_date: ['من', 'تاريخ البداية', 'from', 'start'], end_date: ['الى', 'إلى', 'تاريخ النهاية', 'to', 'end'],
  task_date: ['التاريخ', 'date', 'day', 'اليوم'], assignee_nos: ['المكلفون', 'الموظفون', 'assigned to', 'assignees'],
  team_leader_no: ['قائد الفريق', 'team leader', 'leader'], participants_nos: ['المشاركون', 'الفريق', 'participants', 'team'],
  code: ['الرمز', 'رمز الصنف', 'item code', 'material code', 'code'], inventory_no: ['رقم المخزون', 'رقم المادة', 'sap no', 'material no', 'material number'],
  quantity: ['الكمية', 'الكميه', 'qty', 'quantity', 'العدد'], uom: ['الوحدة', 'unit', 'uom'], location: ['الموقع', 'المكان', 'location', 'site'],
  wo_number: ['رقم أمر العمل', 'رقم امر العمل', 'work order', 'wo', 'wo no'], priority: ['الأولوية', 'priority'], type: ['النوع', 'type'],
  plate_number: ['رقم اللوحة', 'اللوحة', 'plate'], kind: ['النوع', 'kind'], notes: ['ملاحظات', 'notes', 'remarks'],
};

function candidates(entity) {
  return ENTITIES[entity].columns.map(([k, ar, en, req]) => ({
    key: k, required: !!req,
    names: [k, k.replace(/_/g, ' '), clean(ar), clean(en), ...(SYNONYMS[k] || [])].map(norm).filter((x) => x.length > 1),
  }));
}

function score(label, cand) {
  const h = norm(label);
  if (!h) return 0;
  let best = 0;
  for (const n of cand.names) {
    if (h === n) best = Math.max(best, 10);
    else if (n.length > 2 && h.length > 2 && (h.includes(n) || n.includes(h))) best = Math.max(best, 4 + Math.min(n.length, h.length) / Math.max(n.length, h.length) * 4);
  }
  return best;
}

/** Map labels to entity columns (each column used once, best matches first). */
function mapLabels(labels, entity) {
  const cands = candidates(entity);
  const pairs = [];
  labels.forEach((l, i) => cands.forEach((c) => { const s = score(l, c); if (s >= 5) pairs.push({ i, key: c.key, s, required: c.required }); }));
  pairs.sort((a, b) => b.s - a.s);
  const map = {}, used = new Set();
  for (const p of pairs) { if (map[p.i] !== undefined || used.has(p.key)) continue; map[p.i] = p.key; used.add(p.key); }
  const req = cands.filter((c) => c.required).map((c) => c.key);
  const matchedReq = req.filter((k) => used.has(k)).length;
  return { map, matched: used.size, matchedReq, totalReq: req.length, quality: used.size + matchedReq * 2 };
}

// ---------- matrices and text -> rows ----------
const str = (v) => {
  const x = cellValue(v);
  if (x instanceof Date) return x.toISOString().slice(11, 19) === '00:00:00' ? x.toISOString().slice(0, 10) : x.toISOString().slice(0, 16).replace('T', ' ');
  return String(x ?? '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
};

function rowsFromMatrix(matrix, entity) {
  let best = null;
  for (let h = 0; h < Math.min(matrix.length, 15); h++) {
    const labels = matrix[h].map(str);
    if (labels.filter(Boolean).length < 2) continue;
    const m = mapLabels(labels, entity);
    if (m.matched >= 2 && (!best || m.quality > best.m.quality)) best = { h, m, labels };
  }
  if (!best) return null;
  const rows = [];
  for (const r of matrix.slice(best.h + 1)) {
    const o = {};
    Object.entries(best.m.map).forEach(([i, k]) => { const v = str(r[i]); if (v) o[k] = v; });
    if (Object.keys(o).length) rows.push(o);
  }
  const unmapped = best.labels.filter((l, i) => l && best.m.map[i] === undefined);
  return { rows, quality: best.m.quality + Math.min(rows.length, 5), matched: best.m.matched, unmapped };
}

// "Label: value" lines (forms, letters, OCR text). A repeated label starts a new record.
function rowsFromText(text, entity) {
  const cands = candidates(entity);
  const rows = [];
  let cur = {}, matched = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*([^:：|\t]{2,60}?)\s*[:：|\t]\s*(.+?)\s*$/);
    if (!m) continue;
    let bestKey = null, bestScore = 0;
    for (const c of cands) { const s = score(m[1], c); if (s > bestScore) { bestScore = s; bestKey = c.key; } }
    if (bestScore < 6) continue;
    if (cur[bestKey] !== undefined) { rows.push(cur); cur = {}; }
    cur[bestKey] = str(m[2]);
    matched.add(bestKey);
  }
  if (Object.keys(cur).length) rows.push(cur);
  const good = rows.filter((r) => Object.keys(r).length >= 2);
  const req = cands.filter((c) => c.required && matched.has(c.key)).length;
  return good.length ? { rows: good, quality: matched.size + req * 2, matched: matched.size, unmapped: [] } : null;
}

// Lines whose cells are separated by 2+ spaces or tabs form a table (OCR and PDF text)
const matrixFromLines = (text) => String(text || '').split(/\r?\n/).map((l) => l.split(/\t| {2,}/).map((c) => c.trim()).filter(Boolean)).filter((r) => r.length >= 2);

/** Best mapping of raw content (matrices + text) to an entity; entity 'auto' tries every target. */
function mapContent(raw, entity) {
  const targets = entity && entity !== 'auto' ? [entity] : TARGETS;
  let best = null;
  for (const ent of targets) {
    const tries = [...(raw.matrices || []).map((mx) => rowsFromMatrix(mx, ent)), raw.text ? rowsFromText(raw.text, ent) : null, raw.text ? rowsFromMatrix(matrixFromLines(raw.text), ent) : null].filter(Boolean);
    for (const t of tries) if (t.rows.length && (!best || t.quality > best.quality)) best = { ...t, entity: ent };
  }
  return best || { entity: entity && entity !== 'auto' ? entity : null, rows: [], quality: 0, matched: 0, unmapped: [] };
}

// ---------- file readers ----------
async function readXlsx(buf) {
  const ExcelJS = require('exceljs');
  const { Readable } = require('node:stream');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.read(Readable.from(buf));
  return wb.worksheets.filter((ws) => ws.name !== 'instructions').map((ws) => {
    const mx = [];
    ws.eachRow({ includeEmpty: false }, (r) => { const vals = []; for (let c = 1; c <= ws.columnCount; c++) vals.push(r.getCell(c).value); mx.push(vals); });
    return mx;
  });
}

function tablesFromHtml(html) {
  const dec = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((t) => [...t[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => [...r[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/g)].map((c) => dec(c[0]))));
}

async function readDocx(buf) {
  const mammoth = require('mammoth');
  const [{ value: html }, { value: text }] = await Promise.all([mammoth.convertToHtml({ buffer: buf }), mammoth.extractRawText({ buffer: buf })]);
  return { matrices: tablesFromHtml(html), text };
}

// Arabic presentation forms are folded back to normal letters (NFKC)
// PDF text with positions -> lines -> cells (a gap between words splits cells)
async function readPdf(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: true, verbosity: 0 }).promise;
  const matrix = [], lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, 50); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group words into lines by their baseline (small tolerance), top to bottom
    const items = content.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], w: it.width || 0, s: it.str, rtl: it.dir === 'rtl' }))
      .sort((a, b) => b.y - a.y);
    const groups = [];
    for (const it of items) {
      const g = groups.find((x) => Math.abs(x.y - it.y) <= 4);
      if (g) g.items.push(it); else groups.push({ y: it.y, items: [it] });
    }
    for (const g of groups) {
      // Cells: runs of words close to each other (left to right on the page)
      const cells = [];
      let cur = null;
      for (const it of g.items.sort((a, b) => a.x - b.x)) {
        if (cur && it.x - cur.end < 8) { cur.parts.push(it); cur.end = Math.max(cur.end, it.x + it.w); } else { cur = { parts: [it], end: it.x + it.w }; cells.push(cur); }
      }
      // Each piece is stored in reading order; right-to-left cells read their pieces from right to left
      for (const c of cells) {
        const rtl = c.parts.filter((x) => x.rtl).length > c.parts.length / 2;
        const parts = rtl ? [...c.parts].sort((a, b) => b.x - a.x) : c.parts;
        c.s = parts.reduce((acc, it, i) => {
          if (!i) return it.s;
          const prev = parts[i - 1];
          const gap = rtl ? prev.x - (it.x + it.w) : it.x - (prev.x + prev.w);
          return acc + (gap > 1.5 ? ' ' : '') + it.s;
        }, '');
      }
      const texts = cells.map((c) => c.s.normalize('NFKC').trim()).filter(Boolean);
      matrix.push(texts);
      lines.push(texts.join('  '));
    }
  }
  const text = lines.join('\n');
  return { matrices: [matrix], text, scanned: text.replace(/\s/g, '').length < 20, pages: doc.numPages };
}

// Optical character recognition for photos and scans (Arabic + English). Language data is downloaded once.
async function readImageOcr(filePath) {
  const { createWorker } = require('tesseract.js');
  const cachePath = path.join(F.UPLOAD_DIR, '..', 'ocr-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker(['ara', 'eng'], 1, { cachePath, logger: () => {} });
  try {
    const { data } = await Promise.race([worker.recognize(filePath), new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 120000))]);
    return { matrices: [], text: data.text || '' };
  } finally { await worker.terminate().catch(() => {}); }
}

// ---------- optional AI extraction (Claude) ----------
const AI_MEDIA = /^(application\/pdf|image\/(jpeg|png|gif|webp))$/;
async function aiExtract({ buffer, mime, text }, entity) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const targets = entity && entity !== 'auto' ? [entity] : TARGETS;
  const catalog = targets.map((e) => `${e}: ${ENTITIES[e].columns.map(([k, , en, req]) => `${k}${req ? '*' : ''} (${en})`).join('; ')}`).join('\n');
  const schema = {
    type: 'object', additionalProperties: false, required: ['entity', 'rows', 'notes'],
    properties: {
      entity: { type: 'string', enum: targets },
      rows: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fields'], properties: {
        fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['column', 'value'], properties: { column: { type: 'string' }, value: { type: 'string' } } } },
      } } },
      notes: { type: 'string' },
    },
  };
  const content = [];
  if (buffer && AI_MEDIA.test(mime || '')) {
    content.push(mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } });
  }
  if (text) content.push({ type: 'text', text: `<document_text>\n${text}\n</document_text>` });
  content.push({ type: 'text', text: `Extract every record in this document for the SEC Transmission work-order system.
Choose the data type that fits the document, and fill only columns from its list (exact column keys; * = required):
${catalog}

Rules: copy values exactly as written (Arabic or English); dates as YYYY-MM-DD and date-times as YYYY-MM-DD HH:MM; employee IDs as written (e.g. F012); leave a column out rather than guessing; one row per record. Put anything unclear in notes.` });
  let response;
  try {
    response = await client.beta.messages.create({
      model: AI_MODEL, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      system: 'You read business documents (forms, tables, letters, scans) and return their records as structured data. A human auditor reviews everything you return.',
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('AI extraction: invalid ANTHROPIC_API_KEY');
    if (e instanceof Anthropic.RateLimitError) throw new Error('AI extraction: rate limited, try again later');
    if (e instanceof Anthropic.BadRequestError) throw new Error(`AI extraction: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new Error(`AI extraction failed (${e.status ?? 'network'})`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new Error('AI extraction declined for this document');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('AI extraction returned no data');
  const out = JSON.parse(block.text);
  const keys = new Set(ENTITIES[out.entity].columns.map(([k]) => k));
  const rows = out.rows.map((r) => Object.fromEntries(r.fields.filter((f) => keys.has(f.column) && String(f.value).trim()).map((f) => [f.column, String(f.value).trim()]))).filter((r) => Object.keys(r).length);
  return { entity: out.entity, rows, notes: out.notes, truncated: response.stop_reason === 'max_tokens' };
}

// ---------- pipeline ----------
const kindOf = (mime, name) => {
  const ext = path.extname(name || '').toLowerCase();
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.csv' || mime === 'text/csv') return 'csv';
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf' || mime === 'application/pdf') return 'pdf';
  if (/^image\//.test(mime || '') || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  if (ext === '.txt' || mime === 'text/plain') return 'text';
  return null;
};
const EXTRACTABLE = (mime, name) => !!kindOf(mime, name);

/**
 * Read a stored file and map it. method: 'auto' (local reading; AI for images/scans when configured),
 * 'local' (never AI), 'ai' (AI when configured).
 */
async function extractFile({ absPath, mime, name }, entity = 'auto', method = 'auto') {
  const kind = kindOf(mime, name);
  if (!kind) throw new HttpError(400, 'Unsupported file type / نوع ملف غير مدعوم');
  const buffer = fs.readFileSync(absPath);
  let raw = { matrices: [], text: '' };
  const warnings = [];
  if (kind === 'xlsx') raw.matrices = await readXlsx(buffer);
  else if (kind === 'csv') raw.matrices = [require('./importexport').parseCsv(buffer.toString('utf8'))];
  else if (kind === 'docx') raw = await readDocx(buffer);
  else if (kind === 'text') raw.text = buffer.toString('utf8');
  else if (kind === 'pdf') raw = await readPdf(buffer);

  const wantAi = AI_ON() && method !== 'local' && (method === 'ai' || kind === 'image' || raw.scanned);
  let result = null, used = 'local';
  if (wantAi) {
    try {
      const ai = await aiExtract({ buffer: AI_MEDIA.test(mime || '') ? buffer : null, mime, text: raw.text?.slice(0, 200000) }, entity);
      result = { entity: ai.entity, rows: ai.rows, matched: 0, unmapped: [] };
      used = 'ai';
      if (ai.notes) warnings.push(ai.notes);
      if (ai.truncated) warnings.push('Output was cut short; check for missing rows / قد تكون بعض الصفوف ناقصة');
    } catch (e) { warnings.push(e.message); }
  }
  if (!result && kind === 'image') {
    try { raw = await readImageOcr(absPath); used = 'ocr'; } catch (e) { warnings.push(`OCR: ${e.message}`); }
  }
  if (!result) result = mapContent(raw, entity);
  if (kind === 'pdf' && raw.scanned && used !== 'ai') warnings.push('Scanned PDF without text: enter the values manually or enable AI extraction / ملف PDF ممسوح ضوئيًا');
  return {
    entity: result.entity, rows: result.rows, method: used, unmapped: result.unmapped || [], warnings,
    preview: { text: String(raw.text || '').slice(0, 20000), table: (raw.matrices?.[0] || []).slice(0, 30).map((r) => r.map(str)) },
  };
}

// ---------- review ----------
const REVIEW_PERM = 'data.review';
const canExtract = (user) => require('./access').can(user, 'data.extract') === true;
const canReview = (user) => require('./access').can(user, REVIEW_PERM) === true;

/** Validate each row against the target type's rules (same rules as Excel import). */
function validate(entity, rows, req) {
  const def = ENTITIES[entity];
  return rows.map((r) => {
    if (r.state === 'rejected') return { ...r, errors: [], mode: null };
    try {
      const v = def.validate({ ...r.data }, req);
      return { ...r, errors: v.errors, mode: v.mode };
    } catch (e) { return { ...r, errors: [e.message], mode: null }; }
  });
}

function create({ file, entity, method, note, documentId }, result, req) {
  const rows = validate(result.entity || 'employees', result.rows.map((d) => ({ data: d, state: 'pending' })), req);
  const r = run(`INSERT INTO extractions(file_name, original_name, mime, size, sha256, entity, method, status, rows_json, preview_json, warnings_json, notes, document_id, created_by)
    VALUES (?,?,?,?,?,?,?, 'pending_review', ?,?,?,?,?,?)`, file.rel, file.name, file.mime, file.size, file.sha256, result.entity, result.method,
  JSON.stringify(result.entity ? rows : []), JSON.stringify({ ...result.preview, unmapped: result.unmapped }), JSON.stringify(result.warnings), note || null, documentId || null, req.user.id);
  const id = Number(r.lastInsertRowid);
  audit(req, 'create', 'extraction', id, null, { file: file.name, entity: result.entity, rows: result.rows.length, method: result.method });
  const reviewers = reviewerIds().filter((x) => x !== req.user.id);
  notify(reviewers, {
    type: 'extraction_review', severity: 'info', title: `استخراج بانتظار المراجعة #${id} / Extraction awaiting review #${id}`,
    body: `${file.name} · ${result.rows.length} ${result.entity || ''}`, link: `/extract/${id}`,
  });
  return id;
}

function reviewerIds() {
  const direct = idsByRole('auditor');
  const granted = all("SELECT DISTINCT employee_id FROM user_permissions WHERE permission = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", REVIEW_PERM, nowIso()).map((r) => r.employee_id);
  const ids = [...new Set([...direct, ...granted])];
  return ids.length ? ids : idsByRole('admin');
}

function load(id, user) {
  const x = get('SELECT * FROM extractions WHERE id = ?', id);
  if (!x) throw new HttpError(404, 'Not found');
  if (x.created_by !== user.id && !canReview(user)) throw new HttpError(403, 'Forbidden / ليست لديك صلاحية');
  return { ...x, rows: JSON.parse(x.rows_json || '[]'), preview: JSON.parse(x.preview_json || '{}'), warnings: JSON.parse(x.warnings_json || '[]') };
}

/** Save the reviewer's edits (cells, row states, target type). */
function saveEdits(x, body, req) {
  if (!['pending_review'].includes(x.status)) throw new HttpError(400, 'Already processed / تمت معالجته');
  const isReviewer = canReview(req.user);
  if (!isReviewer && x.created_by !== req.user.id) throw new HttpError(403, 'Forbidden');
  const entity = TARGETS.includes(body.entity) ? body.entity : x.entity;
  if (!entity) throw new HttpError(400, 'Choose the data type / اختر نوع البيانات');
  const cols = ENTITIES[entity].columns.map(([k]) => k);
  // No grid in the request (e.g. a button outside the table): keep the rows as they are
  if (!body.rows && body.action !== 'add_row') return { ...x, entity };
  const posted = body.rows ? Object.values(body.rows) : [];
  let rows = posted.map((r) => ({
    data: Object.fromEntries(cols.filter((k) => String(r[k] ?? '').trim()).map((k) => [k, String(r[k]).trim()])),
    state: ['approved', 'rejected', 'pending'].includes(r.__state) ? r.__state : 'pending',
  }));
  // Only a reviewer can approve rows
  if (!isReviewer) rows = rows.map((r) => ({ ...r, state: r.state === 'approved' ? 'pending' : r.state }));
  if (body.action === 'add_row') rows.push({ data: {}, state: 'pending' });
  if (body.action === 'approve_valid' && isReviewer) rows = validate(entity, rows, req).map((r) => ({ ...r, state: r.state === 'rejected' ? 'rejected' : r.errors.length ? 'pending' : 'approved' }));
  rows = validate(entity, rows.filter((r) => Object.keys(r.data).length || r.state !== 'rejected'), req);
  run('UPDATE extractions SET entity = ?, rows_json = ?, reviewed_by = CASE WHEN ? THEN ? ELSE reviewed_by END WHERE id = ?', entity, JSON.stringify(rows), isReviewer ? 1 : 0, req.user.id, x.id);
  audit(req, 'update', 'extraction', x.id, { entity: x.entity, rows: x.rows.length }, { entity, rows: rows.length, approved: rows.filter((r) => r.state === 'approved').length });
  return { ...x, entity, rows };
}

/** Add the approved, valid rows to the system (four-eyes: the reviewer cannot be the uploader). */
function exportApproved(x, req) {
  if (!canReview(req.user)) throw new HttpError(403, 'Only an auditor (reviewer) can export / التصدير للمراجع فقط');
  if (x.created_by === req.user.id) throw new HttpError(403, 'The person who uploaded the file cannot approve it / لا يجوز لرافع الملف اعتماده');
  if (x.status !== 'pending_review') throw new HttpError(400, 'Already processed / تمت معالجته');
  const rows = validate(x.entity, x.rows, req);
  const approved = rows.filter((r) => r.state === 'approved');
  if (!approved.length) throw new HttpError(400, 'Approve at least one row / اعتمد صفًا واحدًا على الأقل');
  const results = approved.map((r, i) => ({ row: i + 1, raw: r.data, errors: r.errors, mode: r.mode }));
  const { commitRows } = require('./importexport');
  const out = commitRows(x.entity, results, req);
  const b = run(`INSERT INTO import_batches(entity, file_name, status, total, valid, invalid, inserted, updated, rows_json, created_by, committed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    x.entity, `${x.original_name} (#${x.id})`, 'committed', results.length, results.filter((r) => !r.errors.length).length, results.filter((r) => r.errors.length).length,
    out.inserted, out.updated, JSON.stringify({ results, unknown: [] }), req.user.id, nowIso());
  const status = out.failed ? 'partially_exported' : 'exported';
  run('UPDATE extractions SET status = ?, reviewed_by = ?, reviewed_at = ?, exported_at = ?, import_batch_id = ?, result_json = ? WHERE id = ?',
    status, req.user.id, nowIso(), nowIso(), Number(b.lastInsertRowid), JSON.stringify(out), x.id);
  audit(req, 'export', 'extraction', x.id, null, { entity: x.entity, ...out });
  notify([x.created_by], {
    type: 'extraction_exported', severity: out.failed ? 'warning' : 'info', email: false,
    title: `أُضيفت البيانات المستخرجة للنظام #${x.id} / Extracted data added to the system #${x.id}`,
    body: `${x.original_name}: +${out.inserted} · ~${out.updated}${out.failed ? ' · ✗' + out.failed : ''}`, link: `/extract/${x.id}`,
  });
  return out;
}

function reject(x, reason, req) {
  if (!canReview(req.user)) throw new HttpError(403, 'Forbidden');
  if (x.status !== 'pending_review') throw new HttpError(400, 'Already processed / تمت معالجته');
  if (!reason) throw new HttpError(400, 'A reason is required / السبب مطلوب');
  run("UPDATE extractions SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?", req.user.id, nowIso(), reason, x.id);
  audit(req, 'reject', 'extraction', x.id, null, { reason });
  notify([x.created_by], { type: 'extraction_rejected', severity: 'warning', email: false, title: `رُفض الاستخراج #${x.id} / Extraction rejected #${x.id}`, body: reason, link: `/extract/${x.id}` });
}

module.exports = {
  TARGETS, AI_ON, EXTRACTABLE, kindOf, extractFile, mapContent, mapLabels, rowsFromText, rowsFromMatrix, readPdf, readDocx,
  canExtract, canReview, validate, create, load, saveEdits, exportApproved, reject, reviewerIds,
};

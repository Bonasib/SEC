'use strict';
const express = require('express');
const multer = require('multer');
const { db, all, get, run } = require('../db');
const { audit, HttpError, nowIso } = require('../util');
const { ENTITIES, canImport, canExport } = require('../entities');
const { templateWorkbook, exportWorkbook, toCsv, parseUpload } = require('../importexport');
const { requireRole } = require('../perm');
const { notify } = require('../notify');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function entityOr404(name) {
  if (!ENTITIES[name]) throw new HttpError(404, 'Unknown data type');
  return ENTITIES[name];
}
const stamp = () => nowIso().slice(0, 16).replace(/[-:T]/g, '');

router.get('/data', (req, res) => {
  const list = Object.keys(ENTITIES).map((k) => ({ key: k, label: ENTITIES[k].label, canImport: canImport(k, req.user), canExport: canExport(k, req.user), columns: ENTITIES[k].columns }));
  const batches = all(`SELECT b.id, b.entity, b.file_name, b.status, b.total, b.valid, b.invalid, b.inserted, b.updated, b.created_at, b.committed_at, e.name_ar, e.name_en
    FROM import_batches b LEFT JOIN employees e ON e.id = b.created_by ORDER BY b.id DESC LIMIT 30`);
  res.render('data', { list, batches });
});

router.get('/data/template/:entity', async (req, res, next) => {
  try {
    entityOr404(req.params.entity);
    const wb = await templateWorkbook(req.params.entity);
    res.attachment(`template_${req.params.entity}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.get('/data/export/:entity', async (req, res, next) => {
  try {
    const def = entityOr404(req.params.entity);
    if (!canExport(req.params.entity, req.user)) throw new HttpError(403, res.locals.t('forbidden'));
    const rows = def.exportRows(req.query, req.user);
    audit(req, 'export', req.params.entity, null, null, { rows: rows.length, format: req.query.format || 'xlsx', filters: req.query });
    const name = `${req.params.entity}_${stamp()}`;
    if (req.query.format === 'csv') {
      res.attachment(`${name}.csv`);
      res.type('text/csv; charset=utf-8');
      return res.send(toCsv(rows));
    }
    const wb = await exportWorkbook([[req.params.entity, rows]]);
    res.attachment(`${name}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.get('/data/export-all', requireRole('admin', 'auditor'), async (req, res, next) => {
  try {
    const sheets = Object.keys(ENTITIES).map((k) => [k, ENTITIES[k].exportRows({}, req.user)]);
    audit(req, 'export', 'all', null, null, { sheets: sheets.map(([k, r]) => `${k}:${r.length}`) });
    const wb = await exportWorkbook(sheets);
    res.attachment(`transmission_full_export_${stamp()}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { next(e); }
});

router.post('/data/import/:entity', upload.single('file'), async (req, res, next) => {
  try {
    const entity = req.params.entity;
    const def = entityOr404(entity);
    if (!canImport(entity, req.user)) throw new HttpError(403, res.locals.t('forbidden'));
    if (!req.file) throw new HttpError(400, 'Choose a file / اختر ملفًا');
    let parsed;
    try { parsed = await parseUpload(req.file.buffer, req.file.originalname, entity); }
    catch (e) { throw new HttpError(400, e.message); }
    const results = parsed.rows.map((raw) => {
      const { __row, ...row } = raw;
      const v = def.validate(row, req);
      return { row: __row, raw: row, errors: v.errors, mode: v.mode };
    });
    const valid = results.filter((r) => !r.errors.length).length;
    const b = run('INSERT INTO import_batches(entity, file_name, total, valid, invalid, rows_json, created_by) VALUES (?,?,?,?,?,?,?)',
      entity, req.file.originalname, results.length, valid, results.length - valid, JSON.stringify({ results, unknown: parsed.unknown }), req.user.id);
    audit(req, 'import_preview', entity, b.lastInsertRowid, null, { file: req.file.originalname, total: results.length, valid });
    res.redirect(`/data/import/batch/${b.lastInsertRowid}`);
  } catch (e) { next(e); }
});

function loadBatch(req) {
  const b = get('SELECT * FROM import_batches WHERE id = ?', Number(req.params.id));
  if (!b) throw new HttpError(404, 'Not found');
  if (b.created_by !== req.user.id && !['admin', 'auditor'].includes(req.user.role)) throw new HttpError(403, 'Forbidden');
  return b;
}

router.get('/data/import/batch/:id', (req, res) => {
  const b = loadBatch(req);
  const payload = JSON.parse(b.rows_json || '{}');
  res.render('import_preview', { b, results: payload.results || [], unknown: payload.unknown || [], columns: ENTITIES[b.entity].columns.map(([k]) => k) });
});

router.post('/data/import/batch/:id/commit', (req, res) => {
  const b = loadBatch(req);
  if (b.status !== 'preview') throw new HttpError(400, 'This batch was already processed / تمت معالجة هذه الدفعة');
  if (!canImport(b.entity, req.user)) throw new HttpError(403, 'Forbidden');
  const def = ENTITIES[b.entity];
  const payload = JSON.parse(b.rows_json);
  // Work orders commit row by row (each has its own transaction and emails);
  // other data commits in one transaction with a savepoint per row.
  const wrap = !['work_orders', 'point_requests', 'courses', 'course_attendees'].includes(b.entity);
  let inserted = 0, updated = 0;
  if (wrap) db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of payload.results) {
      if (r.errors.length) { r.outcome = 'skipped'; continue; }
      // Re-validate: data may have changed since the preview
      const v = def.validate(r.raw, req);
      if (v.errors.length) { r.errors = v.errors; r.outcome = 'failed'; continue; }
      if (wrap) db.exec('SAVEPOINT row');
      try {
        const ref = def.apply(v.data, v.mode, req);
        if (wrap) db.exec('RELEASE row');
        r.outcome = v.mode === 'update' ? 'updated' : 'inserted';
        if (ref) r.ref = ref;
        v.mode === 'update' ? updated++ : inserted++;
      } catch (e) {
        if (wrap) { db.exec('ROLLBACK TO row'); db.exec('RELEASE row'); }
        r.errors = [e.message];
        r.outcome = 'failed';
      }
    }
    if (wrap) db.exec('COMMIT');
  } catch (e) {
    if (wrap) db.exec('ROLLBACK');
    throw e;
  }
  run("UPDATE import_batches SET status = 'committed', inserted = ?, updated = ?, rows_json = ?, committed_at = ? WHERE id = ?",
    inserted, updated, JSON.stringify(payload), nowIso(), b.id);
  audit(req, 'import_commit', b.entity, b.id, null, { inserted, updated, file: b.file_name });
  const failed = payload.results.filter((r) => r.outcome === 'failed').length;
  notify([req.user.id], {
    type: 'import_done', severity: failed ? 'warning' : 'info', email: false,
    title: `اكتمل الاستيراد / Import finished: ${b.entity}`, body: `+${inserted} / ~${updated} / ✗${failed}`, link: `/data/import/batch/${b.id}`,
  });
  res.flash(failed ? 'warning' : 'success', `${res.locals.t('inserted')}: ${inserted} · ${res.locals.t('updated')}: ${updated}${failed ? ` · ✗ ${failed}` : ''}`);
  res.redirect(`/data/import/batch/${b.id}`);
});

module.exports = router;

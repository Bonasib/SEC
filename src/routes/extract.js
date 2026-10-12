'use strict';
const express = require('express');
const { all, get } = require('../db');
const { HttpError } = require('../util');
const { ENTITIES } = require('../entities');
const F = require('../files');
const X = require('../extract');

const router = express.Router();
const ensureExtract = (req) => { if (!X.canExtract(req.user) && !X.canReview(req.user)) { F.cleanup(req); throw new HttpError(403, 'Forbidden / ليست لديك صلاحية'); } };

router.get('/extract', (req, res) => {
  ensureExtract(req);
  const reviewer = X.canReview(req.user);
  const cond = [], p = [];
  if (!reviewer) { cond.push('x.created_by = ?'); p.push(req.user.id); }
  if (req.query.status) { cond.push('x.status = ?'); p.push(req.query.status); }
  const rows = all(`SELECT x.id, x.original_name, x.mime, x.entity, x.method, x.status, x.created_at, x.reviewed_at, x.rows_json, x.created_by,
      e.name_ar, e.name_en, r.name_ar rev_ar, r.name_en rev_en FROM extractions x LEFT JOIN employees e ON e.id = x.created_by LEFT JOIN employees r ON r.id = x.reviewed_by
    ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY x.status = 'pending_review' DESC, x.id DESC LIMIT 300`, ...p)
    .map((x) => { const rs = JSON.parse(x.rows_json || '[]'); return { ...x, n: rs.length, approved: rs.filter((r) => r.state === 'approved').length, bad: rs.filter((r) => r.errors?.length && r.state !== 'rejected').length }; });
  const count = (st) => get(`SELECT COUNT(*) n FROM extractions x WHERE status = ?${reviewer ? '' : ' AND created_by = ' + Number(req.user.id)}`, st).n;
  res.render('extract', {
    rows, reviewer, TARGETS: X.TARGETS, ENTITIES, aiOn: X.AI_ON(),
    stats: { pending: count('pending_review'), exported: count('exported') + count('partially_exported'), rejected: count('rejected') },
  });
});

router.post('/extract', F.docUpload.array('files', 10), async (req, res, next) => {
  try {
    ensureExtract(req);
    if (!req.files?.length) throw new HttpError(400, 'Choose a file / اختر ملفًا');
    const entity = X.TARGETS.includes(req.body.entity) ? req.body.entity : 'auto';
    const method = ['auto', 'local', 'ai'].includes(req.body.method) ? req.body.method : 'auto';
    const ids = [];
    for (const f of req.files) {
      if (!X.EXTRACTABLE(f.mimetype, f.originalname)) { F.remove(F.rel(f.path)); continue; }
      const result = await X.extractFile({ absPath: f.path, mime: f.mimetype, name: f.originalname }, entity, method);
      ids.push(X.create({ file: { rel: F.rel(f.path), name: f.originalname, mime: f.mimetype, size: f.size, sha256: F.sha256(f.path) }, entity, method, note: (req.body.note || '').trim() }, result, req));
    }
    if (!ids.length) throw new HttpError(400, 'Supported files: Excel (.xlsx), CSV, Word (.docx), PDF, images / الملفات المدعومة');
    res.flash('success', `${res.locals.t('extract_done')} (${ids.length})`);
    res.redirect(ids.length === 1 ? `/extract/${ids[0]}` : '/extract');
  } catch (e) { F.cleanup(req); next(e); }
});

// Start an extraction from a document already attached to a work order, vehicle or employee
router.post('/extract/from-document/:docId(\\d+)', async (req, res, next) => {
  try {
    ensureExtract(req);
    const d = require('../documents').find(Number(req.params.docId), req.user, false);
    if (!X.EXTRACTABLE(d.mime, d.original_name)) throw new HttpError(400, 'This file type cannot be read / لا يمكن قراءة هذا النوع');
    const result = await X.extractFile({ absPath: F.abs(d.file_name), mime: d.mime, name: d.original_name }, 'auto', 'auto');
    const id = X.create({ file: { rel: d.file_name, name: d.original_name, mime: d.mime, size: d.size, sha256: d.sha256 }, entity: 'auto', method: 'auto', note: `${d.entity}:${d.entity_id}`, documentId: d.id }, result, req);
    res.redirect(`/extract/${id}`);
  } catch (e) { next(e); }
});

router.get('/extract/:id(\\d+)', (req, res) => {
  const x = X.load(Number(req.params.id), req.user);
  const cols = x.entity ? ENTITIES[x.entity].columns : [];
  const used = new Set(x.rows.flatMap((r) => Object.keys(r.data)));
  const showAll = req.query.all === '1' || !x.rows.length;
  const visible = cols.filter(([k, , , reqd]) => showAll || reqd || used.has(k));
  res.render('extraction', {
    x, cols, visible, showAll, TARGETS: X.TARGETS, ENTITIES, reviewer: X.canReview(req.user), self: x.created_by === req.user.id, aiOn: X.AI_ON(),
    uploader: get('SELECT id, employee_no, name_ar, name_en FROM employees WHERE id = ?', x.created_by),
    reviewerRow: x.reviewed_by ? get('SELECT id, employee_no, name_ar, name_en FROM employees WHERE id = ?', x.reviewed_by) : null,
    result: x.result_json ? JSON.parse(x.result_json) : null,
  });
});

router.get('/extract/:id(\\d+)/file', (req, res) => {
  const x = X.load(Number(req.params.id), req.user);
  const inline = /^(application\/pdf|image\/)/.test(x.mime || '');
  F.send(res, x.file_name, x.mime, x.original_name, inline);
});

router.post('/extract/:id(\\d+)', async (req, res, next) => {
  try {
    let x = X.load(Number(req.params.id), req.user);
    const action = req.body.action;
    if (action === 'reject') {
      X.reject(x, (req.body.reason || '').trim(), req);
      res.flash('success', res.locals.t('saved'));
      return res.redirect(`/extract/${x.id}`);
    }
    if (action === 'reextract') {
      // Read the file again for another data type / method; the edits so far are replaced
      if (x.status !== 'pending_review') throw new HttpError(400, 'Already processed / تمت معالجته');
      const entity = X.TARGETS.includes(req.body.entity) ? req.body.entity : 'auto';
      const result = await X.extractFile({ absPath: F.abs(x.file_name), mime: x.mime, name: x.original_name }, entity, req.body.method || 'auto');
      const rows = X.validate(result.entity || entity, result.rows.map((d) => ({ data: d, state: 'pending' })), req);
      require('../db').run('UPDATE extractions SET entity = ?, method = ?, rows_json = ?, warnings_json = ? WHERE id = ?', result.entity || (entity === 'auto' ? x.entity : entity), result.method, JSON.stringify(rows), JSON.stringify(result.warnings), x.id);
      res.flash('success', res.locals.t('saved'));
      return res.redirect(`/extract/${x.id}`);
    }
    if (action === 'export' && (!X.canReview(req.user) || x.created_by === req.user.id)) {
      throw new HttpError(403, x.created_by === req.user.id ? 'The person who uploaded the file cannot approve it / لا يجوز لرافع الملف اعتماده' : 'Only an auditor (reviewer) can export / التصدير للمراجع فقط');
    }
    x = X.saveEdits(x, req.body, req);
    if (action === 'export') {
      const out = X.exportApproved(x, req);
      res.flash(out.failed ? 'warning' : 'success', `${res.locals.t('inserted')}: ${out.inserted} · ${res.locals.t('updated')}: ${out.updated}${out.failed ? ' · ✗ ' + out.failed : ''}`);
    } else res.flash('success', res.locals.t('saved'));
    res.redirect(`/extract/${x.id}${req.body.all === '1' ? '?all=1' : ''}#rows`);
  } catch (e) { next(e); }
});

module.exports = router;

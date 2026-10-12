'use strict';
const express = require('express');
const F = require('../files');
const Docs = require('../documents');

const router = express.Router();
const ENTITY = { wo: 'work_order', vehicle: 'vehicle', employee: 'employee' };
const back = (entity, id) => (entity === 'work_order' ? `/wo/${id}#documents` : entity === 'vehicle' ? `/fleet/${id}#documents` : `/employees/${id}#documents`);

router.post('/documents/:kind(wo|vehicle|employee)/:id(\\d+)', F.docUpload.array('files', 10), (req, res) => {
  const entity = ENTITY[req.params.kind], id = Number(req.params.id);
  try {
    const n = Docs.add(entity, id, req.files, req.body, req);
    res.flash('success', `${res.locals.t('saved')} (${n})`);
  } catch (e) {
    F.cleanup(req);
    throw e;
  }
  res.redirect(back(entity, id));
});

router.get('/documents/:id(\\d+)', (req, res) => {
  const d = Docs.find(Number(req.params.id), req.user, false);
  const inline = /^(application\/pdf|image\/)/.test(d.mime || '') && req.query.download !== '1';
  F.send(res, d.file_name, d.mime, d.original_name || `document-${d.id}`, inline);
});

router.post('/documents/:id(\\d+)/delete', (req, res) => {
  const d = Docs.remove(Number(req.params.id), req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(back(d.entity, d.entity_id));
});

module.exports = router;

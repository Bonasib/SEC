'use strict';
const express = require('express');
const { all, get } = require('../db');
const { HttpError } = require('../util');
const { sections } = require('../org');
const I = require('../items');

const router = express.Router();
const ensure = (req, res) => { if (!I.canManage(req.user)) throw new HttpError(403, res.locals.t('forbidden')); };
const categories = () => all("SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category <> '' ORDER BY category").map((r) => r.category);

router.get('/materials', (req, res) => {
  res.render('materials', {
    rows: I.list(req.query), stats: I.stats(), KINDS: I.KINDS, UOMS: I.UOMS, categories: categories(), sections: sections(), canEdit: I.canManage(req.user),
  });
});

router.get('/materials/:id(\\d+)', (req, res) => {
  const item = get('SELECT i.*, s.code section_code FROM items i LEFT JOIN org_units s ON s.id = i.section_id WHERE i.id = ?', Number(req.params.id));
  if (!item) throw new HttpError(404, res.locals.t('not_found'));
  res.render('material', {
    item: I.withStock(item), KINDS: I.KINDS, UOMS: I.UOMS, categories: categories(), sections: sections(), canEdit: I.canManage(req.user),
    movements: all(`SELECT m.*, w.wo_number, e.name_ar, e.name_en FROM item_movements m LEFT JOIN work_orders w ON w.id = m.wo_id
      LEFT JOIN employees e ON e.id = m.created_by WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 200`, item.id),
    wos: all(`SELECT x.*, w.wo_number, w.title, w.status, w.planned_start, w.planned_end FROM wo_items x JOIN work_orders w ON w.id = x.wo_id
      WHERE x.item_id = ? ORDER BY x.settled, w.planned_start DESC LIMIT 200`, item.id),
  });
});

router.post('/materials', (req, res) => {
  ensure(req, res);
  const id = I.save(req.body, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/materials/${id}`);
});

router.post('/materials/:id(\\d+)', (req, res) => {
  ensure(req, res);
  I.save(req.body, req, Number(req.params.id));
  I.lowStockCheck([Number(req.params.id)]);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/materials/${req.params.id}`);
});

router.post('/materials/:id(\\d+)/stock', (req, res) => {
  ensure(req, res);
  I.stockMove(Number(req.params.id), { kind: req.body.kind, qty: req.body.qty, note: (req.body.note || '').trim() }, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/materials/${req.params.id}#movements`);
});

module.exports = router;

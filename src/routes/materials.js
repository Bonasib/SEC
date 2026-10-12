'use strict';
const express = require('express');
const { all, get } = require('../db');
const { HttpError, todayRiyadh } = require('../util');
const { sections } = require('../org');
const F = require('../files');
const I = require('../items');

const router = express.Router();
const ensure = (req, res) => { if (!I.canManage(req.user)) { F.cleanup(req); throw new HttpError(403, res.locals.t('forbidden')); } };
const categories = () => all("SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND category <> '' ORDER BY category").map((r) => r.category);
const TX_KINDS = ['receive', 'consume', 'damage', 'adjust', 'reserve', 'order'];

router.get('/materials', (req, res) => {
  res.render('materials', {
    rows: I.list(req.query), stats: I.stats(), KINDS: I.KINDS, UOMS: I.UOMS, categories: categories(), sections: sections(), canEdit: I.canManage(req.user),
  });
});

// All item transactions: stock movements, work-order reservations and supplier orders
router.get('/materials/transactions', async (req, res, next) => {
  try {
    const rows = I.transactions(req.query);
    if (req.query.format) {
      const out = rows.map((r) => ({
        date: r.at.slice(0, 16).replace('T', ' '), type: r.kind, item_code: r.code, inventory_no: r.inventory_no || '', item: r.name_ar, qty: r.qty, uom: r.uom,
        balance: r.balance ?? '', work_order: r.wo_number || '', order_no: r.order_no || '', note: r.note || '', by: r.by_ar || '',
      }));
      const { exportWorkbook, toCsv } = require('../importexport');
      if (req.query.format === 'csv') { res.type('text/csv; charset=utf-8').attachment(`item_transactions_${todayRiyadh()}.csv`); return res.send(toCsv(out)); }
      const wb = await exportWorkbook([['item_transactions', out]]);
      res.attachment(`item_transactions_${todayRiyadh()}.xlsx`);
      await wb.xlsx.write(res);
      return res.end();
    }
    res.render('item_transactions', { rows: rows.slice(0, 1000), total: rows.length, TX_KINDS, items: all('SELECT id, code, name_ar, name_en FROM items ORDER BY code') });
  } catch (e) { next(e); }
});

router.get('/materials/:id(\\d+)', (req, res) => {
  const item = get('SELECT i.*, s.code section_code FROM items i LEFT JOIN org_units s ON s.id = i.section_id WHERE i.id = ?', Number(req.params.id));
  if (!item) throw new HttpError(404, res.locals.t('not_found'));
  res.render('material', {
    item: I.withStock(item), KINDS: I.KINDS, UOMS: I.UOMS, categories: categories(), sections: sections(), canEdit: I.canManage(req.user),
    summary: I.summary(item.id), transactions: I.transactions({ item: item.id }).slice(0, 200),
    orders: all('SELECT o.*, e.name_ar, e.name_en FROM item_orders o LEFT JOIN employees e ON e.id = o.created_by WHERE o.item_id = ? ORDER BY o.status = \'open\' DESC, o.id DESC', item.id),
    wos: all(`SELECT x.*, w.wo_number, w.title, w.status, w.planned_start, w.planned_end FROM wo_items x JOIN work_orders w ON w.id = x.wo_id
      WHERE x.item_id = ? ORDER BY x.settled, w.planned_start DESC LIMIT 200`, item.id),
  });
});

router.get('/materials/:id(\\d+)/photo', (req, res) => {
  const i = get('SELECT photo FROM items WHERE id = ?', Number(req.params.id));
  if (!i?.photo) throw new HttpError(404, 'Not found');
  F.send(res, i.photo, null);
});

router.post('/materials', F.imageUpload.single('photo'), (req, res) => {
  ensure(req, res);
  let id;
  try { id = I.save(req.body, req, undefined, req.file); } catch (e) { F.cleanup(req); throw e; }
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/materials/${id}`);
});

router.post('/materials/:id(\\d+)', F.imageUpload.single('photo'), (req, res) => {
  ensure(req, res);
  try { I.save(req.body, req, Number(req.params.id), req.file); } catch (e) { F.cleanup(req); throw e; }
  if (req.body.remove_photo === '1' && !req.file) I.setPhoto(Number(req.params.id), null, req);
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

router.post('/materials/:id(\\d+)/orders', (req, res) => {
  ensure(req, res);
  I.createOrder(Number(req.params.id), req.body, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/materials/${req.params.id}#orders`);
});
router.post('/materials/orders/:oid(\\d+)/receive', (req, res) => {
  ensure(req, res);
  const itemId = I.receiveOrder(Number(req.params.oid), req.body.qty, req);
  res.flash('success', res.locals.t('saved'));
  res.redirect(`/materials/${itemId}#orders`);
});
router.post('/materials/orders/:oid(\\d+)/cancel', (req, res) => {
  ensure(req, res);
  const itemId = I.cancelOrder(Number(req.params.oid), req);
  res.redirect(`/materials/${itemId}#orders`);
});

module.exports = router;

'use strict';
const express = require('express');
const { searchKey } = require('../db');
const S = require('../search');

const router = express.Router();

router.get('/search', (req, res) => {
  const q = String(req.query.q || '').slice(0, 80).trim();
  const groups = S.search(q, req.user, res.locals);
  // From the top bar: an exact code (work-order number, employee ID, plate, item code) opens the record directly
  if (req.query.jump === '1' && q) {
    const exact = groups.flatMap((g) => g.rows).filter((r) => !r.external && r.code && searchKey(r.code) === searchKey(q));
    if (exact.length === 1) return res.redirect(exact[0].href);
  }
  res.render('search', { q, groups, LIMIT: S.LIMIT });
});

module.exports = router;

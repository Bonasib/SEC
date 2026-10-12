'use strict';
const express = require('express');
const { sections } = require('../org');
const B = require('../board');

const router = express.Router();
const TYPES = ['wo_created', 'wo_closed', 'wo_cancelled', 'extension', 'handover', 'task_done', 'absence', 'course', 'holiday', 'points', 'stock'];

router.get('/board', (req, res) => {
  const data = B.build(req.query, req.user);
  const { t, nm, lbl } = res.locals;
  const en = req.lang === 'en';
  // Keep only links the reader may open
  const canOpen = (link) => {
    if (!link) return false;
    const m = link.match(/^\/(employees|points\/employee)\/(\d+)/);
    if (!m) return true;
    return m[1] === 'employees' ? !!res.locals.empHref(m[2]) : !!res.locals.ptsHref(m[2]);
  };
  // Feed rows ready for the browser: labels in the reader's language
  const feed = data.events.map((e) => ({
    type: e.type, day: e.day, at: e.at, link: canOpen(e.link) ? e.link : null, critical: !!e.critical, section: e.section || '',
    title: en && e.title_en ? e.title_en : e.title, sub: e.leave ? `${lbl('leave_type', e.leave)} · ${e.sub}` : e.sub || '',
    who: e.who ? nm(e.who) : '', label: t('bev_' + e.type),
  }));
  const json = JSON.stringify({ feed, days: data.summary.days, types: TYPES.map((k) => ({ key: k, label: t('bev_' + k), n: data.summary.totals[k] || 0 })) }).replace(/</g, '\\u003c');
  res.render('board', { ...data, TYPES, json, sections: sections() });
});

module.exports = router;

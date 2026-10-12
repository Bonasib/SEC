'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { get, run, all } = require('./db');
const { makeT, makeLbl } = require('./i18n');
const { fmt, verifyPassword, audit, HttpError, nowIso, utcToLocalInput } = require('./util');
const { processEmailQueue, SMTP_ON } = require('./notify');
const { runAlertChecks } = require('./alerts');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// Secure cookies by default in production (the site must then be served over HTTPS)
const SECURE_COOKIES = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production';
const cookieOpts = 'Path=/; HttpOnly; SameSite=Lax' + (SECURE_COOKIES ? '; Secure' : '');
let IS_DEMO = null;
const isDemo = () => (IS_DEMO === null ? (IS_DEMO = require('./bootstrap').isDemoDatabase()) : IS_DEMO);

app.use((req, res, next) => {
  const c = cookies(req);
  req.lang = c.lang === 'en' ? 'en' : 'ar';
  res.locals.theme = ['light', 'dark'].includes(c.theme) ? c.theme : 'auto';
  if (c.sid) {
    const s = get('SELECT * FROM sessions WHERE token = ? AND expires_at > ?', c.sid, nowIso());
    if (s) req.user = get("SELECT * FROM employees WHERE id = ? AND status = 'active'", s.employee_id);
  }
  const t = makeT(req.lang);
  res.locals.t = t;
  res.locals.lbl = makeLbl(req.lang);
  // Stored bilingual text ("عربي / English", line by line) shown in the reader's language
  const { splitBilingual } = require('./notify');
  res.locals.tx = (text) => String(text ?? '').split('\n').map((l) => { const b = splitBilingual(l); return (req.lang === 'en' ? b.en : b.ar) || b.ar || b.en; }).join('\n');
  res.locals.lang = req.lang;
  res.locals.dir = req.lang === 'ar' ? 'rtl' : 'ltr';
  res.locals.user = req.user;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.fmt = (iso, withTime = true) => fmt(iso, req.lang, withTime);
  res.locals.localInput = utcToLocalInput;
  // Sample employees have no real English name ("F001 (sample)"), so show the Arabic name instead
  const enName = (o) => (req.lang === 'en' && o.name_en && !/\(sample\)$/.test(o.name_en) ? o.name_en : null);
  res.locals.nm = (o) => (o ? enName(o) || o.name_ar : '—');
  res.locals.smtpOn = SMTP_ON;
  res.locals.isDemo = isDemo();
  // Links to profiles / point statements only where the reader may open them (no dead 403 links)
  const peopleView = !!req.user && require('./perm').PEOPLE_VIEW.includes(req.user.role);
  res.locals.canPeople = peopleView;
  res.locals.empHref = (id) => (req.user && (peopleView || Number(id) === req.user.id) ? `href="/employees/${Number(id)}"` : '');
  res.locals.ptsHref = (id, q = '') => (req.user && (Number(id) === req.user.id || require('./access').can(req.user, 'points.view_all') === true) ? `href="/points/employee/${Number(id)}${q}"` : '');
  res.locals.hasPerm = (perm, sectionId) => (req.user ? require('./access').can(req.user, perm, sectionId) : false);
  // Direction arrow for links and ranges: points the way the text reads
  res.locals.arrow = req.lang === 'ar' ? '←' : '→';
  res.locals.ic = (name, cls = '') => `<svg class="ic ${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
  res.locals.initials = (o) => String((o && (enName(o) || o.name_ar)) || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
  res.locals.face = require('./avatars').makeFace(res.locals.initials);
  // Item picture (or an icon by kind) for the inventory lists and the work order picker
  res.locals.thumb = (i, cls = '') => (i && i.photo
    ? `<span class="thumb ${cls}"><img src="/materials/${i.item_id || i.id}/photo?v=${encodeURIComponent(String(i.photo).split('/').pop().slice(0, 8))}" alt="" loading="lazy"></span>`
    : `<span class="thumb ik-${i?.kind || 'material'} ${cls}" aria-hidden="true">${res.locals.ic(i?.kind === 'tool' ? 'wrench' : i?.kind === 'equipment' ? 'zap' : 'package')}</span>`);
  // Badge for auditors: extracted files waiting for review
  res.locals.pendingExtractions = req.user && require('./access').can(req.user, 'data.review') === true ? get("SELECT COUNT(*) n FROM extractions WHERE status = 'pending_review' AND created_by <> ?", req.user.id).n : 0;
  res.locals.unread = req.user ? get('SELECT COUNT(*) n FROM notifications WHERE employee_id = ? AND read_at IS NULL', req.user.id).n : 0;
  res.locals.flash = c.flash ? JSON.parse(c.flash) : null;
  if (c.flash) res.append('Set-Cookie', `flash=; Max-Age=0; ${cookieOpts}`);
  res.flash = (type, msg) => res.append('Set-Cookie', `flash=${encodeURIComponent(JSON.stringify({ type, msg: String(msg).slice(0, 1500) }))}; ${cookieOpts}`);
  next();
});

// Health check for the hosting platform / uptime monitors
app.get('/healthz', (req, res) => {
  try { get('SELECT 1 AS ok'); res.json({ ok: true, time: nowIso() }); } catch (e) { res.status(500).json({ ok: false }); }
});

// ----- auth -----
app.get('/lang/:l', (req, res) => {
  res.append('Set-Cookie', `lang=${req.params.l === 'en' ? 'en' : 'ar'}; Path=/; Max-Age=31536000; SameSite=Lax`);
  const back = req.get('referer');
  res.redirect(back && new URL(back).host === req.get('host') ? back : '/');
});
app.get('/theme/:t', (req, res) => {
  const t = ['light', 'dark'].includes(req.params.t) ? req.params.t : 'auto';
  res.append('Set-Cookie', `theme=${t}; Path=/; Max-Age=31536000; SameSite=Lax`);
  const back = req.get('referer');
  res.redirect(back && new URL(back).host === req.get('host') ? back : '/');
});
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const e = get("SELECT * FROM employees WHERE employee_no = ? AND status = 'active'", String(req.body.employee_no || '').trim());
  if (!e || !verifyPassword(String(req.body.password || ''), e.password_hash)) {
    audit({ ip: req.ip, get: req.get.bind(req) }, 'login_failed', 'session', req.body.employee_no);
    return res.status(401).render('login', { error: res.locals.t('invalid_login') });
  }
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, employee_id, created_at, expires_at) VALUES (?,?,?,?)', token, e.id, nowIso(), new Date(Date.now() + 12 * 3600e3).toISOString());
  audit({ user: e, ip: req.ip, get: req.get.bind(req) }, 'login', 'session', e.employee_no);
  res.append('Set-Cookie', `sid=${token}; Max-Age=${12 * 3600}; ${cookieOpts}`);
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  const c = cookies(req);
  if (c.sid) run('DELETE FROM sessions WHERE token = ?', c.sid);
  res.append('Set-Cookie', `sid=; Max-Age=0; ${cookieOpts}`);
  res.redirect('/login');
});

app.use((req, res, next) => (req.user ? next() : res.redirect('/login')));

app.use(require('./routes/dashboard'));
app.use(require('./routes/board'));
app.use(require('./routes/workorders'));
app.use(require('./routes/people'));
app.use(require('./routes/registry'));
app.use(require('./routes/materials'));
app.use(require('./routes/documents'));
app.use(require('./routes/extract'));
app.use(require('./routes/search'));
app.use(require('./routes/tasks'));
app.use(require('./routes/data'));
app.use(require('./routes/calendar'));
app.use(require('./routes/points'));
app.use(require('./routes/training'));
app.use(require('./routes/travel'));
app.use(require('./routes/plans'));
app.use(require('./routes/access'));
app.use(require('./routes/system'));

app.use((req, res) => res.status(404).render('error', { status: 404, message: res.locals.t('not_found') }));

// Form errors go back to the page with a flash message; others render an error page.
app.use((err, req, res, _next) => {
  if (err.name === 'MulterError') err.status = 400;
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const msg = status === 403 && !err.message ? res.locals.t('forbidden') : err.message;
  const back = req.get('referer');
  if (req.method === 'POST' && back && status < 500) {
    res.flash('error', msg);
    return res.redirect(back);
  }
  res.status(status).render('error', { status, message: msg });
});

function startSchedulers() {
  setInterval(() => processEmailQueue().catch((e) => console.error('email', e)), 10_000).unref();
  setInterval(() => { try { runAlertChecks(); } catch (e) { console.error('alerts', e); } }, 60_000).unref();
  setTimeout(() => { try { runAlertChecks(); } catch (e) { console.error(e); } processEmailQueue(); }, 2000).unref();
}

require('./points').ensureRules();

if (require.main === module) {
  if (!get('SELECT 1 FROM employees LIMIT 1')) {
    // Sample data only when explicitly requested (local testing / demos); production starts clean
    if (process.env.SEED_DEMO === 'true' || (process.env.NODE_ENV !== 'production' && process.env.SEED_DEMO !== 'false')) {
      console.log('Empty database - seeding SAMPLE data (SEED_DEMO)...');
      require('./seed').seed();
    } else {
      require('./bootstrap').bootstrapProduction();
    }
  }
  require('./points').ensureRules();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`SEC Transmission WMS running at http://localhost:${port}`);
    console.log(SMTP_ON ? `SMTP: ${process.env.SMTP_HOST}` : 'SMTP not configured - emails are stored in the Email Outbox (/outbox)');
  });
  startSchedulers();
  // Graceful stop for PM2 / Docker / the hosting panel
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      server.close(() => { try { require('./db').db.close(); } catch (e) { /* already closed */ } process.exit(0); });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

module.exports = { app, startSchedulers };

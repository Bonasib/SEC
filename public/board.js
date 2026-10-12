// Board: interactive events summary (type tiles, day chart, search, grouped feed)
(function () {
  var el = document.getElementById('board-data');
  if (!el) return;
  var data = JSON.parse(el.textContent);
  var rtl = document.documentElement.dir === 'rtl';
  var lang = document.documentElement.lang;
  var state = { type: '', day: '', q: '', limit: 30 };
  var ICON = { wo_created: 'clipboard', wo_closed: 'check-circle', wo_cancelled: 'x-circle', extension: 'clock', handover: 'transfer', task_done: 'tasks',
    absence: 'calendar', course: 'file', holiday: 'star', points: 'star', stock: 'boxes' };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ic = function (n) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; };
  var dayLabel = function (d) {
    return new Date(d + 'T12:00:00Z').toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  };
  var timeLabel = function (iso) {
    var d = new Date(Date.parse(iso) + 3 * 3600e3);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };
  var TXT = rtl ? { clearDay: 'إلغاء تحديد اليوم', of: 'من', none: 'لا توجد أحداث مطابقة', created: 'جديدة', closed: 'مغلقة', other: 'أخرى' }
    : { clearDay: 'Clear day', of: 'of', none: 'No matching events', created: 'created', closed: 'closed', other: 'other' };

  // ---- tiles: filter by event type ----
  var tiles = document.querySelectorAll('#ev-tiles .ev-tile');
  tiles.forEach(function (b) {
    b.addEventListener('click', function () {
      state.type = state.type === b.dataset.type ? '' : b.dataset.type;
      state.limit = 30;
      tiles.forEach(function (x) { var on = x.dataset.type === state.type; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      render();
    });
  });

  // ---- chart: created / closed / other per day; click a bar to focus that day ----
  var chart = document.getElementById('ev-chart'), tip = document.getElementById('ev-tip');
  function drawChart() {
    var days = data.days, n = days.length;
    if (!n) { chart.innerHTML = ''; return; }
    var max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.created + d.closed + d.other; })));
    var W = Math.max(chart.clientWidth, 300), Hh = 160, pad = 18, bw = Math.max(2, (W - pad * 2) / n - 2);
    var svg = '<svg width="' + W + '" height="' + (Hh + 22) + '" viewBox="0 0 ' + W + ' ' + (Hh + 22) + '">';
    svg += '<line x1="' + pad + '" x2="' + (W - pad) + '" y1="' + Hh + '" y2="' + Hh + '" class="axis"/>';
    days.forEach(function (d, i) {
      var x = rtl ? W - pad - (i + 1) * (bw + 2) : pad + i * (bw + 2);
      var y = Hh, seg = function (v, cls) { if (!v) return ''; var h = v / max * (Hh - 10); y -= h; return '<rect class="' + cls + '" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="1.5"/>'; };
      var sel = state.day === d.day ? ' sel' : '';
      svg += '<g class="bar' + sel + '" data-i="' + i + '" tabindex="0" role="button" aria-label="' + d.day + ': ' + d.created + ' ' + TXT.created + ', ' + d.closed + ' ' + TXT.closed + '">'
        + '<rect class="hit" x="' + x + '" y="0" width="' + bw + '" height="' + Hh + '"/>' + seg(d.created, 'c') + seg(d.closed, 'k') + seg(d.other, 'o') + '</g>';
      var every = Math.ceil(n / 8);
      if (i % every === 0) svg += '<text x="' + (x + bw / 2) + '" y="' + (Hh + 15) + '" text-anchor="middle">' + d.day.slice(5) + '</text>';
    });
    chart.innerHTML = svg + '</svg>';
    chart.querySelectorAll('.bar').forEach(function (g) {
      var d = days[g.dataset.i];
      var show = function (e) {
        tip.hidden = false;
        tip.innerHTML = '<b>' + esc(dayLabel(d.day)) + '</b><br>' + d.created + ' ' + TXT.created + ' · ' + d.closed + ' ' + TXT.closed + ' · ' + d.other + ' ' + TXT.other;
        var r = chart.getBoundingClientRect(), gr = g.getBoundingClientRect();
        tip.style.left = Math.min(Math.max(0, gr.left - r.left - 60), r.width - 200) + 'px';
        tip.style.top = '0px';
      };
      g.addEventListener('mouseenter', show); g.addEventListener('focus', show);
      g.addEventListener('mouseleave', function () { tip.hidden = true; }); g.addEventListener('blur', function () { tip.hidden = true; });
      var pick = function () { state.day = state.day === d.day ? '' : d.day; state.limit = 30; drawChart(); render(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }

  // ---- feed ----
  var feed = document.getElementById('ev-feed'), count = document.getElementById('ev-count'), more = document.getElementById('ev-more'), active = document.getElementById('ev-active');
  document.getElementById('ev-search').addEventListener('input', function (e) { state.q = e.target.value.trim().toLowerCase(); state.limit = 30; render(); });
  more.addEventListener('click', function () { state.limit += 30; render(); });
  active.addEventListener('click', function () { state.day = ''; drawChart(); render(); });

  function render() {
    var rows = data.feed.filter(function (e) {
      return (!state.type || e.type === state.type) && (!state.day || e.day === state.day)
        && (!state.q || (e.title + ' ' + e.sub + ' ' + e.who + ' ' + e.label + ' ' + e.section).toLowerCase().indexOf(state.q) >= 0);
    });
    active.hidden = !state.day;
    if (state.day) active.innerHTML = esc(dayLabel(state.day)) + ' ✕';
    active.title = TXT.clearDay;
    count.textContent = rows.length + ' ' + TXT.of + ' ' + data.feed.length;
    var html = '', last = '';
    rows.slice(0, state.limit).forEach(function (e) {
      if (e.day !== last) { html += '<h4 class="ev-day">' + esc(dayLabel(e.day)) + '</h4>'; last = e.day; }
      var inner = '<span class="ev-ic bev-' + e.type + '">' + ic(ICON[e.type] || 'bell') + '</span>'
        + '<span class="ev-main"><span class="ev-label">' + esc(e.label) + (e.critical ? ' <span class="pill bad">C</span>' : '') + (e.section ? ' · <span class="mono">' + esc(e.section) + '</span>' : '') + '</span>'
        + '<b>' + esc(e.title) + '</b>' + (e.who ? '<span class="muted small">' + esc(e.who) + '</span>' : '') + (e.sub ? '<span class="muted small">' + esc(e.sub) + '</span>' : '') + '</span>'
        + '<time class="muted small mono">' + timeLabel(e.at) + '</time>';
      html += e.link ? '<a class="ev-row" href="' + esc(e.link) + '">' + inner + '</a>' : '<div class="ev-row">' + inner + '</div>';
    });
    feed.innerHTML = html || '<p class="empty">' + TXT.none + '</p>';
    more.hidden = rows.length <= state.limit;
  }

  // ---- count-up on the podium scores ----
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.querySelectorAll('[data-count]').forEach(function (n) {
      var to = Number(n.dataset.count), t0 = performance.now();
      var step = function (t) { var k = Math.min(1, (t - t0) / 900); n.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  drawChart(); render();
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawChart, 150); });
})();

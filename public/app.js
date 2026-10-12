(function () {
  var root = document.documentElement;
  var rtl = root.dir === 'rtl';

  // ---- theme toggle (persists in a cookie, no reload) ----
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dark = root.dataset.theme === 'dark' || (root.dataset.theme === 'auto' && root.classList.contains('sys-dark'));
      var next = dark ? 'light' : 'dark';
      root.dataset.theme = next;
      root.classList.remove('sys-dark');
      document.cookie = 'theme=' + next + '; path=/; max-age=31536000; samesite=lax';
    });
  });

  // ---- mobile navigation drawer ----
  var navBtn = document.querySelector('[data-toggle-nav]');
  var setNav = function (open) {
    document.body.classList.toggle('nav-open', open);
    if (navBtn) navBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { var first = document.querySelector('#sidebar a'); if (first) first.focus(); }
  };
  if (navBtn) navBtn.addEventListener('click', function () { setNav(!document.body.classList.contains('nav-open')); });
  document.querySelectorAll('[data-close-nav]').forEach(function (el) { el.addEventListener('click', function () { setNav(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.body.classList.contains('nav-open')) { setNav(false); navBtn && navBtn.focus(); } });

  // ---- login: click a demo account to fill it ----
  document.querySelectorAll('[data-demo]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.getElementById('employee_no').value = b.dataset.demo;
      var pw = document.getElementById('password'); pw.value = 'Demo@12345'; pw.focus();
    });
  });

  // ---- before/after slider (keyboard accessible via the range input) ----
  document.querySelectorAll('[data-compare]').forEach(function (fig) {
    var range = fig.querySelector('input[type=range]');
    var layer = fig.querySelector('.compare-before');
    var handle = fig.querySelector('.handle');
    var set = function () {
      layer.style.width = range.value + '%';
      layer.querySelector('img').style.width = fig.clientWidth + 'px';
      if (handle) handle.style.left = range.value + '%';
    };
    range.addEventListener('input', set);
    window.addEventListener('resize', set);
    set();
  });

  // ---- photo upload: pair field, GPS, file names, drag & drop ----
  var stage = document.getElementById('stage');
  var pair = document.getElementById('pair-wrap');
  if (stage && pair) {
    var toggle = function () { pair.classList.toggle('hidden', stage.value !== 'after'); };
    stage.addEventListener('change', toggle); toggle();
  }
  var up = document.querySelector('.upload-form');
  if (up && navigator.geolocation) {
    var status = up.querySelector('.geo-status');
    navigator.geolocation.getCurrentPosition(function (p) {
      up.lat.value = p.coords.latitude; up.lng.value = p.coords.longitude;
      if (status) status.textContent = 'GPS: ' + p.coords.latitude.toFixed(4) + ', ' + p.coords.longitude.toFixed(4);
    }, function () {}, { timeout: 8000 });
  }
  document.querySelectorAll('.file-drop').forEach(function (drop) {
    var input = drop.querySelector('input[type=file]');
    var text = drop.querySelector('.fd-text');
    var show = function () {
      if (!input.files.length) return;
      text.textContent = Array.from(input.files).map(function (f) { return f.name; }).join(' · ');
    };
    input.addEventListener('change', show);
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('drag'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); } });
  });

  // ---- leave form: remote / in-person only for training courses and workshops ----
  var lt = document.getElementById('leave-type');
  if (lt) {
    var mw = document.getElementById('mode-wrap');
    var syncMode = function () {
      var on = lt.value === 'training' || lt.value === 'workshop';
      mw.classList.toggle('hidden', !on);
      mw.querySelectorAll('input').forEach(function (i) { i.required = on; if (!on) i.checked = false; });
    };
    lt.addEventListener('change', syncMode); syncMode();
  }

  // ---- crew & fleet live summary (leader, members, vehicles, seats) ----
  var woForm = document.getElementById('wo-form');
  if (woForm && document.getElementById('crew-panel')) {
    var leaderSel = document.getElementById('team-leader');
    var updateCrew = function () {
      var members = Array.from(woForm.querySelectorAll('input[name=participant_ids]:checked')).map(function (i) { return i.value; });
      var people = new Set(members); if (leaderSel.value) people.add(leaderSel.value);
      var vs = Array.from(woForm.querySelectorAll('#vehicle-pick input:checked'));
      var seats = vs.reduce(function (a, v) { return a + Number(v.dataset.seats || 0); }, 0);
      var types = {}; vs.forEach(function (v) { types[v.dataset.vtype] = (types[v.dataset.vtype] || 0) + 1; });
      document.getElementById('crew-leader').textContent = leaderSel.value ? leaderSel.options[leaderSel.selectedIndex].text.split(' (')[0] : '—';
      document.getElementById('crew-people').textContent = people.size;
      document.getElementById('crew-vehicles').textContent = vs.length;
      document.getElementById('crew-types').textContent = Object.keys(types).map(function (k) { return types[k] + '× ' + k; }).join(' · ') + (vs.length ? ' — ' + vs.map(function (v) { return v.dataset.plate; }).join(', ') : '');
      document.getElementById('crew-seats').textContent = seats;
      var msg = document.getElementById('crew-msg');
      if (!people.size) { msg.innerHTML = ''; return; }
      var cls = !vs.length ? 'flash-warning' : seats < people.size ? 'flash-error' : 'flash-success';
      var text = !vs.length ? woForm.dataset.msgNone : seats < people.size ? woForm.dataset.msgShort.replace('{n}', people.size - seats) : woForm.dataset.msgOk;
      msg.innerHTML = '<div class="flash ' + cls + '" style="margin:0"></div>';
      msg.firstChild.textContent = text;
    };
    woForm.addEventListener('change', updateCrew); updateCrew();
  }

  // ---- new work order form helpers ----
  var assetPick = document.getElementById('asset-pick');
  if (assetPick) assetPick.addEventListener('input', function () {
    var opt = document.querySelector('#assets option[value="' + CSS.escape(assetPick.value) + '"]');
    document.getElementById('asset_id').value = opt ? opt.dataset.id : '';
    if (opt && opt.dataset.kv) document.getElementById('voltage').value = opt.dataset.kv;
  });
  var resFields = document.getElementById('res-fields');
  if (resFields) {
    var sync = function () {
      var yes = document.querySelector('input[name=materials_withdrawn]:checked');
      var on = !!yes && yes.value === 'yes';
      resFields.classList.toggle('hidden', !on);
      resFields.querySelector('input[name=reservation_number]').required = on;
    };
    document.querySelectorAll('input[name=materials_withdrawn]').forEach(function (r) { r.addEventListener('change', sync); }); sync();
  }
  // Travel question: band + distance only when the job involves travel; the band keeps the distance honest
  var tf = document.getElementById('travel-fields');
  if (tf) {
    var syncTravel = function () {
      var yes = document.querySelector('input[name=involves_travel]:checked');
      var on = !!yes && yes.value === 'yes';
      tf.classList.toggle('hidden', !on);
      tf.querySelectorAll('input[name=travel_band]').forEach(function (i) { i.required = on; });
      document.getElementById('distance').required = on;
      var band = document.querySelector('input[name=travel_band]:checked');
      var d = document.getElementById('distance');
      d.min = band && band.value === 'over_200' ? 200.1 : on ? 100 : 0;
      d.max = band && band.value === 'over_100' ? 200 : '';
    };
    document.querySelectorAll('input[name=involves_travel], input[name=travel_band]').forEach(function (r) { r.addEventListener('change', syncTravel); });
    syncTravel();
  }
  var dist = document.getElementById('distance');
  if (dist) {
    var cat = document.getElementById('dist-cat');
    var show = function () {
      var v = Number(dist.value) || 0;
      cat.textContent = v < 100 ? (rtl ? 'أقل من 100 كم' : '< 100 km') : v <= 200 ? (rtl ? 'من 100 إلى 200 كم' : '100–200 km') : (rtl ? 'أكثر من 200 كم' : '> 200 km');
      cat.className = 'pill ' + (v < 100 ? 'info' : v <= 200 ? 'warn' : 'bad');
    };
    dist.addEventListener('input', show); show();
  }
  document.querySelectorAll('.picker-filter').forEach(function (inp) {
    var box = document.getElementById(inp.dataset.target);
    inp.addEventListener('input', function () {
      var q = inp.value.toLowerCase();
      box.querySelectorAll('label').forEach(function (l) { l.style.display = l.dataset.text.toLowerCase().indexOf(q) >= 0 ? '' : 'none'; });
    });
  });

  // ---- submit buttons: prevent double submit, show progress ----
  document.querySelectorAll('form').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      var b = e.submitter;
      if (!b || f.method.toLowerCase() !== 'post') return;
      // Disable after the browser has captured the form data (incl. the clicked button)
      setTimeout(function () { b.disabled = true; b.setAttribute('aria-busy', 'true'); }, 0);
    });
  });

  // ---- critical response countdown ----
  document.querySelectorAll('.countdown').forEach(function (el) {
    var due = Date.parse(el.dataset.due);
    var tick = function () {
      var s = Math.round((due - Date.now()) / 1000), neg = s < 0; s = Math.abs(s);
      el.textContent = (neg ? '−' : '') + Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm';
    };
    tick(); setInterval(tick, 30000);
  });

  // ---- live alert badge (polls every 30 s) + browser notification ----
  var badge = document.getElementById('unread');
  if (badge) {
    var last = Number(badge.textContent) || 0;
    if (window.Notification && Notification.permission === 'default') {
      document.addEventListener('click', function ask() { Notification.requestPermission(); document.removeEventListener('click', ask); });
    }
    setInterval(function () {
      if (document.hidden) return;
      fetch('/api/unread', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) return;
        badge.textContent = d.unread; badge.classList.toggle('hidden', !d.unread);
        if (d.unread > last && d.latest && window.Notification && Notification.permission === 'granted') {
          var n = new Notification(d.latest.title); n.onclick = function () { location.href = '/notifications/' + d.latest.id; };
        }
        last = d.unread;
      }).catch(function () {});
    }, 30000);
  }
})();

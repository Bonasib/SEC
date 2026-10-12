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
  // Tile rows (summary numbers, follow-ups): choose a column count that leaves no tile alone on the last row
  var balance = function (n, max) {
    if (n <= max) return n;
    var best = max, empty = 99;
    for (var c = max; c >= 2; c--) { var e = n % c ? c - n % c : 0; if (e < empty) { empty = e; best = c; } }
    return best;
  };
  document.querySelectorAll('.kpis, .att-list, .ev-tiles').forEach(function (g) {
    var n = Array.prototype.filter.call(g.children, function (c) { return getComputedStyle(c).display !== 'none'; }).length;
    if (!n) return;
    var att = g.classList.contains('att-list'), ev = g.classList.contains('ev-tiles');
    g.style.setProperty('--cols', balance(n, att ? 3 : ev ? 6 : 6));
    g.style.setProperty('--cols-mid', balance(n, att ? 2 : 4));
  });

  // "/" anywhere (outside a field) jumps to the global search
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    var el = document.activeElement, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
    var box = document.querySelector('[data-search-key]');
    e.preventDefault();
    if (box && box.offsetParent) box.focus(); else location.href = '/search';
  });

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

  // ---- photo inputs: preview the chosen image ----
  document.querySelectorAll('input[type=file][data-preview]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var box = document.getElementById(inp.dataset.preview), f = inp.files && inp.files[0];
      if (!box || !f || !/^image\//.test(f.type)) return;
      var img = document.createElement('img'); img.alt = '';
      img.src = URL.createObjectURL(f);
      box.textContent = ''; box.appendChild(img);
    });
  });

  // ---- confirmation on specific buttons (the form has other buttons) ----
  document.querySelectorAll('button[data-confirm-click]').forEach(function (b) {
    b.addEventListener('click', function (e) { if (!window.confirm(b.dataset.confirmClick)) e.preventDefault(); });
  });

  // ---- confirmation before destructive actions ----
  document.querySelectorAll('form[data-confirm]').forEach(function (f) {
    f.addEventListener('submit', function (e) {
      if (!window.confirm(f.dataset.confirm)) { e.preventDefault(); e.stopImmediatePropagation(); }
    });
  });

  // ---- materials / tools picker rows (item + quantity) ----
  document.querySelectorAll('[data-item-picker]').forEach(function (box) {
    var list = box.querySelector('.item-rows');
    var tpl = box.querySelector('template');
    var wire = function (row) {
      var sel = row.querySelector('select'), qty = row.querySelector('input'), uom = row.querySelector('.item-uom');
      var sync = function () {
        var o = sel.options[sel.selectedIndex];
        uom.textContent = o && o.value ? o.dataset.uom : '';
        qty.max = o && o.value ? o.dataset.avail : '';
        qty.required = !!(o && o.value);
        if (o && o.value && !qty.value) qty.value = 1;
      };
      sel.addEventListener('change', sync); sync();
      row.querySelector('[data-remove-row]').addEventListener('click', function () {
        if (list.children.length > 1) row.remove(); else { sel.value = ''; qty.value = ''; sync(); }
      });
    };
    Array.from(list.children).forEach(wire);
    box.querySelector('[data-add-row]').addEventListener('click', function () {
      var row = tpl.content.firstElementChild.cloneNode(true);
      list.appendChild(row); wire(row); row.querySelector('select').focus();
    });
  });

  // ---- inventory picker: search, filter by kind, selected-only, live count ----
  document.querySelectorAll('[data-item-grid]').forEach(function (g) {
    var rows = Array.from(g.querySelectorAll('.ig-row'));
    var search = g.querySelector('[data-ig-search]'), only = g.querySelector('[data-ig-only]'), count = g.querySelector('[data-ig-count]');
    var kind = '';
    var qtyOf = function (r) { var i = r.querySelector('input[type=number]'); return Number(i.value) || 0; };
    var apply = function () {
      var q = (search.value || '').trim().toLowerCase(), n = 0;
      rows.forEach(function (r) {
        var picked = qtyOf(r) > 0; if (picked) n++;
        r.classList.toggle('picked', picked);
        r.hidden = !((!kind || r.dataset.kind === kind) && (!q || r.dataset.text.indexOf(q) >= 0) && (!only.checked || picked));
      });
      count.textContent = n + ' ' + (rtl ? 'صنف محدد' : 'selected');
    };
    g.querySelectorAll('[data-ig-kind]').forEach(function (b) {
      b.addEventListener('click', function () { kind = b.dataset.igKind; g.querySelectorAll('[data-ig-kind]').forEach(function (x) { x.classList.toggle('on', x === b); }); apply(); });
    });
    search.addEventListener('input', apply); only.addEventListener('change', apply);
    g.addEventListener('input', function (e) { if (e.target.type === 'number') apply(); });
    apply();
  });

  // ---- material line: fill number / description / unit from the catalog ----
  document.querySelectorAll('[data-catalog-fill]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var o = sel.options[sel.selectedIndex], f = sel.form;
      if (!o || !o.value) return;
      f.material_number.value = o.dataset.code; f.description.value = o.dataset.name; f.uom.value = o.dataset.uom;
    });
  });

  // ---- daily tasks: select all, send mode, recipient helpers, copy text ----
  document.querySelectorAll('[data-check-all]').forEach(function (box) {
    var form = box.form || box.closest('form') || document;
    var items = function () { return Array.from(form.querySelectorAll('input[name="' + box.dataset.checkAll + '"]:not(:disabled)')); };
    box.addEventListener('change', function () { items().forEach(function (i) { if (!i.closest('tr') || !i.closest('tr').hidden) i.checked = box.checked; }); });
  });
  var modePanel = document.querySelector('[data-mode-panel]');
  if (modePanel) {
    var hint = document.querySelector('[data-mode-hint]');
    var syncMode2 = function () {
      var m = document.querySelector('input[name=mode]:checked');
      var sel = !!m && m.value === 'selected';
      modePanel.classList.toggle('hidden', !sel);
      if (hint) hint.classList.toggle('hidden', sel);
    };
    document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', syncMode2); });
    syncMode2();
  }
  document.querySelectorAll('[data-pick-all]').forEach(function (b) {
    b.addEventListener('click', function () { document.querySelectorAll('#' + b.dataset.pickAll + ' label').forEach(function (l) { if (l.style.display !== 'none') l.querySelector('input').checked = true; }); });
  });
  document.querySelectorAll('[data-pick-none]').forEach(function (b) {
    b.addEventListener('click', function () { document.querySelectorAll('#' + b.dataset.pickNone + ' input').forEach(function (i) { i.checked = false; }); });
  });
  document.querySelectorAll('[data-pick-section]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      if (!sel.value) return;
      document.querySelectorAll('#recipient-picker label[data-section="' + sel.value + '"] input').forEach(function (i) { i.checked = true; });
      sel.value = '';
    });
  });
  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var done = function () { var old = b.innerHTML; b.textContent = '✓'; setTimeout(function () { b.innerHTML = old; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done, function () {});
    });
  });

  // ---- every table: click a column to sort, type to filter rows ----
  var TXT = rtl ? { filter: 'تصفية الصفوف…', of: 'من', sort: 'ترتيب حسب' } : { filter: 'Filter rows…', of: 'of', sort: 'Sort by' };
  var findUsed = false; // ?find= from the global search fills the first table's filter
  var collator = new Intl.Collator(root.lang || undefined, { numeric: true, sensitivity: 'base' });
  var cellValue = function (row, i) {
    var c = row.cells[i];
    if (!c) return '';
    return (c.dataset.sortValue != null ? c.dataset.sortValue : c.textContent).trim();
  };
  var asNumber = function (v) {
    var s = v.replace(/[,\s%٬]/g, '').replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); });
    return /^[-+−]?\d*\.?\d+$/.test(s) ? parseFloat(s.replace('−', '-')) : null;
  };
  document.querySelectorAll('table.tbl').forEach(function (tbl, ti) {
    if (tbl.hasAttribute('data-nosort') || tbl.classList.contains('kv-table')) return;
    var head = tbl.tHead && tbl.tHead.rows[0];
    if (!head) {
      var first = tbl.rows[0];
      if (!first || !Array.prototype.every.call(first.cells, function (c) { return c.tagName === 'TH'; })) return;
      head = first;
    }
    var dataRows = function () {
      return Array.prototype.filter.call(tbl.rows, function (r) {
        return r !== head && r.parentNode.tagName !== 'THEAD' && r.parentNode.tagName !== 'TFOOT' && !(r.cells.length === 1 && r.cells[0].colSpan > 1);
      });
    };
    var rows = dataRows();
    if (!rows.length) return;
    // Quick filter for longer tables
    var find = !findUsed && new URLSearchParams(location.search).get('find');
    if ((rows.length >= 6 || find) && !tbl.hasAttribute('data-nofilter')) {
      var bar = document.createElement('div');
      bar.className = 'table-tools';
      bar.innerHTML = '<label class="search-field"><svg class="ic" aria-hidden="true"><use href="#i-search"/></svg><input type="search" placeholder="' + TXT.filter + '" aria-label="' + TXT.filter + '"></label><span class="muted small" aria-live="polite"></span>';
      var anchor = tbl.closest('.table-wrap') || tbl;
      anchor.parentNode.insertBefore(bar, anchor);
      var input = bar.querySelector('input'), count = bar.querySelector('span');
      var apply = function () {
        var q = input.value.trim().toLowerCase(), shown = 0, all = dataRows();
        all.forEach(function (r) { var ok = !q || r.textContent.toLowerCase().indexOf(q) >= 0; r.hidden = !ok; if (ok) shown++; });
        count.textContent = q ? shown + ' ' + TXT.of + ' ' + all.length : all.length;
      };
      if (find) { input.value = find; findUsed = true; }
      input.addEventListener('input', apply); apply();
    }
    if (rows.length < 2 || tbl.hasAttribute('data-server-sort')) return;
    Array.prototype.forEach.call(head.cells, function (th, ci) {
      var label = th.textContent.trim();
      if (!label || th.colSpan > 1 || th.querySelector('a, input, button, select')) return;
      th.classList.add('sortable');
      th.setAttribute('aria-sort', 'none');
      var btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'th-sort'; btn.title = TXT.sort + ': ' + label;
      while (th.firstChild) btn.appendChild(th.firstChild);
      btn.insertAdjacentHTML('beforeend', '<svg class="ic sort-ic" aria-hidden="true"><use href="#i-sort"/></svg>');
      th.appendChild(btn);
      btn.addEventListener('click', function () {
        var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
        Array.prototype.forEach.call(head.cells, function (o) { if (o.classList.contains('sortable')) o.setAttribute('aria-sort', 'none'); });
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        var list = dataRows(), parent = list[0].parentNode;
        var nums = list.map(function (r) { return asNumber(cellValue(r, ci)); });
        var numeric = nums.every(function (n, k) { return n !== null || cellValue(list[k], ci) === '' || cellValue(list[k], ci) === '—'; }) && nums.some(function (n) { return n !== null; });
        list.map(function (r, k) { return { r: r, v: cellValue(r, ci), n: nums[k] }; })
          .sort(function (a, b) {
            var ea = a.v === '' || a.v === '—', eb = b.v === '' || b.v === '—';
            if (ea !== eb) return ea ? 1 : -1;
            return dir * (numeric ? (a.n || 0) - (b.n || 0) : collator.compare(a.v, b.v));
          })
          .forEach(function (x) { parent.appendChild(x.r); });
      });
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

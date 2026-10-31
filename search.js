/* Reflect Route Planner — Find accounts

   Searches the accounts stored in Supabase the way the route lists in
   this project have always been built: pick an anchor, draw a tight
   radius, then narrow by specialty and by the licence level of whoever
   is on staff. Results go straight into the planner as stops.

   Chains are excluded by default — they buy at corporate.

   The BOTOX Cosmetic directory is not reachable from the browser (cross
   origin, and the listings are rendered by script), so it will be added
   later as a second source behind these same filters. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    anchor: null,            /* {label, lat, lng} */
    all: [],                 /* every candidate owned by this rep */
    results: [],
    excl: []                 /* chain name patterns */
  };

  /* ---------------- helpers ---------------- */

  function miles(a, b) {
    var R = 3958.8, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var la = a.lat * toR, lb = b.lat * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.asin(Math.sqrt(h));
  }

  function fullAddress(c) {
    return [[c.street, c.suite].filter(Boolean).join(' '), c.city, c.state, c.zip]
      .filter(Boolean).join(', ');
  }

  function note(text, kind) {
    var el = $('findMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'note' + (kind ? ' ' + kind : '');
  }

  function db() { return window.RP_DB; }
  function me() { return window.RP_AUTH && window.RP_AUTH.user; }

  /* ---------------- anchor ---------------- */

  /* Accepts a street address, city, ZIP, or a county name. Nominatim
     handles all four; a county resolves to its centroid, which is a wide
     net, so the UI warns when the match is not a street address. */
  function geocodeAnchor(text) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=' +
              encodeURIComponent(text);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.length) throw new Error('not found');
        var hit = j[0], ad = hit.address || {};
        return {
          label: hit.display_name,
          lat: parseFloat(hit.lat),
          lng: parseFloat(hit.lon),
          precise: !!(ad.house_number && ad.road)
        };
      });
  }

  function useMyLocation() {
    if (!navigator.geolocation) { note('This browser cannot share a location.', 'err'); return; }
    note('Getting your location…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      S.anchor = { label: 'Current location', lat: pos.coords.latitude, lng: pos.coords.longitude, precise: true };
      $('findAnchor').value = 'Current location';
      note('Anchored on your current location.', 'ok');
      run();
    }, function () { note('Could not get your location. Type an address instead.', 'err'); },
    { enableHighAccuracy: true, timeout: 10000 });
  }

  /* ---------------- data ---------------- */

  function loadAll() {
    if (!db() || !me()) return Promise.resolve();
    return db().from('candidates')
      .select('id,name,street,suite,city,state,zip,phone,website,source,specialty,cert_tier,clinicians,hours,lat,lng,is_chain,status')
      .eq('status', 'active')
      .then(function (res) {
        S.all = (res && res.data) ? res.data : [];
        return db().from('exclusions').select('name_pattern');
      })
      .then(function (res) {
        S.excl = ((res && res.data) || []).map(function (r) {
          return (r.name_pattern || '').toLowerCase();
        }).filter(Boolean);
      });
  }

  function looksLikeChain(c) {
    if (c.is_chain) return true;
    var n = (c.name || '').toLowerCase();
    for (var i = 0; i < S.excl.length; i++) {
      if (n.indexOf(S.excl[i]) >= 0) return true;
    }
    return false;
  }

  function openOn(c, day) {
    var h = c.hours || {};
    var iv = h[day];
    return Array.isArray(iv) && iv.length > 0;
  }

  /* ---------------- search ---------------- */

  function run() {
    if (!S.anchor) { note('Set a starting point first.', 'err'); return; }

    var radius = parseFloat($('findRadius').value) || 5;
    var minTier = $('findTier').value ? parseInt($('findTier').value, 10) : null;
    var day = $('findDay').value;
    var mustBeOpen = $('findOpen').checked;
    var hideChains = $('findChains').checked;
    var wantSpec = Array.prototype.slice
      .call(document.querySelectorAll('#findSpecs input:checked'))
      .map(function (i) { return i.value; });

    var out = [];
    S.all.forEach(function (c) {
      if (typeof c.lat !== 'number' || typeof c.lng !== 'number') return;
      var d = miles(S.anchor, c);
      if (d > radius) return;
      if (hideChains && looksLikeChain(c)) return;
      if (minTier && (!c.cert_tier || c.cert_tier < minTier)) return;
      if (mustBeOpen && !openOn(c, day)) return;
      if (wantSpec.length) {
        var tags = c.specialty || [];
        var hit = wantSpec.some(function (w) { return tags.indexOf(w) >= 0; });
        if (!hit) return;
      }
      c._d = d;
      out.push(c);
    });

    out.sort(function (a, b) { return a._d - b._d; });
    S.results = out;
    render();
  }

  function render() {
    var body = $('findBody');
    var wrap = $('findResults');
    var empty = $('findEmpty');
    body.textContent = '';

    if (!S.results.length) {
      wrap.classList.add('hide');
      empty.classList.remove('hide');
      empty.textContent = S.all.length
        ? 'Nothing inside that radius. Widen it, or loosen the filters.'
        : 'No accounts loaded yet. Use "Load brand lists" below.';
      return;
    }
    empty.classList.add('hide');
    wrap.classList.remove('hide');

    var TIER = { 1: 'Esthetician', 2: 'RN', 3: 'NP / PA-C', 4: 'MD / DO' };

    S.results.forEach(function (c) {
      var tr = document.createElement('tr');

      function cell(text, cls) {
        var td = document.createElement('td');
        td.textContent = text == null ? '' : String(text);
        if (cls) td.className = cls;
        return td;
      }

      var pick = document.createElement('td');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.setAttribute('data-id', c.id);
      pick.appendChild(cb);
      tr.appendChild(pick);

      tr.appendChild(cell(c._d.toFixed(1)));
      tr.appendChild(cell(c.name));
      tr.appendChild(cell(fullAddress(c)));
      tr.appendChild(cell((c.specialty || []).join(', ')));
      tr.appendChild(cell(c.cert_tier ? TIER[c.cert_tier] : 'unverified',
                          c.cert_tier ? '' : 'muted'));
      tr.appendChild(cell(c.phone));
      body.appendChild(tr);
    });

    $('findCount').textContent = S.results.length +
      (S.results.length === 1 ? ' account' : ' accounts') + ' found';
  }

  function sendToPlanner() {
    var picked = {};
    Array.prototype.slice.call(document.querySelectorAll('#findBody input:checked'))
      .forEach(function (cb) { picked[cb.getAttribute('data-id')] = true; });

    var rows = S.results.filter(function (c) { return picked[c.id]; }).map(function (c) {
      return {
        name: c.name, address: fullAddress(c), phone: c.phone || '',
        lat: c.lat, lng: c.lng
      };
    });
    if (!rows.length) { note('Tick at least one account.', 'err'); return; }

    var n = window.RP_APP.addStops(rows);
    window.RP_APP.toast(n + ' stop' + (n === 1 ? '' : 's') + ' added. Set your start and end, then Plan route.', 'ok');
    window.RP_APP.showTab('stops');
  }

  /* ---------------- brand-list loader ---------------- */

  /* The brand JSON files carry name/address/phone/website/brand and, for
     most rows, coordinates already resolved. Specialty is inferred from
     the business name as a starting point — it is editable afterwards,
     and nothing here claims a clinician was verified. */
  function inferSpecialty(name) {
    var n = (name || '').toLowerCase(), out = [];
    if (/derm/.test(n)) out.push('Dermatology');
    if (/plastic surg/.test(n)) out.push('Plastic surgery');
    if (/facial plastic|facial aesthet/.test(n)) out.push('Facial plastics');
    if (/cosmetic surg/.test(n)) out.push('Cosmetic surgery');
    if (/ob.?gyn|midwif|women/.test(n)) out.push('OB/GYN');
    if (/dental|dentist/.test(n)) out.push('Dentistry');
    if (/ent\b|sinus/.test(n)) out.push('ENT');
    if (!out.length && /med ?spa|medspa|aesthet|skin|laser|beauty|glow|rejuven/.test(n)) out.push('Med spa');
    return out;
  }

  function importBrandFile(file) {
    var user = me();
    if (!user) { note('Sign in first.', 'err'); return; }

    var fr = new FileReader();
    fr.onload = function () {
      var rows;
      try { rows = JSON.parse(fr.result); } catch (e) { note('That file is not valid JSON.', 'err'); return; }
      if (!Array.isArray(rows)) { note('Expected a list of accounts.', 'err'); return; }

      var seen = {};
      S.all.forEach(function (c) { seen[(c.name || '').toLowerCase() + '|' + (c.zip || '')] = true; });

      var batch = [];
      rows.forEach(function (r) {
        var name = r.Name || r.name;
        if (!name) return;
        var zip = String(r.Zip || r.zip || '').slice(0, 5);
        if (seen[name.toLowerCase() + '|' + zip]) return;
        seen[name.toLowerCase() + '|' + zip] = true;

        var la = parseFloat(r.lat), ln = parseFloat(r.lng);
        batch.push({
          owner_id: user.id,
          name: name,
          street: r.Address || r.address || null,
          city: r.City || r.city || null,
          state: r.State || r.state || null,
          zip: zip || null,
          phone: (r.Phone || r.phone || '').trim() || null,
          website: r.Website || r.website || null,
          source: (r.Brand || r.brand || 'Brand list') + ' list',
          specialty: inferSpecialty(name),
          lat: isFinite(la) ? la : null,
          lng: isFinite(ln) ? ln : null,
          geocode_quality: isFinite(la) ? 'from_list' : null
        });
      });

      if (!batch.length) { note('Nothing new in that file — all of it is already loaded.', 'ok'); return; }

      note('Loading ' + batch.length + ' accounts…');
      var chunks = [], i;
      for (i = 0; i < batch.length; i += 100) chunks.push(batch.slice(i, i + 100));

      chunks.reduce(function (p, chunk) {
        return p.then(function () { return db().from('candidates').insert(chunk); });
      }, Promise.resolve())
        .then(function () { return loadAll(); })
        .then(function () {
          note('Loaded ' + batch.length + ' accounts. ' + S.all.length + ' total.', 'ok');
          if (S.anchor) run(); else render();
        })
        .catch(function (e) {
          note('Load failed: ' + ((e && e.message) || 'unknown error'), 'err');
        });
    };
    fr.readAsText(file);
  }

  /* ---------------- wiring ---------------- */

  function boot() {
    if (!$('tab-find')) return;

    $('btnFindLocate').addEventListener('click', useMyLocation);

    $('btnFindSearch').addEventListener('click', function () {
      var text = ($('findAnchor').value || '').trim();
      if (!text) { note('Type an address, city, ZIP or county.', 'err'); return; }
      if (S.anchor && S.anchor.label === text) { run(); return; }
      note('Looking up that location…');
      geocodeAnchor(text).then(function (a) {
        S.anchor = a;
        note(a.precise ? 'Anchored on ' + a.label
                       : 'Matched a wide area — ' + a.label + '. A town or street address gives a tighter cluster.',
             a.precise ? 'ok' : 'warn');
        run();
      }).catch(function () { note('Could not find that location.', 'err'); });
    });

    $('btnFindAdd').addEventListener('click', sendToPlanner);

    $('btnFindAll').addEventListener('click', function () {
      var boxes = document.querySelectorAll('#findBody input[type=checkbox]');
      var anyOff = Array.prototype.slice.call(boxes).some(function (b) { return !b.checked; });
      Array.prototype.slice.call(boxes).forEach(function (b) { b.checked = anyOff; });
    });

    $('btnBrandBrowse').addEventListener('click', function () { $('brandFile').click(); });
    $('brandFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importBrandFile(f);
      e.target.value = '';
    });

    ['findRadius', 'findTier', 'findDay', 'findOpen', 'findChains'].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener('change', function () { if (S.anchor) run(); });
    });

    window.RP_AUTH.ready(function (user) {
      if (!user) return;
      loadAll().then(function () {
        var n = S.all.length;
        note(n ? n + ' accounts available to search.' : 'No accounts loaded yet — use "Load brand lists" below.');
        render();
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

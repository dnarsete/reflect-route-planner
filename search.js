/* Reflect Route Planner — Find

   One flow: say where you are looking and what you want, pick which
   sources to look in, press the button. Saved accounts and anything read
   off the websites you listed come back in a single list, deduplicated,
   ready to drop into a route.

   The settings in step 1 drive every source - they are not a separate
   filter that happens to sit above the site list. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    anchor: null,     /* {label, lat, lng, precise} */
    all: [],          /* saved candidates */
    excl: [],         /* chain name patterns */
    results: []       /* what is on screen: {row, isNew, dist, sources, conflicts, flagged} */
  };

  var TIER = { 1: 'Esthetician', 2: 'RN', 3: 'NP / PA-C', 4: 'MD / DO' };

  /* ---------------- helpers ---------------- */

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  function miles(a, b) {
    var R = 3958.8, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var la = a.lat * toR, lb = b.lat * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.asin(Math.sqrt(h));
  }

  function fullAddress(c) {
    return [[c.street, c.suite && ('Ste ' + c.suite)].filter(Boolean).join(' '),
            c.city, c.state, c.zip].filter(Boolean).join(', ');
  }

  function msg(text, kind) {
    var el = $('findMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'note' + (kind ? ' ' + kind : '');
  }

  function db() { return window.RP_DB; }
  function me() { return window.RP_AUTH && window.RP_AUTH.user; }

  /* ---------------- anchor ---------------- */

  function geocodeAnchor(text) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=' +
              encodeURIComponent(text);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.length) throw new Error('not found');
        var hit = j[0], ad = hit.address || {};
        return {
          label: hit.display_name, lat: parseFloat(hit.lat), lng: parseFloat(hit.lon),
          precise: !!(ad.house_number && ad.road)
        };
      });
  }

  function ensureAnchor() {
    var text = clean($('findAnchor').value);
    if (!text) return Promise.reject(new Error('Type where you want to search, or use your current location.'));
    if (S.anchor && S.anchor.label === text) return Promise.resolve(S.anchor);
    return geocodeAnchor(text).then(function (a) {
      a.label = text;
      S.anchor = a;
      return a;
    }).catch(function () { throw new Error('Could not find "' + text + '".'); });
  }

  function useMyLocation() {
    if (!navigator.geolocation) { msg('This browser cannot share a location.', 'err'); return; }
    msg('Getting your location…');
    navigator.geolocation.getCurrentPosition(function (pos) {
      S.anchor = { label: 'Current location', lat: pos.coords.latitude, lng: pos.coords.longitude, precise: true };
      $('findAnchor').value = 'Current location';
      msg('Anchored on your current location.', 'ok');
    }, function () { msg('Could not get your location. Type an address instead.', 'err'); },
    { enableHighAccuracy: true, timeout: 10000 });
  }

  /* ---------------- saved accounts ---------------- */

  function loadAll() {
    if (!db() || !me()) return Promise.resolve();
    return db().from('candidates')
      .select('id,name,street,suite,city,state,zip,phone,website,source,specialty,cert_tier,clinicians,hours,lat,lng,is_chain,status')
      .eq('status', 'active')
      .then(function (res) {
        S.all = (res && res.data) ? res.data : [];
        $('savedCount').textContent = '(' + S.all.length + ')';
        return db().from('exclusions').select('name_pattern');
      })
      .then(function (res) {
        S.excl = ((res && res.data) || []).map(function (r) {
          return (r.name_pattern || '').toLowerCase();
        }).filter(Boolean);
      });
  }

  function isChain(c) {
    if (c.is_chain) return true;
    var n = (c.name || '').toLowerCase();
    for (var i = 0; i < S.excl.length; i++) if (n.indexOf(S.excl[i]) >= 0) return true;
    return false;
  }

  function params() {
    return {
      radius: parseFloat($('findRadius').value) || 5,
      minTier: $('findTier').value ? parseInt($('findTier').value, 10) : null,
      day: $('findDay').value,
      mustBeOpen: $('findOpen').checked,
      hideChains: $('findChains').checked,
      specs: Array.prototype.slice.call(document.querySelectorAll('#findSpecs input:checked'))
                  .map(function (i) { return i.value; })
    };
  }

  /* Applied to saved accounts and to anything read off a website alike. */
  function passes(c, p, dist) {
    if (p.hideChains && isChain(c)) return false;
    if (p.minTier && (!c.cert_tier || c.cert_tier < p.minTier)) return false;
    if (p.mustBeOpen) {
      var iv = (c.hours || {})[p.day];
      if (!Array.isArray(iv) || !iv.length) return false;
    }
    if (p.specs.length) {
      var tags = c.specialty || [];
      if (!p.specs.some(function (w) { return tags.indexOf(w) >= 0; })) return false;
    }
    if (dist != null && dist > p.radius) return false;
    return true;
  }

  /* ---------------- geocoding what came off the sites ---------------- */

  /* A row read off a web page has no coordinates, so the radius could not
     be applied to it - which would leave the settings in step 1 only half
     connected. Look each one up, and insist on a house number: a result
     that falls back to a town centre is worse than no result, because it
     lands the stop in the middle of a city and quietly bends the route. */
  function geocodeRow(r) {
    /* A street with no town or ZIP is not enough to place a pin. Asking
       anyway returns the nearest road of that name, which is how a stop
       ends up miles from the real address and silently bends the route.
       Better to show no distance than a confident wrong one. */
    if (!r.street || (!r.city && !r.zip)) return Promise.resolve(false);
    /* Leave the suite out: "10881 West Asbury Ave Ste 200, Lakewood, CO"
       finds nothing, the same line without the suite resolves exactly. */
    var q = [r.street, r.city, r.state, r.zip].filter(Boolean).join(', ');
    var url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=' +
              encodeURIComponent(q);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (x) { return x.json(); })
      .then(function (j) {
        if (!j || !j.length) return false;
        var ad = j[0].address || {};
        if (!ad.house_number || !ad.road) return false;      /* centroid - refuse it */
        r.lat = parseFloat(j[0].lat);
        r.lng = parseFloat(j[0].lon);
        r.geocode_quality = 'house_number';
        return true;
      })
      .catch(function () { return false; });
  }

  /* Nominatim asks for no more than one call a second. */
  function geocodeAll(rows, onProgress) {
    var i = 0;
    function next() {
      if (i >= rows.length) return Promise.resolve();
      var r = rows[i++];
      if (onProgress) onProgress(i, rows.length);
      return geocodeRow(r).then(function () {
        return new Promise(function (go) { setTimeout(go, 1100); }).then(next);
      });
    }
    return next();
  }

  /* ---------------- the one button ---------------- */

  function runSearch() {
    var btn = $('btnFindSearch');
    var jobs = $('useSaved') && window.RP_SITES ? window.RP_SITES.gather() : [];
    var wantSaved = $('useSaved').checked;

    if (!wantSaved && !jobs.length) {
      msg('Tick your saved accounts, or add a website to search.', 'err'); return;
    }

    btn.disabled = true;
    msg('Looking up that location…');

    ensureAnchor().then(function (a) {
      if (!a.precise) {
        msg('Matched a wide area — ' + a.label + '. A town or street address gives a tighter cluster.', 'warn');
      }
      if (!jobs.length) return { sets: [], notes: [] };
      msg('Reading ' + jobs.length + ' site' + (jobs.length === 1 ? '' : 's') + '…');
      return window.RP_SITES.fetchAll(jobs, function (d, n) { msg('Read ' + d + ' of ' + n + ' sites…'); });
    }).then(function (fetched) {
      var p = params(), out = [];
      var pendingGeo = [], mergedSets = null, notes = fetched.notes;

      if (wantSaved) {
        S.all.forEach(function (c) {
          if (typeof c.lat !== 'number' || typeof c.lng !== 'number') return;
          var d = miles(S.anchor, c);
          if (!passes(c, p, d)) return;
          out.push({ row: c, isNew: false, dist: d, sources: [c.source || 'saved'], conflicts: [], flagged: '' });
        });
      }

      if (fetched.sets.length) {
        var merged = window.RP_SITES.crossReference(fetched.sets, wantSaved ? S.all : []);
        pendingGeo = merged.filter(function (m) {
          return !m.match && typeof m.row.lat !== 'number' && (m.row.street || m.row.zip);
        }).map(function (m) { return m.row; });
        mergedSets = merged;
      }

      return { p: p, out: out, merged: mergedSets, geo: pendingGeo, notes: notes };
    }).then(function (stage) {
      if (!stage) return;
      var p = stage.p, out = stage.out, notes = stage.notes || [];

      return (stage.geo.length
        ? (msg('Locating ' + stage.geo.length + ' new address' + (stage.geo.length === 1 ? '' : 'es') + '…'),
           geocodeAll(stage.geo, function (d, n) { msg('Locating ' + d + ' of ' + n + '…'); }))
        : Promise.resolve()
      ).then(function () {
        (stage.merged || []).forEach(function (m) {
          if (m.match) return;                        /* already saved - the saved copy is listed */
          var d = (typeof m.row.lat === 'number') ? miles(S.anchor, m.row) : null;
          if (!passes(m.row, p, d)) return;
          out.push({
            row: m.row, isNew: true, dist: d,
            sources: m.sources, conflicts: m.conflicts || [], flagged: m.flagged || ''
          });
        });

      out.sort(function (a, b) {
        if (a.dist == null) return 1;
        if (b.dist == null) return -1;
        return a.dist - b.dist;
      });
      S.results = out;
      render();

      var nNew = out.filter(function (x) { return x.isNew; }).length;
      var parts = [out.length + (out.length === 1 ? ' account' : ' accounts')];
      if (nNew) parts.push(nNew + ' new from websites');
      if (notes.length) parts.push(notes.join(' · '));
        msg(parts.join(' — '), notes.length ? 'warn' : 'ok');
      });
    }).catch(function (e) {
      msg((e && e.message) || 'Something went wrong.', 'err');
    }).then(function () { btn.disabled = false; });
  }

  /* ---------------- results ---------------- */

  function render() {
    var body = $('findBody'), wrap = $('findResults'), empty = $('findEmpty');
    body.textContent = '';

    if (!S.results.length) {
      wrap.classList.add('hide');
      empty.classList.remove('hide');
      empty.textContent = S.all.length
        ? 'Nothing matched. Widen the radius, or loosen the filters.'
        : 'No saved accounts yet — load a brand list, or add a website above.';
      return;
    }
    empty.classList.add('hide');
    wrap.classList.remove('hide');

    S.results.forEach(function (r, idx) {
      var tr = document.createElement('tr');
      if (r.isNew) tr.className = 'row-new';

      function td(content, cls) {
        var c = document.createElement('td');
        if (content && content.nodeType) c.appendChild(content);
        else c.textContent = content == null ? '' : String(content);
        if (cls) c.className = cls;
        tr.appendChild(c);
        return c;
      }

      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true;
      cb.setAttribute('data-idx', String(idx));
      td(cb);

      td(r.dist == null ? '—' : r.dist.toFixed(1));

      /* names read off a web page land wrong sometimes - fix them here */
      if (r.isNew) {
        var inp = document.createElement('input');
        inp.className = 'name-edit';
        inp.value = r.row.name || '';
        inp.addEventListener('change', function () { r.row.name = clean(inp.value); });
        td(inp);
      } else {
        td(r.row.name);
      }

      td(fullAddress(r.row));
      td(r.row.cert_tier ? TIER[r.row.cert_tier] : 'unverified', r.row.cert_tier ? '' : 'muted');
      td(r.row.phone || '');
      td((r.isNew ? r.sources.length + '× ' : '') + r.sources.join(', '), 'muted');

      var notes = [];
      if (r.isNew) notes.push('new');
      if (r.flagged) notes.push(r.flagged);
      (r.conflicts || []).forEach(function (c) { notes.push(c.field + ': "' + c.a + '" vs "' + c.b + '"'); });
      td(notes.join(' — '), notes.length > 1 ? 'warn-text' : 'muted');

      body.appendChild(tr);
    });

    $('findCount').textContent = S.results.length +
      (S.results.length === 1 ? ' account found' : ' accounts found');
  }

  /* Ticked rows go to the planner. Anything found on a website is saved
     to the account list on the way through, so the work is not lost. */
  function addToRoute() {
    var picked = [];
    Array.prototype.slice.call(document.querySelectorAll('#findBody input:checked'))
      .forEach(function (cb) { picked.push(S.results[parseInt(cb.getAttribute('data-idx'), 10)]); });

    if (!picked.length) { msg('Tick at least one account.', 'err'); return; }

    var fresh = picked.filter(function (r) { return r.isNew; });
    var user = me();

    var step = (fresh.length && user && db())
      ? db().from('candidates').insert(fresh.map(function (r) {
          return {
            owner_id: user.id, name: r.row.name,
            street: r.row.street || null, suite: r.row.suite || null,
            city: r.row.city || null, state: r.row.state || null, zip: r.row.zip || null,
            phone: r.row.phone || null,
            specialty: r.row.specialty || [],
            lat: (typeof r.row.lat === 'number') ? r.row.lat : null,
            lng: (typeof r.row.lng === 'number') ? r.row.lng : null,
            source: r.sources.join(' + ')
          };
        }))
      : Promise.resolve();

    step.then(function () {
      var n = window.RP_APP.addStops(picked.map(function (r) {
        return {
          name: r.row.name, address: fullAddress(r.row), phone: r.row.phone || '',
          lat: r.row.lat, lng: r.row.lng
        };
      }));
      window.RP_APP.toast(n + ' stop' + (n === 1 ? '' : 's') + ' added. Set your start and end, then Plan route.', 'ok');
      if (fresh.length) loadAll();
      window.RP_APP.showTab('stops');
    }).catch(function (e) {
      msg('Could not save the new accounts: ' + ((e && e.message) || 'unknown error'), 'err');
    });
  }

  /* ---------------- wiring ---------------- */

  function boot() {
    if (!$('tab-find')) return;

    $('btnFindLocate').addEventListener('click', useMyLocation);
    $('btnFindSearch').addEventListener('click', runSearch);
    $('btnFindAdd').addEventListener('click', addToRoute);

    $('btnFindAll').addEventListener('click', function () {
      var boxes = document.querySelectorAll('#findBody input[type=checkbox]');
      var anyOff = Array.prototype.slice.call(boxes).some(function (b) { return !b.checked; });
      Array.prototype.slice.call(boxes).forEach(function (b) { b.checked = anyOff; });
    });

    $('findAnchor').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
    });

    window.RP_FIND = {
      all: function () { return S.all; },
      reload: function () { return loadAll().then(render); }
    };

    window.RP_AUTH.ready(function (user) {
      if (!user) return;
      loadAll().then(function () {
        if (!S.all.length) msg('No accounts saved yet — load a brand list, or add a website to search.');
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

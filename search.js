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
  var READER_PROXY = 'https://r.jina.ai/';

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
  /* Two sources, strongest first.

     The US Census geocoder has authoritative street-level data for US
     addresses and only answers when it matches a real one - it never
     falls back to a town centre, which is the failure that puts a stop
     miles from where it belongs. OpenStreetMap is thinner on suburban
     commercial addresses: of ten read off a directory, five had no house
     number in OSM and all five resolved exactly through the Census.

     Census blocks cross-origin calls, so it goes through the same reader
     the websites use. */
  var CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
               '?benchmark=Public_AR_Current&format=json&address=';

  function viaCensus(q) {
    return fetch(READER_PROXY + CENSUS + encodeURIComponent(q))
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var m = t.match(/"x"\s*:\s*(-?[\d.]+)\s*,\s*"y"\s*:\s*([\d.-]+)/);
        if (!m) return null;
        return { lat: parseFloat(m[2]), lng: parseFloat(m[1]) };
      })
      .catch(function () { return null; });
  }

  function viaOSM(q) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=' +
              encodeURIComponent(q);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (x) { return x.json(); })
      .then(function (j) {
        if (!j || !j.length) return null;
        var ad = j[0].address || {};
        if (!ad.house_number || !ad.road) return null;   /* a centroid, not an address */
        return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
      })
      .catch(function () { return null; });
  }

  var jsonpN = 0;

  /* The Census geocoder answers JSONP, which sidesteps the cross-origin
     rule without a proxy. */
  function jsonp(url) {
    return new Promise(function (resolve, reject) {
      var cb = '__rpGeo' + (++jsonpN);
      var sc = document.createElement('script');
      var settled = false;

      function cleanup() {
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        if (sc.parentNode) sc.parentNode.removeChild(sc);
      }
      window[cb] = function (data) { settled = true; cleanup(); resolve(data); };
      sc.onerror = function () { if (!settled) { cleanup(); reject(new Error('lookup failed')); } };
      sc.src = url + '&callback=' + cb;
      document.head.appendChild(sc);
      setTimeout(function () { if (!settled) { cleanup(); reject(new Error('timed out')); } }, 12000);
    });
  }

  /* Census first: it is the authoritative US address file and it either
     matches a real street address or returns nothing, so there is no
     centroid to guard against. OpenStreetMap is missing house numbers for
     a lot of suburban commercial addresses - 8775 E Orchard Rd and 5889 S
     Greenwood Plaza Blvd are both absent from it and both exact here. */
  function geocodeCensus(q) {
    var url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress' +
              '?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(q);
    return jsonp(url).then(function (d) {
      var m = d && d.result && d.result.addressMatches;
      if (!m || !m.length) return null;
      var c = m[0].coordinates;
      return { lat: c.y, lng: c.x, quality: 'census' };
    }).catch(function () { return null; });
  }

  /* Fallback, with the house-number guard: a result without one is a road
     or town centroid, which puts the stop in the wrong place entirely. */
  function geocodeOSM(q) {
    var url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=' +
              encodeURIComponent(q);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (x) { return x.json(); })
      .then(function (j) {
        if (!j || !j.length) return null;
        var ad = j[0].address || {};
        if (!ad.house_number || !ad.road) return null;
        return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), quality: 'house_number' };
      })
      .catch(function () { return null; });
  }

  function geocodeRow(r) {
    /* A street with no town or ZIP is not enough to place a pin. Asking
       anyway returns the nearest road of that name, which is how a stop
       ends up miles from the real address and quietly bends the route. */
    if (!r.street || (!r.city && !r.zip)) return Promise.resolve(false);

    /* Leave the suite out - "10881 West Asbury Ave Ste 200, Lakewood, CO"
       finds nothing, the same line without it resolves exactly. */
    var q = [r.street, r.city, r.state, r.zip].filter(Boolean).join(', ');

    return geocodeCensus(q).then(function (hit) {
      return hit || geocodeOSM(q);
    }).then(function (hit) {
      if (!hit) return false;
      r.lat = hit.lat; r.lng = hit.lng; r.geocode_quality = hit.quality;
      return true;
    });
  }

  /* Census needs no throttle; OpenStreetMap asks for one call a second. */
  function geocodeAll(rows, onProgress) {
    var i = 0;
    function next() {
      if (i >= rows.length) return Promise.resolve();
      var r = rows[i++];
      if (onProgress) onProgress(i, rows.length);
      return geocodeRow(r).then(function () {
        return new Promise(function (go) { setTimeout(go, 250); }).then(next);
      });
    }
    return next();
  }

  /* ---------------- brand directories ---------------- */

  /* Prollenium's locator answers only a cross-origin POST, which a page
     cannot make, so it goes through the reader function. The anchor and
     radius are handed straight to it - the same ones that build the BOTOX
     search URL. */
  function fetchProllenium(anchorPt, radius) {
    var cfg = window.RP_CONFIG || {};
    if (!cfg.FETCH_FN) return Promise.resolve(null);

    return fetch(cfg.FETCH_FN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': cfg.SUPABASE_KEY,
        'Authorization': 'Bearer ' + cfg.SUPABASE_KEY
      },
      body: JSON.stringify({
        prollenium: { lat: anchorPt.lat, lng: anchorPt.lng, radius: radius }
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var hit = ((d && d.results) || []).filter(function (x) { return x.url === 'prollenium'; })[0];
        if (!hit) return null;
        if (!hit.ok || !hit.rows.length) {
          return { error: hit.error || 'Prollenium returned nothing.' };
        }
        return { source: 'Prollenium directory', rows: hit.rows };
      })
      .catch(function (e) {
        return { error: 'Prollenium: ' + ((e && e.message) || 'could not be reached') };
      });
  }

  /* ---------------- the one button ---------------- */

  function runSearch() {
    var btn = $('btnFindSearch');
    /* the anchor text drives the directories' own search URLs */
    var jobs = window.RP_SITES
      ? window.RP_SITES.gather({ location: clean($('findAnchor').value),
                                 radius: parseFloat($('findRadius').value) || 5 })
      : [];
    var wantSaved = $('useSaved').checked;

    var wantPro = $('useProllenium') && $('useProllenium').checked;
    if (!wantSaved && !jobs.length && !wantPro) {
      msg('Pick somewhere to look — your saved accounts, Prollenium, or a website.', 'err'); return;
    }

    btn.disabled = true;
    msg('Looking up that location…');

    ensureAnchor().then(function (a) {
      if (!a.precise) {
        msg('Matched a wide area — ' + a.label + '. A town or street address gives a tighter cluster.', 'warn');
      }
      var radius = parseFloat($('findRadius').value) || 5;
      var wantPro = $('useProllenium') && $('useProllenium').checked;

      var siteWork = jobs.length
        ? (msg('Reading ' + jobs.length + ' site' + (jobs.length === 1 ? '' : 's') + '…'),
           window.RP_SITES.fetchAll(jobs, function (d, n) { msg('Read ' + d + ' of ' + n + ' sites…'); }))
        : Promise.resolve({ sets: [], notes: [] });

      var proWork = wantPro ? fetchProllenium(a, radius) : Promise.resolve(null);

      return Promise.all([siteWork, proWork]).then(function (both) {
        var out = both[0];
        var pro = both[1];
        if (pro && pro.rows) out.sets.push(pro);
        else if (pro && pro.error) out.notes.push(pro.error);
        return out;
      });
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
      var dayCap = parseInt($('findMaxStops').value, 10) || 15;
      var parts = [out.length + (out.length === 1 ? ' account' : ' accounts')];
      if (out.length > dayCap) parts.push('a route takes the ' + dayCap + ' closest');
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

  /* Ticked rows become the day. Anything found on a website is saved to
     the account list on the way through, so a site only has to be read
     once - and then the route is planned outright, because step 1 already
     knows where you are starting and when. */
  function buildRoute() {
    var picked = [];
    Array.prototype.slice.call(document.querySelectorAll('#findBody input:checked'))
      .forEach(function (cb) { picked.push(S.results[parseInt(cb.getAttribute('data-idx'), 10)]); });

    if (!picked.length) { msg('Tick at least one account.', 'err'); return; }

    var endMode = $('findEndMode').value;
    var endAddr = clean($('findEndAddr').value);
    if (endMode === 'custom' && !endAddr) {
      msg('Type where the day should end, or switch back to "Back where I started".', 'err');
      return;
    }

    /* A search can turn up a hundred accounts; a day holds about fifteen.
       Results are sorted by distance, so keeping the first N keeps the
       tight cluster these routes are built on rather than a sprawl. */
    var cap = parseInt($('findMaxStops').value, 10) || 15;
    var trimmed = 0;
    if (picked.length > cap) {
      trimmed = picked.length - cap;
      picked = picked.slice(0, cap);
    }

    var fresh = picked.filter(function (r) { return r.isNew; });
    var user = me();

    msg((trimmed ? 'Taking the ' + cap + ' closest — ' + trimmed + ' further out left off. ' : '') +
        (fresh.length ? 'Saving ' + fresh.length + ' new account' + (fresh.length === 1 ? '' : 's') + '…' : 'Building the route…'));

    var save = (fresh.length && user && db())
      ? db().from('candidates').insert(fresh.map(function (r) {
          return {
            owner_id: user.id, name: r.row.name,
            street: r.row.street || null, suite: r.row.suite || null,
            city: r.row.city || null, state: r.row.state || null, zip: r.row.zip || null,
            phone: r.row.phone || null,
            specialty: r.row.specialty || [],
            lat: (typeof r.row.lat === 'number') ? r.row.lat : null,
            lng: (typeof r.row.lng === 'number') ? r.row.lng : null,
            geocode_quality: r.row.geocode_quality || null,
            source: r.sources.join(' + ')
          };
        }))
      : Promise.resolve();

    save.catch(function () { /* a save failure must not cost you the route */ })
      .then(function () {
        window.RP_APP.setStops(picked.map(function (r) {
          return {
            name: r.row.name, address: fullAddress(r.row), phone: r.row.phone || '',
            lat: r.row.lat, lng: r.row.lng
          };
        }));
        if (fresh.length) loadAll();
        msg('');
        window.RP_APP.planWith({
          startAddr: clean($('findAnchor').value) || 'Current location',
          startLat: S.anchor ? S.anchor.lat : null,
          startLng: S.anchor ? S.anchor.lng : null,
          startTime: $('findStartTime').value || '09:00',
          roundTrip: endMode === 'start',
          endAddr: endMode === 'custom' ? endAddr : ''
        });
      });
  }

  /* ---------------- excel ---------------- */

  /* The found list, in the shape the route sheets have always taken, with
     the search that produced it written across the top so the file still
     makes sense a month later. */
  function exportFound() {
    if (!S.results.length) { msg('Nothing to export yet.', 'err'); return; }
    if (typeof XLSX === 'undefined') { msg('Spreadsheet library did not load. Reload the page.', 'err'); return; }

    var p = params();
    var specs = p.specs.length ? p.specs.join(', ') : 'any';
    var tier = p.minTier ? TIER[p.minTier] + ' or above' : 'any, including unverified';

    var aoa = [
      ['Accounts found — ' + (S.anchor ? S.anchor.label : '')],
      ['Within', p.radius + ' miles', '', 'Specialty', specs],
      ['Minimum licence', tier, '', 'Chains', p.hideChains ? 'excluded' : 'included'],
      ['Day', $('findDay').value, '', 'Open that day only', p.mustBeOpen ? 'yes' : 'no'],
      [],
      ['#', 'Account', 'Address', 'Suite', 'City', 'State', 'Zip', 'Phone',
       'Specialty', 'Licence', 'Source', 'Miles', 'Located', 'Notes']
    ];

    S.results.forEach(function (r, i) {
      var c = r.row;
      var notes = [];
      if (r.isNew) notes.push('new');
      if (r.flagged) notes.push(r.flagged);
      (r.conflicts || []).forEach(function (x) {
        notes.push(x.field + ': "' + x.a + '" vs "' + x.b + '"');
      });
      aoa.push([
        i + 1, c.name || '', c.street || '', c.suite || '', c.city || '', c.state || '',
        c.zip || '', c.phone || '',
        (c.specialty || []).join(', '),
        c.cert_tier ? TIER[c.cert_tier] : 'unverified',
        r.sources.join(' + '),
        r.dist == null ? '' : +r.dist.toFixed(1),
        c.geocode_quality || (typeof c.lat === 'number' ? 'yes' : 'not located'),
        notes.join(' — ')
      ]);
    });

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 4 }, { wch: 34 }, { wch: 30 }, { wch: 8 }, { wch: 18 }, { wch: 6 },
                   { wch: 7 }, { wch: 15 }, { wch: 22 }, { wch: 14 }, { wch: 26 }, { wch: 7 },
                   { wch: 13 }, { wch: 40 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Accounts found');

    var d = new Date();
    var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    var where = (S.anchor && S.anchor.label ? S.anchor.label : 'search').split(',')[0].replace(/[^A-Za-z0-9 ]/g, '');
    XLSX.writeFile(wb, 'Accounts found ' + where + ' ' + stamp + '.xlsx');
    msg('Downloaded ' + S.results.length + ' accounts.', 'ok');
  }

  /* ---------------- excel ---------------- */

  /* The ticked accounts as a spreadsheet, in the column order these route
     lists have always used. Chains are already excluded upstream; this is
     what you would hand a rep. */
  function exportExcel() {
    var picked = [];
    Array.prototype.slice.call(document.querySelectorAll('#findBody input:checked'))
      .forEach(function (cb) { picked.push(S.results[parseInt(cb.getAttribute('data-idx'), 10)]); });
    if (!picked.length) { msg('Tick at least one account to export.', 'err'); return; }

    var p = params();
    var rows = picked.map(function (r, i) {
      var c = r.row;
      return {
        '#': i + 1,
        'Account': c.name || '',
        'Address': [c.street, c.suite && ('Ste ' + c.suite)].filter(Boolean).join(' '),
        'City': c.city || '',
        'State': c.state || '',
        'Zip': c.zip || '',
        'Phone': c.phone || '',
        'Licensed clinician': c.clinicians || '',
        'Licence': c.cert_tier ? TIER[c.cert_tier] : 'unverified',
        'Specialty': (c.specialty || []).join(', '),
        'Miles from anchor': r.dist == null ? '' : Number(r.dist.toFixed(1)),
        'Website': c.website || '',
        'Came from': r.sources.join(', ')
      };
    });

    var ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 4 }, { wch: 34 }, { wch: 28 }, { wch: 16 }, { wch: 6 }, { wch: 7 },
                   { wch: 14 }, { wch: 30 }, { wch: 13 }, { wch: 18 }, { wch: 9 },
                   { wch: 28 }, { wch: 22 }];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Accounts');

    /* what the list was built from, so a sheet is self-explaining later */
    var about = [
      ['Searched around', S.anchor ? S.anchor.label : ''],
      ['Within', p.radius + ' miles'],
      ['Minimum licence', p.minTier ? TIER[p.minTier] + ' or above' : 'any, including unverified'],
      ['Specialty', p.specs.length ? p.specs.join(', ') : 'any'],
      ['Day', $('findDay').options[$('findDay').selectedIndex].text],
      ['National chains', p.hideChains ? 'excluded' : 'included'],
      ['Accounts', String(rows.length)],
      ['Built', new Date().toLocaleString()]
    ];
    var ws2 = XLSX.utils.aoa_to_sheet([['Search', 'Setting']].concat(about));
    ws2['!cols'] = [{ wch: 22 }, { wch: 44 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'How this was built');

    var where = (S.anchor && S.anchor.label ? S.anchor.label : 'accounts')
      .split(',')[0].replace(/[^A-Za-z0-9 ]/g, '').trim() || 'accounts';
    var d = new Date();
    var stamp = d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');

    XLSX.writeFile(wb, where + ' accounts ' + stamp + '.xlsx');
    msg('Exported ' + rows.length + ' accounts.', 'ok');
  }

  /* ---------------- wiring ---------------- */

  function boot() {
    if (!$('tab-find')) return;

    $('btnFindLocate').addEventListener('click', useMyLocation);
    $('btnFindSearch').addEventListener('click', runSearch);
    $('btnFindAdd').addEventListener('click', buildRoute);
    $('btnFindExport').addEventListener('click', exportExcel);
    $('btnFindExcel').addEventListener('click', exportFound);

    $('findEndMode').addEventListener('change', function () {
      $('findEndWrap').classList.toggle('hide', this.value !== 'custom');
    });

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

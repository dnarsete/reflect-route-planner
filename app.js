/* Reflect Route Planner
   Standalone, no build step. Plans a multi-stop sales day:
   spreadsheet in -> optimized, time-blocked itinerary out -> handoff to
   Google Maps / Waze / Apple Maps for live-traffic navigation. */
(function () {
  'use strict';

  /* ============================ helpers ============================ */
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var uid = function () { return 's' + Math.random().toString(36).slice(2, 9); };

  function parseTime(str) {                       // "08:30" -> 510
    if (!str) return null;
    var m = /^(\d{1,2}):(\d{2})/.exec(String(str).trim());
    if (!m) return null;
    return (+m[1]) * 60 + (+m[2]);
  }
  function fmtTime(min) {                          // 510 -> "8:30 AM"
    if (min == null) return '--';
    min = Math.round(min);
    var d = Math.floor(min / 1440); min -= d * 1440;
    var h = Math.floor(min / 60), m = min % 60;
    var ap = h < 12 ? 'AM' : 'PM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + (m < 10 ? '0' : '') + m + ' ' + ap + (d > 0 ? ' +' + d + 'd' : '');
  }
  function fmtMins(min) {                          // 84 -> "1h 24m"
    min = Math.round(min);
    if (min < 60) return min + 'm';
    var h = Math.floor(min / 60), m = min % 60;
    return h + 'h' + (m ? ' ' + m + 'm' : '');
  }
  var miles = function (meters) { return meters / 1609.344; };

  function toast(msg, kind, ms) {
    var t = $('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.className = kind || '';
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.style.display = 'none'; }, ms || 3200);
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ============================ state ============================ */
  var LS = 'reflect_route_planner_v1';
  var LS_GEO = 'reflect_route_geocache_v1';

  var state = {
    settings: {
      startAddr: '', startLat: null, startLng: null,
      endAddr: '', endLat: null, endLng: null,
      roundTrip: true, startTime: '08:00', dayEnd: '',
      visitMin: 30, bufMin: 15, bufMax: 60, lunchMin: 0,
      lockOrder: false, gKey: ''
    },
    stops: [],
    route: null
  };
  var geoCache = {};

  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({ settings: state.settings, stops: state.stops }));
    } catch (e) { /* quota / private mode - not fatal */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(LS);
      if (raw) {
        var d = JSON.parse(raw);
        if (d.settings) Object.keys(d.settings).forEach(function (k) {
          if (k in state.settings) state.settings[k] = d.settings[k];
        });
        if (Array.isArray(d.stops)) state.stops = d.stops;
      }
      var g = localStorage.getItem(LS_GEO);
      if (g) geoCache = JSON.parse(g) || {};
    } catch (e) { geoCache = {}; }
  }
  function saveGeo() {
    try { localStorage.setItem(LS_GEO, JSON.stringify(geoCache)); } catch (e) {}
  }

  /* ============================ tabs ============================ */
  function showTab(name) {
    ['stops', 'route', 'map', 'help'].forEach(function (t) {
      var el = $('tab-' + t);
      if (el) el.classList.toggle('hide', t !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    if (name === 'map') fitMap();
    window.scrollTo(0, 0);
  }

  /* ============================ settings binding ============================ */
  var SETTING_FIELDS = [
    ['startAddr', 'startAddr', 'value'], ['endAddr', 'endAddr', 'value'],
    ['startTime', 'startTime', 'value'], ['dayEnd', 'dayEnd', 'value'],
    ['visitMin', 'visitMin', 'number'], ['bufMin', 'bufMin', 'number'],
    ['bufMax', 'bufMax', 'number'], ['lunchMin', 'lunchMin', 'number'],
    ['roundTrip', 'roundTrip', 'checked'], ['lockOrder', 'lockOrder', 'checked'],
    ['gKey', 'gKey', 'value']
  ];
  function settingsToForm() {
    SETTING_FIELDS.forEach(function (f) {
      var el = $(f[0]); if (!el) return;
      if (f[2] === 'checked') el.checked = !!state.settings[f[1]];
      else el.value = state.settings[f[1]];
    });
    $('endWrap').classList.toggle('hide', !!state.settings.roundTrip);
  }
  function formToSettings() {
    SETTING_FIELDS.forEach(function (f) {
      var el = $(f[0]); if (!el) return;
      if (f[2] === 'checked') state.settings[f[1]] = el.checked;
      else if (f[2] === 'number') state.settings[f[1]] = Number(el.value) || 0;
      else state.settings[f[1]] = el.value;
    });
    if (state.settings.bufMax < state.settings.bufMin) state.settings.bufMax = state.settings.bufMin;
    save();
  }

  /* ============================ spreadsheet import ============================ */
  var pendingRows = null, pendingHeaders = null, pendingName = '', lastBatch = null;
  var pendingSheets = null;   // every sheet in the uploaded workbook

  var COL_HINTS = {
    name:    ['name', 'account', 'company', 'customer', 'client', 'business', 'contact', 'location', 'store'],
    address: ['address', 'street', 'addr', 'address1', 'address 1', 'street address', 'location'],
    city:    ['city', 'town'],
    state:   ['state', 'province', 'st'],
    zip:     ['zip', 'zipcode', 'zip code', 'postal', 'postal code'],
    phone:   ['phone', 'telephone', 'tel', 'mobile', 'cell', 'phone number'],
    minutes: ['minutes', 'min', 'duration', 'time needed', 'length', 'visit'],
    time:    ['time', 'appointment', 'appt', 'fixed time', 'scheduled'],
    notes:   ['notes', 'note', 'comment', 'comments', 'detail', 'details'],
    lat:     ['lat', 'latitude'],
    lng:     ['lng', 'long', 'longitude', 'lon']
  };

  function guessColumn(headers, key) {
    var hints = COL_HINTS[key], lower = headers.map(function (h) { return String(h).toLowerCase().trim(); });
    var i, j;
    for (j = 0; j < hints.length; j++) for (i = 0; i < lower.length; i++) if (lower[i] === hints[j]) return headers[i];
    for (j = 0; j < hints.length; j++) for (i = 0; i < lower.length; i++) if (lower[i].indexOf(hints[j]) !== -1) return headers[i];
    return '';
  }

  /* Real spreadsheets often carry a title row, a blank row, or a logo above the
     column names, so the header row is detected rather than assumed to be row 1.
     The winning row is the one with the most cells that look like column names. */
  function sheetToRows(ws) {
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    var best = -1, bestScore = -1, i;

    for (i = 0; i < Math.min(aoa.length, 15); i++) {
      var cells = (aoa[i] || []).filter(function (c) { return String(c).trim() !== ''; });
      if (cells.length < 2) continue;
      var lower = cells.map(function (c) { return String(c).toLowerCase().trim(); });
      var score = cells.length;
      Object.keys(COL_HINTS).forEach(function (key) {
        var hit = lower.some(function (c) {
          return COL_HINTS[key].some(function (h) { return c === h || c.indexOf(h) !== -1; });
        });
        if (hit) score += 3;
      });
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return { headers: [], rows: [] };

    var headers = [], seen = {};
    aoa[best].forEach(function (h, idx) {
      var name = String(h).trim() || ('Column ' + (idx + 1));
      if (seen[name]) { seen[name]++; name = name + ' (' + seen[name] + ')'; }
      else seen[name] = 1;
      headers.push(name);
    });

    var rows = [];
    for (i = best + 1; i < aoa.length; i++) {
      var row = aoa[i] || [];
      if (!row.some(function (c) { return String(c).trim() !== ''; })) continue;
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = row[idx] == null ? '' : row[idx]; });
      rows.push(obj);
    }
    return { headers: headers, rows: rows };
  }

  function fileStatus(msg, kind, offerRemap) {
    $('fileStatusWrap').classList.remove('hide');
    $('fileStatus').innerHTML = '<span class="pill ' + (kind || '') + '">' + esc(msg) + '</span>';
    $('btnRemap').classList.toggle('hide', !offerRemap);
  }

  function readFile(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var cantRead = {
      numbers: 'Numbers files can\u2019t be read here. In Numbers: File \u203a Export To \u203a Excel, then upload the .xlsx.',
      pages:   'That\u2019s a Pages document, not a spreadsheet.',
      pdf:     'That\u2019s a PDF, not a spreadsheet.',
      docx:    'That\u2019s a Word document, not a spreadsheet.',
      doc:     'That\u2019s a Word document, not a spreadsheet.'
    };
    if (cantRead[ext]) { fileStatus(cantRead[ext], 'err'); toast(cantRead[ext], 'err', 6000); return; }

    var reader = new FileReader();
    pendingName = file.name;
    fileStatus('Reading ' + file.name + '\u2026');

    reader.onerror = function () {
      fileStatus("Couldn't open " + file.name + '. Try re-saving it as .xlsx.', 'err');
      toast("Couldn't open that file.", 'err', 5000);
      $('file').value = '';
    };
    reader.onload = function (e) {
      $('file').value = '';   // safe now: the bytes are already read
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        if (!wb.SheetNames.length) {
          fileStatus('That file has no sheets in it.', 'err');
          toast('That file has no sheets in it.', 'err'); return;
        }
        // A workbook often carries a cover sheet, a totals tab, or notes
        // alongside the data. Parse them all and pick the one that actually
        // looks like a stop list; the rest stay available in a dropdown.
        pendingSheets = wb.SheetNames.map(function (nm) {
          var pr = sheetToRows(wb.Sheets[nm]);
          var addr = pr.headers.length ? guessColumn(pr.headers, 'address') : '';
          var zip = pr.headers.length ? guessColumn(pr.headers, 'zip') : '';
          return {
            name: nm, headers: pr.headers, rows: pr.rows,
            // Row count deliberately does NOT feed the score: when two sheets
            // both look like stop lists, the one the author put first wins.
            score: (addr ? 10000 : 0) + (zip ? 5000 : 0) + (pr.rows.length ? 1 : 0)
          };
        });
        var usable = pendingSheets.filter(function (x) { return x.rows.length; });
        if (!usable.length) {
          fileStatus('No rows of data found in that workbook.', 'err');
          toast('No rows of data found in that workbook.', 'err', 5000);
          return;
        }
        var best = usable.slice().sort(function (a, b) { return b.score - a.score; })[0];
        renderSheetPicker(best.name);
        var parsed = { headers: best.headers, rows: best.rows };
        pendingRows = parsed.rows;
        pendingHeaders = parsed.headers;

        // If the address column is obvious, import on the spot. Making the user
        // find and press a second button after choosing a file is the single
        // easiest way for this to look broken when it isn't.
        if (guessColumn(pendingHeaders, 'address') ||
            (guessColumn(pendingHeaders, 'city') && guessColumn(pendingHeaders, 'zip'))) {
          doImport(true);
        } else {
          renderColumnMapper();
          fileStatus(parsed.rows.length + ' rows read from ' + file.name +
                     ' \u2014 tell it which column holds the address, then Import.', 'warn');
          toast("Read the file, but couldn't spot an address column.", 'err', 5000);
        }
      } catch (err) {
        fileStatus("Couldn't read that file: " + err.message, 'err');
        toast("Couldn't read that file: " + err.message, 'err', 6000);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderSheetPicker(selected) {
    var wrap = $('sheetPickWrap');
    if (!pendingSheets || pendingSheets.length < 2) { wrap.classList.add('hide'); return; }
    $('sheetPick').innerHTML = pendingSheets.map(function (sh) {
      return '<option value="' + esc(sh.name) + '"' + (sh.name === selected ? ' selected' : '') + '>' +
             esc(sh.name) + ' (' + sh.rows.length + ' rows)</option>';
    }).join('');
    wrap.classList.remove('hide');
  }

  function useSheet(name) {
    var sh = null;
    (pendingSheets || []).forEach(function (x) { if (x.name === name) sh = x; });
    if (!sh) return;
    pendingHeaders = sh.headers;
    pendingRows = sh.rows;
    if (guessColumn(pendingHeaders, 'address') ||
        (guessColumn(pendingHeaders, 'city') && guessColumn(pendingHeaders, 'zip'))) {
      doImport(true);
    } else {
      renderColumnMapper();
      fileStatus("Sheet '" + name + "' has " + sh.rows.length +
                 ' rows - tell it which column holds the address, then Import.', 'warn');
    }
  }

  function renderColumnMapper() {
    var keys = ['name', 'address', 'city', 'state', 'zip', 'phone', 'minutes', 'time',
                'notes', 'lat', 'lng'];
    var labels = {
      name: 'Name', address: 'Address', city: 'City', state: 'State', zip: 'Zip',
      phone: 'Phone', minutes: 'Minutes at stop', time: 'Fixed time', notes: 'Notes',
      lat: 'Latitude (optional)', lng: 'Longitude (optional)'
    };
    $('mapColsGrid').innerHTML = keys.map(function (k) {
      var guess = guessColumn(pendingHeaders, k);
      var opts = ['<option value="">&mdash; none &mdash;</option>'].concat(
        pendingHeaders.map(function (h) {
          return '<option value="' + esc(h) + '"' + (h === guess ? ' selected' : '') + '>' + esc(h) + '</option>';
        })
      ).join('');
      return '<div><label>' + labels[k] + '</label><select data-col="' + k + '">' + opts + '</select></div>';
    }).join('');
    $('mapCols').classList.remove('hide');
    setTimeout(function () {
      $('mapCols').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  function doImport(auto) {
    var pick = {};
    if (auto) {
      ['name', 'address', 'city', 'state', 'zip', 'phone', 'minutes', 'time', 'notes',
       'lat', 'lng'].forEach(function (k) { pick[k] = guessColumn(pendingHeaders, k); });
    } else {
      Array.prototype.forEach.call($('mapColsGrid').querySelectorAll('select'), function (s) {
        pick[s.dataset.col] = s.value;
      });
    }
    if (!pick.address && !pick.city && !pick.zip) {
      toast('Pick at least an address column.', 'err'); return;
    }
    // Re-importing the same file replaces its stops rather than doubling them.
    if (lastBatch) {
      state.stops = state.stops.filter(function (x) { return x.batch !== lastBatch; });
    }
    var batch = uid();
    var added = 0, skipped = 0, preLocated = 0;
    pendingRows.forEach(function (r) {
      var get = function (k) { return pick[k] ? String(r[pick[k]] || '').trim() : ''; };
      var parts = [get('address'), get('city'), [get('state'), get('zip')].filter(Boolean).join(' ')];
      var addr = parts.filter(Boolean).join(', ');
      if (!addr) { skipped++; return; }
      var mins = parseInt(get('minutes'), 10);
      // A sheet that already carries coordinates skips geocoding entirely -
      // no rate limit, no failed lookups on messy suite numbers.
      var la = parseFloat(get('lat')), ln = parseFloat(get('lng'));
      var haveCoords = isFinite(la) && isFinite(ln) &&
                       la >= -90 && la <= 90 && ln >= -180 && ln <= 180 &&
                       !(la === 0 && ln === 0);
      state.stops.push({
        id: uid(), batch: batch,
        name: get('name') || addr,
        address: addr,
        phone: get('phone'),
        notes: get('notes'),
        minutes: isFinite(mins) && mins > 0 ? mins : null,
        fixed: normalizeTimeCell(get('time')),
        lat: haveCoords ? la : null,
        lng: haveCoords ? ln : null,
        geo: haveCoords ? 'ok' : 'pending'
      });
      if (haveCoords) preLocated++;
      added++;
    });
    lastBatch = batch;
    $('mapCols').classList.add('hide');
    save(); renderStops();

    if (!added) {
      fileStatus('No usable addresses in ' + pendingName +
                 ' \u2014 check which column is mapped to Address.', 'err', true);
      toast('No usable addresses found.', 'err', 5000);
      renderColumnMapper();
      return;
    }
    fileStatus(added + ' stops imported from ' + pendingName +
               (skipped ? ' (' + skipped + ' rows had no address)' : '') +
               (preLocated === added ? ' \u2014 coordinates already in the sheet, nothing to look up.'
                                     : ' \u2014 looking up addresses\u2026'), 'ok', true);
    toast(added + ' stops imported. Looking up addresses\u2026', 'ok');
    geocodeAll();
  }

  function normalizeTimeCell(v) {
    if (!v) return '';
    v = String(v).trim();
    var m = /^(\d{1,2})\s*:\s*(\d{2})\s*(am|pm)?$/i.exec(v);
    if (m) {
      var h = +m[1], mi = +m[2], ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
    }
    // Excel serial fraction of a day (0.5 = noon)
    var n = Number(v);
    if (isFinite(n) && n > 0 && n < 1) {
      var tot = Math.round(n * 1440);
      return (Math.floor(tot / 60) < 10 ? '0' : '') + Math.floor(tot / 60) + ':' +
             (tot % 60 < 10 ? '0' : '') + (tot % 60);
    }
    return '';
  }

  function downloadTemplate() {
    var aoa = [
      ['Name', 'Address', 'City', 'State', 'Zip', 'Phone', 'Minutes', 'Time', 'Notes'],
      ['Cherry Creek Med Spa', '2500 E 1st Ave', 'Denver', 'CO', '80206', '303-555-0142', 45, '', 'Reorder + new display'],
      ['Boulder Aesthetics', '1136 Pearl St', 'Boulder', 'CO', '80302', '303-555-0177', 30, '11:00', 'Owner only available at 11'],
      ['LoDo Skin Studio', '1550 Wewatta St', 'Denver', 'CO', '80202', '720-555-0119', 30, '', '']
    ];
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 24 }, { wch: 14 }, { wch: 7 }, { wch: 8 },
                   { wch: 15 }, { wch: 9 }, { wch: 10 }, { wch: 30 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stops');
    XLSX.writeFile(wb, 'Route_Planner_Template.xlsx');
  }

  /* ============================ stops table ============================ */
  function renderStops() {
    var body = $('stopsBody');
    var has = state.stops.length > 0;
    $('stopsEmpty').classList.toggle('hide', has);
    $('stopsTable').classList.toggle('hide', !has);
    $('brandSub').textContent = has
      ? state.stops.length + ' stop' + (state.stops.length === 1 ? '' : 's') + ' loaded'
      : 'No stops loaded';
    if (!has) { body.innerHTML = ''; return; }

    body.innerHTML = state.stops.map(function (s, i) {
      var badge = s.geo === 'ok' ? '<span class="pill ok">Yes</span>'
                : s.geo === 'fail' ? '<span class="pill err">No</span>'
                : '<span class="pill warn">&mdash;</span>';
      return '<tr data-id="' + s.id + '">' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td><input data-f="name" value="' + esc(s.name) + '"></td>' +
        '<td><input data-f="address" value="' + esc(s.address) + '"></td>' +
        '<td><input data-f="phone" value="' + esc(s.phone || '') + '"></td>' +
        '<td class="w-dur"><input data-f="minutes" type="number" min="5" step="5" ' +
          'placeholder="' + state.settings.visitMin + '" value="' + (s.minutes || '') + '"></td>' +
        '<td class="w-time"><input data-f="fixed" type="time" value="' + esc(s.fixed || '') + '"></td>' +
        '<td>' + badge + '</td>' +
        '<td class="w-act"><button class="icon-btn sm danger" data-del="' + s.id + '">&times;</button></td>' +
        '</tr>';
    }).join('');
  }

  function stopById(id) {
    for (var i = 0; i < state.stops.length; i++) if (state.stops[i].id === id) return state.stops[i];
    return null;
  }

  /* ============================ geocoding ============================ */
  var NOMINATIM = 'https://nominatim.openstreetmap.org/search';

  function cacheKey(addr) { return String(addr).toLowerCase().replace(/\s+/g, ' ').trim(); }

  function geocodeOSM(addr) {
    var key = cacheKey(addr);
    if (geoCache[key]) return Promise.resolve(geoCache[key]);
    var url = NOMINATIM + '?format=jsonv2&limit=1&addressdetails=0&q=' + encodeURIComponent(addr);
    return fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('lookup failed (' + r.status + ')'); return r.json(); })
      .then(function (j) {
        if (!j || !j.length) return null;
        var hit = { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), label: j[0].display_name };
        geoCache[key] = hit; saveGeo();
        return hit;
      });
  }

  function geocodeGoogle(addr) {
    var key = cacheKey(addr);
    if (geoCache[key]) return Promise.resolve(geoCache[key]);
    return new Promise(function (resolve, reject) {
      new google.maps.Geocoder().geocode({ address: addr }, function (res, status) {
        if (status === 'OK' && res && res[0]) {
          var l = res[0].geometry.location;
          var hit = { lat: l.lat(), lng: l.lng(), label: res[0].formatted_address };
          geoCache[key] = hit; saveGeo();
          resolve(hit);
        } else if (status === 'ZERO_RESULTS') resolve(null);
        else reject(new Error('Google geocode: ' + status));
      });
    });
  }

  /* Free-text geocoders choke on "Suite 320", "Unit D4", "Bldg L" and on a
     missing comma before the city. Each failed lookup is retried against
     progressively simpler versions of the same address. */
  function addressVariants(addr) {
    var out = [addr];
    var stripped = addr
      .replace(/\b(suite|ste|unit|apt|apartment|bldg|building|floor|fl|rm|room)\s*\.?\s*[#]?\s*[\w-]+/gi, ' ')
      .replace(/#\s*[\w-]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*,\s*,+/g, ',')
      .replace(/^[\s,]+|[\s,]+$/g, '');
    if (stripped && stripped !== addr) out.push(stripped);

    // "<number> <street>, <city>, <ST> <zip>" rebuilt from the ends of the string
    var zip = /\b(\d{5})(?:-\d{4})?\b/.exec(stripped);
    var st = /\b([A-Z]{2})\b(?=[\s,]*\d{5})/.exec(stripped.toUpperCase());
    var num = /^\s*(\d+[\w-]*\s+[^,]+?)(?=,|\s+[A-Z][a-z])/.exec(stripped);
    if (zip && st && num) {
      var rebuilt = num[1].trim() + ', ' + st[1] + ' ' + zip[1];
      if (out.indexOf(rebuilt) === -1) out.push(rebuilt);
    }
    return out;
  }

  function geocode(addr) {
    var fn = useGoogle() ? geocodeGoogle : geocodeOSM;
    var variants = addressVariants(addr);
    var i = 0;
    function attempt() {
      if (i >= variants.length) return Promise.resolve(null);
      var v = variants[i++];
      return fn(v).then(function (hit) {
        if (hit) {
          if (i > 1) geoCache[cacheKey(addr)] = hit;   // remember it for the original too
          return hit;
        }
        return i < variants.length ? sleep(1100).then(attempt) : null;
      }).catch(function () {
        return i < variants.length ? sleep(1100).then(attempt) : null;
      });
    }
    return attempt();
  }

  function progress(done, total, msg) {
    $('geoProgress').classList.remove('hide');
    $('geoBar').style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    $('geoMsg').textContent = msg;
  }
  function progressDone() {
    setTimeout(function () { $('geoProgress').classList.add('hide'); }, 900);
  }

  /* Look up every stop that doesn't have coordinates yet, plus start/end. */
  function geocodeAll() {
    var todo = state.stops.filter(function (s) { return s.geo !== 'ok' && s.address; });
    var needStart = state.settings.startAddr && state.settings.startLat == null;
    var needEnd = !state.settings.roundTrip && state.settings.endAddr && state.settings.endLat == null;
    var total = todo.length + (needStart ? 1 : 0) + (needEnd ? 1 : 0);
    if (!total) { renderStops(); return Promise.resolve(); }

    var done = 0, failed = 0;
    var throttle = useGoogle() ? 60 : 1100;   // Nominatim asks for <=1 request/sec

    var chain = Promise.resolve();

    if (needStart) chain = chain.then(function () {
      progress(done, total, 'Locating your starting point...');
      return geocode(state.settings.startAddr).then(function (hit) {
        if (hit) { state.settings.startLat = hit.lat; state.settings.startLng = hit.lng; }
        else failed++;
        done++; save();
      }).then(function () { return sleep(throttle); });
    });

    if (needEnd) chain = chain.then(function () {
      progress(done, total, 'Locating your ending point...');
      return geocode(state.settings.endAddr).then(function (hit) {
        if (hit) { state.settings.endLat = hit.lat; state.settings.endLng = hit.lng; }
        else failed++;
        done++; save();
      }).then(function () { return sleep(throttle); });
    });

    todo.forEach(function (s) {
      chain = chain.then(function () {
        progress(done, total, 'Looking up ' + (done + 1) + ' of ' + total + ': ' + s.name);
        return geocode(s.address).then(function (hit) {
          if (hit) { s.lat = hit.lat; s.lng = hit.lng; s.geo = 'ok'; }
          else { s.geo = 'fail'; failed++; }
        }).catch(function (e) {
          s.geo = 'fail'; failed++;
          if (!geocodeAll._warned) { geocodeAll._warned = true; toast(e.message, 'err', 5000); }
        }).then(function () {
          done++; save(); renderStops();
          return sleep(throttle);
        });
      });
    });

    return chain.then(function () {
      progress(total, total, failed
        ? failed + ' address' + (failed === 1 ? '' : 'es') + " couldn't be found - fix them and look up again."
        : 'All addresses located.');
      progressDone(); renderStops();
      geocodeAll._warned = false;
      if (failed) toast(failed + " address(es) couldn't be located.", 'err', 4500);
    });
  }

  /* ============================ routing engines ============================ */
  var OSRM = 'https://router.project-osrm.org';

  function useGoogle() {
    return !!(state.settings.gKey && window.google && window.google.maps);
  }

  function loadGoogle() {
    if (window.google && window.google.maps) return Promise.resolve();
    if (!state.settings.gKey) return Promise.reject(new Error('no key'));
    return new Promise(function (resolve, reject) {
      var cb = '__rpGmapsReady';
      window[cb] = function () { resolve(); };
      var sc = document.createElement('script');
      sc.src = 'https://maps.googleapis.com/maps/api/js?key=' +
               encodeURIComponent(state.settings.gKey) + '&callback=' + cb + '&loading=async';
      sc.async = true;
      sc.onerror = function () { reject(new Error('Google Maps failed to load - check the API key.')); };
      document.head.appendChild(sc);
      setTimeout(function () {
        if (!(window.google && window.google.maps)) reject(new Error('Google Maps timed out - check the API key.'));
      }, 12000);
    });
  }

  /* Duration + distance matrix between every pair of points. */
  function matrixOSRM(pts) {
    var coords = pts.map(function (p) { return p.lng + ',' + p.lat; }).join(';');
    var url = OSRM + '/table/v1/driving/' + coords + '?annotations=duration,distance';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Routing service error (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      if (j.code !== 'Ok') throw new Error('Routing service: ' + (j.message || j.code));
      return { dur: j.durations, dist: j.distances };
    });
  }

  /* Road geometry for the final ordered route. */
  function geometryOSRM(pts) {
    var coords = pts.map(function (p) { return p.lng + ',' + p.lat; }).join(';');
    var url = OSRM + '/route/v1/driving/' + coords + '?overview=full&geometries=geojson';
    return fetch(url).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || j.code !== 'Ok' || !j.routes || !j.routes.length) return null;
        return j.routes[0].geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
      }).catch(function () { return null; });
  }

  function departureDate() {
    var now = new Date();
    var mins = parseTime(state.settings.startTime);
    if (mins == null) mins = 8 * 60;
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                     Math.floor(mins / 60), mins % 60, 0, 0);
    if (d.getTime() < now.getTime() + 60000) d.setDate(d.getDate() + 1); // must be in the future
    return d;
  }

  /* Google Directions for an already-ordered set of points: traffic-aware legs. */
  function directionsGoogle(pts, optimize) {
    return new Promise(function (resolve, reject) {
      var svc = new google.maps.DirectionsService();
      svc.route({
        origin: { lat: pts[0].lat, lng: pts[0].lng },
        destination: { lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng },
        waypoints: pts.slice(1, -1).map(function (p) {
          return { location: { lat: p.lat, lng: p.lng }, stopover: true };
        }),
        optimizeWaypoints: !!optimize,
        travelMode: google.maps.TravelMode.DRIVING,
        drivingOptions: { departureTime: departureDate(), trafficModel: google.maps.TrafficModel.BEST_GUESS }
      }, function (res, status) {
        if (status === 'OK') resolve(res);
        else reject(new Error('Google Directions: ' + status));
      });
    });
  }

  /* ============================ optimizer ============================ */
  /* pts index 0 = start, 1..n = stops, n+1 = end.
     The cost of an ordering is driving minutes plus a heavy penalty for every
     minute a fixed appointment would be missed, so the search lands on an order
     that both keeps appointments and minimizes windshield time. */
  function routeCost(seq, D, stops) {
    var s = state.settings, END = stops.length + 1;
    var t = parseTime(s.startTime); if (t == null) t = 8 * 60;
    var drive = 0, idle = 0, late = 0, prev = 0;
    for (var i = 0; i < seq.length; i++) {
      var k = seq[i], stop = stops[k - 1];
      var d = D[prev][k] / 60;
      drive += d; t += d;
      var fixed = parseTime(stop.fixed);
      if (fixed != null) {
        if (t < fixed) { idle += fixed - t; t = fixed; }   // waiting on an appointment
        else if (t > fixed) late += t - fixed;
      }
      t += (stop.minutes || s.visitMin) + s.bufMin;
      prev = k;
    }
    drive += D[prev][END] / 60;
    // Driving and waiting are both time off the clock, so they weigh the same:
    // minimizing the two together is the same as ending the day earliest.
    return drive + idle + late * 1000;
  }

  function optimize(D, n, stops) {
    var order = [], i;
    var hasFixed = stops.some(function (x) { return parseTime(x.fixed) != null; });

    if (hasFixed) {
      // Appointments go down first in clock order; every other stop is slotted
      // into whichever gap costs least without making an appointment late.
      var anchors = [], flex = [];
      stops.forEach(function (x, idx) {
        var f = parseTime(x.fixed);
        if (f != null) anchors.push({ i: idx + 1, t: f });
        else flex.push(idx + 1);
      });
      anchors.sort(function (a, b) { return a.t - b.t; });
      order = anchors.map(function (a) { return a.i; });
      flex.forEach(function (k) {
        var bestPos = order.length, bestCost = Infinity;
        for (var p = 0; p <= order.length; p++) {
          var cand = order.slice(0, p).concat([k], order.slice(p));
          var c = routeCost(cand, D, stops);
          if (c < bestCost) { bestCost = c; bestPos = p; }
        }
        order.splice(bestPos, 0, k);
      });
    } else {
      // Nearest-neighbour seed.
      var unvisited = [], cur = 0;
      for (i = 1; i <= n; i++) unvisited.push(i);
      while (unvisited.length) {
        var bi = 0, bd = Infinity;
        for (var u = 0; u < unvisited.length; u++) {
          if (D[cur][unvisited[u]] < bd) { bd = D[cur][unvisited[u]]; bi = u; }
        }
        cur = unvisited[bi]; order.push(cur); unvisited.splice(bi, 1);
      }
    }

    // 2-opt: reverse a slice of the day whenever that lowers the cost.
    if (order.length > 2) {
      var best = routeCost(order, D, stops), improved = true, guard = 0;
      while (improved && guard++ < 40) {
        improved = false;
        for (var a = 0; a < order.length - 1; a++) {
          for (var b = a + 1; b < order.length; b++) {
            var cand2 = order.slice(0, a)
              .concat(order.slice(a, b + 1).reverse())
              .concat(order.slice(b + 1));
            var c2 = routeCost(cand2, D, stops);
            if (c2 < best - 0.25) { order = cand2; best = c2; improved = true; }
          }
        }
      }
    }
    return order;
  }

  /* ============================ scheduler ============================ */
  function buildSchedule(order, pts, D, DIST, stops) {
    var s = state.settings;
    var END = stops.length + 1;
    var t = parseTime(s.startTime); if (t == null) t = 8 * 60;
    var items = [], totalDrive = 0, totalDist = 0, lunchPlaced = s.lunchMin <= 0;
    var prev = 0;

    for (var i = 0; i < order.length; i++) {
      var k = order[i], stop = stops[k - 1];
      var driveMin = D[prev][k] / 60;
      var distM = DIST ? DIST[prev][k] : 0;
      totalDrive += driveMin; totalDist += distM;

      t += driveMin;
      var arrive = t, hold = 0, late = 0;
      var fixed = parseTime(stop.fixed);

      if (fixed != null) {
        if (arrive < fixed - 0.5) {
          hold = fixed - arrive;
          arrive = fixed;
          // Roll idle time back into the previous buffer, up to the cap set on
          // the Timing card, so a gap reads as breathing room rather than dead
          // time. Anything past the cap is shown as open time.
          if (items.length) {
            var room = Math.max(0, s.bufMax - items[items.length - 1].buffer);
            var absorb = Math.min(hold, room);
            items[items.length - 1].buffer += absorb;
            hold -= absorb;
          }
        } else if (arrive > fixed + 0.5) {
          late = arrive - fixed;
        }
      }

      var visit = stop.minutes || s.visitMin;
      var depart = arrive + visit;
      var isLast = (i === order.length - 1);
      var pad = isLast ? 0 : Math.max(0, s.bufMin);

      // Drop the lunch break into the first gap after 11:30.
      var lunch = 0;
      if (!lunchPlaced && depart >= 11 * 60 + 30 && !isLast) { lunch = s.lunchMin; lunchPlaced = true; }

      items.push({
        stop: stop, seq: i + 1, driveMin: driveMin, distM: distM,
        arrive: arrive, depart: depart, visit: visit,
        hold: hold, late: late, buffer: pad, lunch: lunch,
        fixedAt: fixed
      });

      t = depart + pad + lunch;
      prev = k;
    }

    // Leg back to the start, or on to the ending point.
    var lastDrive = D[prev][END] / 60;
    var lastDist = DIST ? DIST[prev][END] : 0;
    totalDrive += lastDrive; totalDist += lastDist;

    return {
      items: items,
      startMin: parseTime(s.startTime),
      finishMin: t + lastDrive,
      lastDriveMin: lastDrive,
      lastDistM: lastDist,
      totalDriveMin: totalDrive,
      totalDistM: totalDist,
      pts: pts,
      order: order
    };
  }

  /* ============================ plan ============================ */
  var planning = false;

  function planRoute() {
    if (planning) return;
    formToSettings();
    var s = state.settings;

    if (!s.startAddr.trim()) { showTab('stops'); $('startAddr').focus(); toast('Enter a starting address first.', 'err'); return; }
    if (!s.roundTrip && !s.endAddr.trim()) { showTab('stops'); $('endAddr').focus(); toast('Enter an ending address, or check "end back at the starting point".', 'err'); return; }
    if (!state.stops.length) { showTab('stops'); toast('Add some stops first.', 'err'); return; }

    planning = true;
    $('btnPlan').disabled = true;
    $('btnPlan').textContent = 'Planning...';

    var boot = s.gKey ? loadGoogle().catch(function (e) {
      toast(e.message + ' Using the free engine instead.', 'err', 5000);
    }) : Promise.resolve();

    boot
      .then(function () { return geocodeAll(); })
      .then(function () {
        var stops = state.stops.filter(function (x) { return x.geo === 'ok' && x.lat != null; });
        if (!stops.length) throw new Error('None of the addresses could be located.');
        if (s.startLat == null) throw new Error("Your starting address couldn't be located.");
        if (stops.length > 60) throw new Error('That is ' + stops.length + ' stops - trim the list to 60 or fewer.');

        var endPt = s.roundTrip
          ? { lat: s.startLat, lng: s.startLng, label: s.startAddr }
          : { lat: s.endLat, lng: s.endLng, label: s.endAddr };
        if (endPt.lat == null) throw new Error("Your ending address couldn't be located.");

        var pts = [{ lat: s.startLat, lng: s.startLng, label: s.startAddr }]
          .concat(stops.map(function (x) { return { lat: x.lat, lng: x.lng, label: x.name }; }))
          .concat([endPt]);

        var anchors = [];
        stops.forEach(function (x, i) {
          var f = parseTime(x.fixed);
          if (f != null) anchors.push({ idx: i + 1, time: f });
        });

        var googleReady = useGoogle();
        var googleFits = googleReady && stops.length <= 23;
        if (googleReady && !googleFits) {
          toast('Google handles 23 stops per route; sequencing the rest with the free engine.', 'err', 5000);
        }

        return matrixOSRM(pts).then(function (m) {
          var order = s.lockOrder
            ? stops.map(function (_, i) { return i + 1; })
            : optimize(m.dur, stops.length, stops);

          if (!googleFits) {
            return geometryOSRM([pts[0]].concat(order.map(function (k) { return pts[k]; })).concat([pts[pts.length - 1]]))
              .then(function (geo) {
                var sch = buildSchedule(order, pts, m.dur, m.dist, stops);
                sch.geometry = geo;
                sch.engine = 'osrm';
                return sch;
              });
          }

          // Google pass: re-time (and optionally re-order) the legs against
          // predicted traffic for the departure time.
          var ordered = [pts[0]].concat(order.map(function (k) { return pts[k]; })).concat([pts[pts.length - 1]]);
          var canOptimize = !s.lockOrder && anchors.length === 0;
          return directionsGoogle(ordered, canOptimize).then(function (res) {
            var route = res.routes[0];
            var wpOrder = canOptimize && route.waypoint_order ? route.waypoint_order : null;
            var finalOrder = wpOrder ? wpOrder.map(function (i) { return order[i]; }) : order;

            // Rebuild dense matrices from the returned legs, so the scheduler
            // sees Google's traffic-aware numbers on the legs we actually drive.
            var n = stops.length, END = n + 1;
            var Dg = m.dur.map(function (row) { return row.slice(); });
            var DISTg = m.dist ? m.dist.map(function (row) { return row.slice(); }) : null;
            var prev = 0;
            route.legs.forEach(function (leg, i) {
              var cur = i < finalOrder.length ? finalOrder[i] : END;
              var secs = (leg.duration_in_traffic || leg.duration).value;
              Dg[prev][cur] = secs;
              if (DISTg) DISTg[prev][cur] = leg.distance.value;
              prev = cur;
            });
            var sch = buildSchedule(finalOrder, pts, Dg, DISTg, stops);
            sch.geometry = route.overview_path.map(function (p) { return [p.lat(), p.lng()]; });
            sch.engine = 'google';
            return sch;
          }).catch(function (e) {
            toast(e.message + ' Falling back to the free engine.', 'err', 5000);
            return geometryOSRM([pts[0]].concat(order.map(function (k) { return pts[k]; })).concat([pts[pts.length - 1]]))
              .then(function (geo) {
                var sch = buildSchedule(order, pts, m.dur, m.dist, stops);
                sch.geometry = geo; sch.engine = 'osrm';
                return sch;
              });
          });
        });
      })
      .then(function (sch) {
        state.route = sch;
        renderRoute();
        renderMap();
        showTab('route');
        toast('Route planned.', 'ok');
      })
      .catch(function (e) {
        toast(e.message || String(e), 'err', 6000);
      })
      .then(function () {
        planning = false;
        $('btnPlan').disabled = false;
        $('btnPlan').textContent = 'Plan route';
      });
  }

  /* ============================ render route ============================ */
  function navButtons(lat, lng, label, phone) {
    var q = encodeURIComponent(lat + ',' + lng);
    var out = '<a class="icon-btn sm" target="_blank" rel="noopener" ' +
      'href="https://www.google.com/maps/dir/?api=1&destination=' + q + '&travelmode=driving">Google Maps</a>' +
      '<a class="icon-btn sm" target="_blank" rel="noopener" ' +
      'href="https://www.waze.com/ul?ll=' + q + '&navigate=yes">Waze</a>' +
      '<a class="icon-btn sm" target="_blank" rel="noopener" ' +
      'href="https://maps.apple.com/?daddr=' + q + '&dirflg=d">Apple Maps</a>';
    if (phone) {
      out += '<a class="icon-btn sm" href="tel:' + esc(String(phone).replace(/[^\d+]/g, '')) + '">Call</a>';
    }
    return out;
  }

  function legLine(driveMin, distM, extra) {
    var bits = ['&#128663; ' + fmtMins(driveMin) + ' drive'];
    if (distM) bits.push(miles(distM).toFixed(1) + ' mi');
    if (extra) bits.push(extra);
    return '<div class="leg">' + bits.join(' &nbsp;&middot;&nbsp; ') + '</div>';
  }

  function renderRoute() {
    var r = state.route;
    $('routeEmpty').classList.toggle('hide', !!r);
    $('routeOut').classList.toggle('hide', !r);
    if (!r) return;
    var s = state.settings;

    $('statStops').textContent = r.items.length;
    $('statDrive').textContent = fmtMins(r.totalDriveMin);
    $('statMiles').textContent = r.totalDistM ? miles(r.totalDistM).toFixed(0) : '--';
    $('statEnd').textContent = fmtTime(r.finishMin);

    $('itinHint').innerHTML = r.engine === 'google'
      ? 'Drive times are Google&rsquo;s traffic prediction for a ' + fmtTime(r.startMin) + ' departure.'
      : 'Drive times are road-speed estimates. Live traffic comes from Google Maps or Waze when you navigate.';

    var html = '';

    // Start
    html += '<div class="stop anchor">' +
      '<div class="badge">&#9654;</div>' +
      '<div class="body"><div class="nm">Start</div>' +
      '<div class="ad">' + esc(s.startAddr) + '</div></div>' +
      '<div class="time-col"><div class="t">' + fmtTime(r.startMin) + '</div>' +
      '<div class="t2">depart</div></div></div>';

    r.items.forEach(function (it) {
      html += legLine(it.driveMin, it.distM);

      var pills = [];
      if (it.fixedAt != null) pills.push('<span class="pill brand">Appt ' + fmtTime(it.fixedAt) + '</span>');
      pills.push('<span class="pill">' + it.visit + ' min visit</span>');
      if (it.hold > 1) pills.push('<span class="pill warn">Open ' + fmtMins(it.hold) + ' before this</span>');
      if (it.late > 1) pills.push('<span class="pill err">' + fmtMins(it.late) + ' late</span>');
      if (it.stop.notes) pills.push('<span class="pill">' + esc(it.stop.notes) + '</span>');

      html += '<div class="stop' + (it.fixedAt != null ? ' fixed' : '') + '">' +
        '<div class="badge">' + it.seq + '</div>' +
        '<div class="body">' +
          '<div class="nm">' + esc(it.stop.name) + '</div>' +
          '<div class="ad">' + esc(it.stop.address) +
            (it.stop.phone ? ' &middot; ' + esc(it.stop.phone) : '') + '</div>' +
          '<div class="meta">' + pills.join('') + '</div>' +
          '<div class="acts">' + navButtons(it.stop.lat, it.stop.lng, it.stop.name, it.stop.phone) + '</div>' +
        '</div>' +
        '<div class="time-col">' +
          '<div class="t">' + fmtTime(it.arrive) + '</div>' +
          '<div class="t2">to ' + fmtTime(it.depart) + '</div>' +
        '</div></div>';

      if (it.buffer || it.lunch) {
        var parts = [];
        if (it.buffer) parts.push(fmtMins(it.buffer) + ' buffer');
        if (it.lunch) parts.push(fmtMins(it.lunch) + ' lunch');
        html += '<div class="leg">&#9203; ' + parts.join(' &nbsp;&middot;&nbsp; ') + '</div>';
      }
    });

    html += legLine(r.lastDriveMin, r.lastDistM);
    html += '<div class="stop anchor">' +
      '<div class="badge">&#9873;</div>' +
      '<div class="body"><div class="nm">' + (s.roundTrip ? 'Back to start' : 'End') + '</div>' +
      '<div class="ad">' + esc(s.roundTrip ? s.startAddr : s.endAddr) + '</div></div>' +
      '<div class="time-col"><div class="t">' + fmtTime(r.finishMin) + '</div>' +
      '<div class="t2">arrive</div></div></div>';

    $('itinerary').innerHTML = html;

    // Day-end warning
    var dayEnd = parseTime(s.dayEnd);
    if (dayEnd != null && r.finishMin > dayEnd) {
      $('itinHint').innerHTML += ' <span class="pill err">Finishes ' +
        fmtMins(r.finishMin - dayEnd) + ' past ' + fmtTime(dayEnd) + '</span>';
    }

    // Google Maps handoff links (10 points max per URL, chained end-to-start).
    var chunks = gmapsChunks();
    $('gmapsNote').innerHTML = chunks.length > 1
      ? 'Google Maps takes 10 points per link, so the day opens in ' + chunks.length +
        ' parts: ' + chunks.map(function (c, i) {
          return '<a href="' + c + '" target="_blank" rel="noopener">Part ' + (i + 1) + '</a>';
        }).join(' &middot; ')
      : 'Opens the full day in Google Maps with live traffic. Each stop above also has ' +
        'Google Maps, Waze and Apple Maps buttons.';
  }

  function gmapsChunks() {
    var r = state.route; if (!r) return [];
    var s = state.settings;
    var pts = [{ lat: s.startLat, lng: s.startLng }]
      .concat(r.items.map(function (it) { return { lat: it.stop.lat, lng: it.stop.lng }; }))
      .concat([{ lat: r.pts[r.pts.length - 1].lat, lng: r.pts[r.pts.length - 1].lng }]);

    var urls = [], i = 0;
    while (i < pts.length - 1) {
      var slice = pts.slice(i, i + 10);
      var origin = slice[0], dest = slice[slice.length - 1], mid = slice.slice(1, -1);
      var u = 'https://www.google.com/maps/dir/?api=1&travelmode=driving' +
        '&origin=' + encodeURIComponent(origin.lat + ',' + origin.lng) +
        '&destination=' + encodeURIComponent(dest.lat + ',' + dest.lng);
      if (mid.length) {
        u += '&waypoints=' + mid.map(function (p) {
          return encodeURIComponent(p.lat + ',' + p.lng);
        }).join('%7C');
      }
      urls.push(u);
      i += 9;
    }
    return urls;
  }

  /* ============================ map ============================ */
  var map = null, layer = null, lastBounds = null;

  function renderMap() {
    var r = state.route;
    if (!r) return;
    if (!map) {
      map = L.map('map', { scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap'
      }).addTo(map);
    }
    if (layer) map.removeLayer(layer);
    layer = L.layerGroup().addTo(map);

    var s = state.settings;
    var bounds = [];
    function pin(lat, lng, text, cls, popup) {
      bounds.push([lat, lng]);
      L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: '<div class="pin ' + (cls || '') + '">' + text + '</div>',
                          iconSize: [26, 26], iconAnchor: [13, 13] })
      }).addTo(layer).bindPopup(popup);
    }

    pin(s.startLat, s.startLng, '&#9654;', 'anchor', '<b>Start</b><br>' + esc(s.startAddr));
    r.items.forEach(function (it) {
      pin(it.stop.lat, it.stop.lng, it.seq, '',
        '<b>' + esc(it.stop.name) + '</b><br>' + esc(it.stop.address) +
        '<br>' + fmtTime(it.arrive) + ' &ndash; ' + fmtTime(it.depart));
    });
    var last = r.pts[r.pts.length - 1];
    if (!s.roundTrip) pin(last.lat, last.lng, '&#9873;', 'anchor', '<b>End</b><br>' + esc(s.endAddr));

    if (r.geometry && r.geometry.length) {
      L.polyline(r.geometry, { color: '#c25e2f', weight: 4, opacity: .85 }).addTo(layer);
    } else {
      L.polyline(bounds, { color: '#c25e2f', weight: 3, opacity: .6, dashArray: '6,6' }).addTo(layer);
    }

    lastBounds = L.latLngBounds(bounds);
    fitMap();
    $('mapHint').textContent = r.items.length + ' stops \u00b7 ' + fmtMins(r.totalDriveMin) +
      ' driving \u00b7 ' + (r.totalDistM ? miles(r.totalDistM).toFixed(0) + ' miles' : '');
  }

  /* Leaflet can't measure a hidden pane, so the fit is redone whenever the map
     becomes visible. */
  function fitMap() {
    if (!map || !lastBounds) return;
    // Two passes: the first sizes the pane, the second catches tiles that were
    // still loading against the old width.
    [60, 450].forEach(function (delay) {
      setTimeout(function () {
        if (!map || !lastBounds) return;
        map.invalidateSize();
        map.fitBounds(lastBounds.pad(0.15));
      }, delay);
    });
  }

  /* ============================ exports ============================ */
  function itineraryText() {
    var r = state.route, s = state.settings;
    if (!r) return '';
    var L2 = [];
    L2.push('ROUTE - ' + new Date().toLocaleDateString());
    L2.push(fmtTime(r.startMin) + '  Depart  ' + s.startAddr);
    r.items.forEach(function (it) {
      L2.push('   drive ' + fmtMins(it.driveMin) + (it.distM ? ' / ' + miles(it.distM).toFixed(1) + ' mi' : ''));
      L2.push(fmtTime(it.arrive) + '  ' + it.seq + '. ' + it.stop.name +
              (it.fixedAt != null ? '  [appt ' + fmtTime(it.fixedAt) + ']' : '') + '  (until ' + fmtTime(it.depart) + ')');
      L2.push('        ' + it.stop.address + (it.stop.phone ? '  ' + it.stop.phone : ''));
      if (it.stop.notes) L2.push('        ' + it.stop.notes);
      if (it.buffer) L2.push('   buffer ' + fmtMins(it.buffer));
      if (it.lunch) L2.push('   lunch ' + fmtMins(it.lunch));
    });
    L2.push('   drive ' + fmtMins(r.lastDriveMin));
    L2.push(fmtTime(r.finishMin) + '  ' + (s.roundTrip ? 'Back at start' : 'End') + '  ' +
            (s.roundTrip ? s.startAddr : s.endAddr));
    L2.push('');
    L2.push('Total driving ' + fmtMins(r.totalDriveMin) +
            (r.totalDistM ? ' / ' + miles(r.totalDistM).toFixed(0) + ' miles' : ''));
    return L2.join('\n');
  }

  function exportExcel() {
    var r = state.route, s = state.settings;
    if (!r) { toast('Plan a route first.', 'err'); return; }
    var aoa = [['#', 'Arrive', 'Depart', 'Name', 'Address', 'Phone',
                'Drive (min)', 'Miles', 'Minutes at stop', 'Fixed', 'Notes']];
    aoa.push(['', fmtTime(r.startMin), '', 'START', s.startAddr, '', '', '', '', '', '']);
    r.items.forEach(function (it) {
      aoa.push([
        it.seq, fmtTime(it.arrive), fmtTime(it.depart), it.stop.name, it.stop.address,
        it.stop.phone || '', Math.round(it.driveMin),
        it.distM ? +miles(it.distM).toFixed(1) : '', it.visit,
        it.fixedAt != null ? fmtTime(it.fixedAt) : '', it.stop.notes || ''
      ]);
    });
    aoa.push(['', fmtTime(r.finishMin), '', s.roundTrip ? 'BACK AT START' : 'END',
              s.roundTrip ? s.startAddr : s.endAddr, '', Math.round(r.lastDriveMin),
              r.lastDistM ? +miles(r.lastDistM).toFixed(1) : '', '', '', '']);
    aoa.push([]);
    aoa.push(['', '', '', 'TOTAL DRIVING', fmtMins(r.totalDriveMin), '', Math.round(r.totalDriveMin),
              r.totalDistM ? +miles(r.totalDistM).toFixed(0) : '', '', '', '']);

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 4 }, { wch: 10 }, { wch: 10 }, { wch: 28 }, { wch: 38 },
                   { wch: 15 }, { wch: 11 }, { wch: 8 }, { wch: 15 }, { wch: 7 }, { wch: 30 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Itinerary');
    var d = new Date();
    var stamp = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    XLSX.writeFile(wb, 'Route_' + stamp + '.xlsx');
  }

  /* ============================ wiring ============================ */
  function init() {
    load();
    settingsToForm();
    renderStops();

    // Tabs
    Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
      b.addEventListener('click', function () { showTab(b.dataset.tab); });
    });

    // Settings
    SETTING_FIELDS.forEach(function (f) {
      var el = $(f[0]); if (!el) return;
      el.addEventListener('change', function () {
        if (f[1] === 'startAddr') { state.settings.startLat = state.settings.startLng = null; }
        if (f[1] === 'endAddr') { state.settings.endLat = state.settings.endLng = null; }
        formToSettings();
        $('endWrap').classList.toggle('hide', !!state.settings.roundTrip);
        if (f[1] === 'visitMin') renderStops();
      });
    });

    $('btnUseLocation').addEventListener('click', function () {
      if (!navigator.geolocation) { toast('This browser has no location access.', 'err'); return; }
      toast('Getting your location...');
      navigator.geolocation.getCurrentPosition(function (pos) {
        state.settings.startLat = pos.coords.latitude;
        state.settings.startLng = pos.coords.longitude;
        var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' +
                  pos.coords.latitude + '&lon=' + pos.coords.longitude;
        fetch(url).then(function (r) { return r.json(); }).then(function (j) {
          state.settings.startAddr = (j && j.display_name) ||
            (pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5));
          $('startAddr').value = state.settings.startAddr;
          save(); toast('Starting point set.', 'ok');
        }).catch(function () {
          state.settings.startAddr = pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5);
          $('startAddr').value = state.settings.startAddr;
          save();
        });
      }, function () { toast('Location permission denied.', 'err'); }, { timeout: 10000 });
    });

    // File upload
    var drop = $('drop'), file = $('file');
    drop.addEventListener('click', function (e) {
      // The input lives inside the drop zone, so its own programmatic click
      // bubbles straight back here. Without this guard the picker is asked to
      // open twice and the second request cancels the first.
      if (e.target === file || e.target.id === 'btnBrowse') return;
      file.click();
    });
    $('btnBrowse').addEventListener('click', function (e) {
      e.stopPropagation();
      file.click();
    });
    file.addEventListener('change', function () {
      if (file.files && file.files[0]) readFile(file.files[0]);
      // NOTE: the input is deliberately NOT cleared here. Safari backs the File
      // object with the input's selection, so clearing it while FileReader is
      // still working kills the read with no error. readFile() clears it once
      // the bytes are in hand.
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });

    $('btnImport').addEventListener('click', function () { doImport(false); });
    $('sheetPick').addEventListener('change', function () { useSheet(this.value); });
    $('btnRemap').addEventListener('click', function () {
      if (!pendingHeaders) { toast('Upload a file first.', 'err'); return; }
      renderColumnMapper();
    });
    $('btnCancelImport').addEventListener('click', function () {
      pendingRows = pendingHeaders = null;
      $('mapCols').classList.add('hide');
    });
    $('btnTemplate').addEventListener('click', downloadTemplate);
    $('btnTemplate2').addEventListener('click', downloadTemplate);

    $('btnAddRow').addEventListener('click', function () {
      state.stops.push({ id: uid(), name: '', address: '', phone: '', notes: '',
                         minutes: null, fixed: '', lat: null, lng: null, geo: 'pending' });
      save(); renderStops();
      var rows = $('stopsBody').querySelectorAll('tr');
      var lastRow = rows[rows.length - 1];
      if (lastRow) lastRow.querySelector('input').focus();
    });

    $('btnGeocode').addEventListener('click', function () {
      formToSettings();
      state.stops.forEach(function (s) { if (s.geo === 'fail') s.geo = 'pending'; });
      geocodeAll();
    });

    $('btnClear').addEventListener('click', function () {
      if (!state.stops.length) return;
      if (!confirm('Remove all ' + state.stops.length + ' stops?')) return;
      state.stops = []; state.route = null;
      save(); renderStops(); renderRoute();
      toast('Stops cleared.');
    });

    // Inline edits in the stops table
    $('stopsBody').addEventListener('input', function (e) {
      var inp = e.target.closest('input'); if (!inp) return;
      var tr = e.target.closest('tr'); if (!tr) return;
      var s = stopById(tr.dataset.id); if (!s) return;
      var f = inp.dataset.f;
      if (f === 'minutes') s.minutes = parseInt(inp.value, 10) || null;
      else {
        s[f] = inp.value;
        if (f === 'address') { s.lat = s.lng = null; s.geo = 'pending'; }
      }
      save();
    });
    $('stopsBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-del]'); if (!btn) return;
      state.stops = state.stops.filter(function (s) { return s.id !== btn.dataset.del; });
      save(); renderStops();
    });

    // Route actions
    $('btnPlan').addEventListener('click', planRoute);
    $('btnGmaps').addEventListener('click', function () {
      var c = gmapsChunks();
      if (!c.length) { toast('Plan a route first.', 'err'); return; }
      window.open(c[0], '_blank', 'noopener');
      if (c.length > 1) toast('Opened part 1 of ' + c.length + ' - the rest are linked below.', null, 5000);
    });
    $('btnExport').addEventListener('click', exportExcel);
    $('btnCopy').addEventListener('click', function () {
      var txt = itineraryText();
      if (!txt) { toast('Plan a route first.', 'err'); return; }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(txt).then(function () { toast('Itinerary copied.', 'ok'); })
          .catch(function () { toast('Copy failed.', 'err'); });
      } else { toast('Copy not available in this browser.', 'err'); }
    });
    $('btnPrint').addEventListener('click', function () {
      if (!state.route) { toast('Plan a route first.', 'err'); return; }
      showTab('route'); setTimeout(function () { window.print(); }, 120);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

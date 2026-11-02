/* Reflect Route Planner — paste accounts in from directory sites

   Up to ten sources per sweep. Run the same search on each site, paste
   the results into a slot, then cross-reference: rows that appear on
   several sites get merged and carry a confidence count; rows that
   disagree on an address or phone are held back for review rather than
   silently picking a winner.

   That hold-back is the point. The BOTOX directory and Google both
   listed Broadway Plastic Surgery on E Hampden; the practice's own site
   said Lone Tree, nine miles away. A merge that quietly preferred one
   would have buried that. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_SOURCES = 10;

  var P = { slots: 0, review: null };

  /* ---------------- parsing ---------------- */

  var STREET = /\b(ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive|way|pkwy|parkway|ln|lane|ct|court|cir|circle|pl|place|ter|trail|hwy|highway)\b\.?/i;
  var CSZ    = /([A-Za-z .'\-]+),\s*([A-Z]{2})\.?\s+(\d{5})(?:-\d{4})?/;
  var PHONE  = /\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-](\d{4})/;
  var SUITE  = /\b(?:ste|suite|unit|apt|bldg|building|fl|floor|rm|room)\b\.?\s*#?\s*([A-Za-z0-9\-]+)|#\s*([A-Za-z0-9\-]+)/i;

  /* Lines these sites pad their results with — never a name or address. */
  var NOISE = /^(·|•|\||\d+(\.\d+)?\s*mi\b|open\b|clos(ed|es)\b|website|directions|call|share|save|schedule|book|more\b|sponsored|payment plans|onsite services|appointment required|online scheduling|write a review|see photos|see outside|\d+(\.\d+)?\s*\(|\d+(\.\d+)?★|★|reviews?\b|\d+\+?\s*years? in business|highlights?:|products and services:|located in:)/i;

  function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  /* The reader hands back markdown, so a business name can arrive wearing
     heading hashes, bold stars or link syntax. Strip the decoration, keep
     the name. */
  function cleanName(s) {
    return clean((s || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')      /* images carry no name */
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   /* [label](href) -> label */
      .replace(/^[#>\s]+/, '')
      .replace(/^[*_]{1,3}/, '').replace(/[*_]{1,3}$/, '')
      .replace(/^[-\u2013\u2014\s]+/, ''));
  }
  function isNoise(l) {
    if (!l || l.length < 2) return true;
    if (/^!\[|^!?image\s*\d*\s*:/i.test(l)) return true;    /* ![Image 5: …](…) */
    var bare = l.replace(/^[#>*_\-\s]+/, '');
    return NOISE.test(l) || NOISE.test(bare);
  }

  function digits(s) { var m = clean(s).match(PHONE); return m ? m[1] + m[2] + m[3] : ''; }

  function looksAddress(l) {
    return /^\d{2,6}\s/.test(l) && STREET.test(l);
  }

  /* Anchor on the address line: every one of these sites prints one, and
     the business name is the nearest meaningful line above it.

     The address itself is pulled apart from the right: strip the phone
     and bullet separators, take state+ZIP off the end, lift out the
     suite, then split street from city on the LAST street suffix. Doing
     it in that order is what keeps "1035 S Gaylord St Denver" from
     parsing as street "1035", city "S Gaylord St Denver". */
  var SUFFIX = /\b(ave|avenue|st|street|rd|road|blvd|boulevard|dr|drive|way|pkwy|parkway|ln|lane|ct|court|cir|circle|pl|place|ter|terrace|trail|hwy|highway)\b\.?/ig;
  var PHONE_G = /\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}/g;
  var STZIP = /\b([A-Z]{2})\.?\s+(\d{5})(?:-\d{4})?\b/;

  function splitStreetCity(head) {
    SUFFIX.lastIndex = 0;
    var last = null, m;
    while ((m = SUFFIX.exec(head)) !== null) last = m;
    if (!last) return { street: head, city: '' };
    var cut = last.index + last[0].length;
    return {
      street: clean(head.slice(0, cut)),
      city: clean(head.slice(cut).replace(/^[,\s]+/, ''))
    };
  }

  function parse(text) {
    var lines = (text || '').split(/\r?\n/).map(clean);
    var out = [], i, j;

    for (i = 0; i < lines.length; i++) {
      if (!looksAddress(lines[i])) continue;

      var name = '';
      for (j = i - 1; j >= 0 && j >= i - 6; j--) {
        if (!isNoise(lines[j]) && !looksAddress(lines[j]) && !PHONE.test(lines[j])) { name = lines[j]; break; }
      }
      if (!name) continue;

      /* phone can sit on the address line, just after it, or just before */
      var phone = '';
      for (j = i; j <= i + 4 && j < lines.length && !phone; j++) phone = digits(lines[j]);
      for (j = i - 1; j >= 0 && j >= i - 3 && !phone; j--) phone = digits(lines[j]);

      var raw = clean(lines[i].replace(PHONE_G, ' ').replace(/[\u00b7\u2022|]/g, ' '));

      var state = '', zip = '', city = '';
      var m = raw.match(STZIP);
      if (m) {
        state = m[1]; zip = m[2];
        raw = clean(raw.slice(0, m.index).replace(/[,]\s*$/, ''));
      } else {
        for (j = i + 1; j <= i + 3 && j < lines.length; j++) {
          var m2 = lines[j].match(CSZ);
          if (m2) { city = clean(m2[1]); state = m2[2]; zip = m2[3]; break; }
        }
      }

      var suite = '';
      /* some sites put the suite on its own line under the street */
      for (j = i + 1; j <= i + 2 && j < lines.length && !suite; j++) {
        if (/^(ste|suite|unit|apt|bldg|fl|floor|rm|room)\b\.?\s*#?\s*[A-Za-z0-9\-]+$|^#\s*[A-Za-z0-9\-]+$/i.test(lines[j])) {
          var bare = lines[j].match(SUITE);
          if (bare) suite = clean(bare[1] || bare[2]);
        }
      }
      var sm = raw.match(SUITE);
      if (!suite && sm) {
        suite = clean(sm[1] || sm[2]);
      }
      if (sm) {
        raw = clean(raw.slice(0, sm.index) + ' ' + raw.slice(sm.index + sm[0].length));
      }

      var sc = splitStreetCity(raw);
      if (!city) city = sc.city;

      out.push({
        name: cleanName(name), street: sc.street, suite: suite,
        city: city, state: state, zip: zip, phone: phone
      });
    }
    return out;
  }

  /* ---------------- matching ---------------- */

  var BIZ = /(spa|clinic|derm|aesthet|surg|center|centre|institute|group|associates|medicine|medical|health|skin|beauty|laser|wellness|care|plastic|studio|lounge|bar|house|co\b|llc|pllc|pc\b|inc\b)/i;
  var CRED = /\b(m\.?d|d\.?o|r\.?n|p\.?a[-\s]?c|n\.?p|aprn|fnp|dnp|dds|dmd|facs|faad|bsn|msn)\b/i;

  /* A row that is a person rather than a practice: either it carries a
     credential, or it reads like a name with no business words in it. */
  function looksPerson(name) {
    if (CRED.test(name)) return true;
    var words = name.split(/\s+/);
    return words.length <= 3 && !BIZ.test(name);
  }

  function normName(s) {
    return (s || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(the|a|an|llc|pllc|inc|pc|co|company|and)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function streetNum(s) { var m = (s || '').match(/^\d+/); return m ? m[0] : ''; }

  function keys(r) {
    return {
      phone: r.phone || '',
      addr: (streetNum(r.street) + '|' + (r.suite || '').toLowerCase() + '|' + (r.zip || '')),
      addrNoSuite: (streetNum(r.street) + '|' + (r.zip || '')),
      name: normName(r.name) + '|' + (r.zip || '')
    };
  }

  function sameRow(a, b) {
    var ka = keys(a), kb = keys(b);
    if (ka.phone && ka.phone === kb.phone) return 'phone';
    if (ka.addr !== '||' && ka.addr === kb.addr) return 'address';
    if (normName(a.name) && ka.name === kb.name) return 'name';
    return null;
  }

  function conflictsBetween(a, b) {
    var out = [], fields = ['street', 'suite', 'city', 'zip', 'phone'];
    fields.forEach(function (f) {
      var va = clean(a[f] || ''), vb = clean(b[f] || '');
      if (!va || !vb) return;
      if (va.toLowerCase() !== vb.toLowerCase()) out.push({ field: f, a: va, b: vb });
    });
    return out;
  }

  /* ---------------- cross-reference ---------------- */

  function gather() {
    var jobs = [];
    for (var i = 1; i <= P.slots; i++) {
      var nameEl = $('srcName' + i), urlEl = $('srcUrl' + i);
      if (!nameEl || !urlEl) continue;
      var u = clean(urlEl.value);
      if (!u) continue;
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      var label = clean(nameEl.value);
      if (!label) { try { label = new URL(u).hostname.replace(/^www\./, ''); } catch (e) { label = 'Site ' + i; } }
      jobs.push({ source: label, url: u });
    }
    return jobs;
  }

  function crossReference(sets, existing) {
    var merged = [];          /* {row, sources[], conflicts[], match} */
    var flags = [];

    function findMerged(r) {
      for (var i = 0; i < merged.length; i++) {
        var how = sameRow(r, merged[i].row);
        if (how) return { entry: merged[i], how: how };
      }
      return null;
    }

    sets.forEach(function (set) {
      set.rows.forEach(function (r) {
        var hit = findMerged(r);
        if (hit) {
          if (hit.entry.sources.indexOf(set.source) < 0) hit.entry.sources.push(set.source);
          conflictsBetween(hit.entry.row, r).forEach(function (c) {
            c.sourceA = hit.entry.sources[0]; c.sourceB = set.source;
            hit.entry.conflicts.push(c);
          });
          /* fill blanks from the later source */
          ['street', 'suite', 'city', 'state', 'zip', 'phone'].forEach(function (f) {
            if (!hit.entry.row[f] && r[f]) hit.entry.row[f] = r[f];
          });
          return;
        }
        merged.push({ row: r, sources: [set.source], conflicts: [], match: null });
      });
    });

    /* same street + zip, different suite -> different business, keep both
       but say so. And a person's name at an address a practice already
       holds is probably staff, not an account. */
    merged.forEach(function (m, i) {
      merged.forEach(function (n, j) {
        if (j <= i) return;
        var km = keys(m.row), kn = keys(n.row);
        if (km.addrNoSuite !== '|' && km.addrNoSuite === kn.addrNoSuite && km.addr !== kn.addr) {
          var person = looksPerson(m.row.name) ? m : (looksPerson(n.row.name) ? n : null);
          var other  = person === m ? n : m;
          if (person && !person.flagged) {
            person.flagged = 'Possibly a clinician at ' + other.row.name + ', not a separate account';
            flags.push(person);
          } else if (!m.flagged && !n.flagged) {
            n.flagged = 'Same building as ' + m.row.name + ', different suite — kept separate';
            flags.push(n);
          }
        }
      });
    });

    /* against what is already saved */
    merged.forEach(function (m) {
      for (var i = 0; i < existing.length; i++) {
        var e = existing[i];
        var how = sameRow(m.row, {
          name: e.name, street: e.street || '', suite: e.suite || '',
          city: e.city || '', zip: e.zip || '', phone: digits(e.phone || '')
        });
        if (how) {
          m.match = e;
          m.conflicts = m.conflicts.concat(conflictsBetween({
            street: e.street || '', suite: e.suite || '', city: e.city || '',
            zip: e.zip || '', phone: digits(e.phone || '')
          }, m.row).map(function (c) { c.sourceA = 'already saved'; c.sourceB = m.sources[0]; return c; }));
          break;
        }
      }
    });

    return merged;
  }

  /* ---------------- review + save ---------------- */

  function row(el, cells, cls) {
    var tr = document.createElement('tr');
    if (cls) tr.className = cls;
    cells.forEach(function (c) {
      var td = document.createElement('td');
      if (c && c.nodeType) td.appendChild(c); else td.textContent = c == null ? '' : String(c);
      tr.appendChild(td);
    });
    el.appendChild(tr);
    return tr;
  }

  function renderReview(merged) {
    var body = $('pasteBody');
    body.textContent = '';

    var nNew = 0, nKnown = 0, nConf = 0;

    merged.forEach(function (m, idx) {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !m.match;                /* default: add the new ones */
      cb.setAttribute('data-idx', String(idx));

      var status = m.match ? 'already saved' : 'new';
      if (m.match) nKnown++; else nNew++;
      if (m.conflicts.length) nConf++;

      var addr = [[m.row.street, m.row.suite && ('Ste ' + m.row.suite)].filter(Boolean).join(' '),
                  m.row.city, m.row.state, m.row.zip].filter(Boolean).join(', ');

      var noteBits = [];
      if (m.conflicts.length) {
        noteBits.push(m.conflicts.map(function (c) {
          return c.field + ': "' + c.a + '" vs "' + c.b + '"';
        }).join('; '));
      }
      if (m.flagged) noteBits.push(m.flagged);

      var noteCell = document.createElement('span');
      noteCell.textContent = noteBits.join(' — ');
      if (noteBits.length) noteCell.className = 'warn-text';

      /* Names are read off rendered pages, so some arrive wrong. This is
         the review step - let them be corrected here rather than after. */
      var nameIn = document.createElement('input');
      nameIn.className = 'name-edit';
      nameIn.value = m.row.name || '';
      nameIn.addEventListener('change', function () { m.row.name = clean(nameIn.value); });

      row(body, [cb, nameIn, addr, m.row.phone, m.sources.length + '× ' + m.sources.join(', '),
                 status, noteCell],
          m.conflicts.length ? 'row-warn' : '');
    });

    $('pasteSummary').textContent =
      merged.length + ' unique accounts — ' + nNew + ' new, ' + nKnown + ' already saved' +
      (nConf ? ', ' + nConf + ' with conflicting details' : '');
    $('pasteReview').classList.remove('hide');
  }

  function save() {
    var user = window.RP_AUTH && window.RP_AUTH.user;
    var db = window.RP_DB;
    if (!user || !db) { msg('Sign in first.', 'err'); return; }
    if (!P.review) return;

    var picked = [];
    Array.prototype.slice.call(document.querySelectorAll('#pasteBody input:checked'))
      .forEach(function (cb) { picked.push(P.review[parseInt(cb.getAttribute('data-idx'), 10)]); });

    if (!picked.length) { msg('Nothing ticked.', 'err'); return; }

    var toInsert = picked.filter(function (m) { return !m.match; }).map(function (m) {
      return {
        owner_id: user.id,
        name: m.row.name,
        street: m.row.street || null,
        suite: m.row.suite || null,
        city: m.row.city || null,
        state: m.row.state || null,
        zip: m.row.zip || null,
        phone: m.row.phone || null,
        source: m.sources.join(' + ')
      };
    });

    msg('Saving ' + picked.length + ' accounts…');

    var step = toInsert.length
      ? db.from('candidates').insert(toInsert).select('id,name,zip')
      : Promise.resolve({ data: [] });

    step.then(function (res) {
      if (res.error) throw res.error;
      var made = res.data || [];
      var links = [], confs = [];

      picked.forEach(function (m) {
        var id = m.match ? m.match.id : (function () {
          var hit = made.filter(function (x) { return x.name === m.row.name; })[0];
          return hit ? hit.id : null;
        })();
        if (!id) return;
        m.sources.forEach(function (s) {
          links.push({
            owner_id: user.id, candidate_id: id, source_name: s,
            raw_name: m.row.name,
            raw_address: [m.row.street, m.row.suite, m.row.city, m.row.state, m.row.zip].filter(Boolean).join(' '),
            raw_phone: m.row.phone || null
          });
        });
        m.conflicts.forEach(function (c) {
          confs.push({
            owner_id: user.id, candidate_id: id, field: c.field,
            value_a: c.a, source_a: c.sourceA || null,
            value_b: c.b, source_b: c.sourceB || null
          });
        });
      });

      return db.from('candidate_sources').upsert(links, { onConflict: 'candidate_id,source_name' })
        .then(function () { return confs.length ? db.from('conflicts').insert(confs) : null; });
    }).then(function () {
      msg('Saved. ' + toInsert.length + ' new, ' +
          (picked.length - toInsert.length) + ' updated with a new source.', 'ok');
      $('pasteReview').classList.add('hide');
      if (window.RP_FIND && window.RP_FIND.reload) window.RP_FIND.reload();
    }).catch(function (e) {
      msg('Save failed: ' + ((e && e.message) || 'unknown error'), 'err');
    });
  }

  function msg(t, k) {
    var el = $('pasteMsg');
    if (!el) return;
    el.textContent = t || '';
    el.className = 'note' + (k ? ' ' + k : '');
  }

  /* ---------------- slots ---------------- */

  function addSlot(presetName) {
    if (P.slots >= MAX_SOURCES) return;
    P.slots++;
    var i = P.slots;

    var wrap = document.createElement('div');
    wrap.className = 'src-slot';

    var lab = document.createElement('label');
    lab.setAttribute('for', 'srcUrl' + i);
    lab.textContent = 'Site ' + i;

    var nm = document.createElement('input');
    nm.id = 'srcName' + i;
    nm.placeholder = 'Label (optional) - e.g. BOTOX directory, Google';
    nm.setAttribute('list', 'srcSuggest');
    if (presetName) nm.value = presetName;

    var url = document.createElement('input');
    url.id = 'srcUrl' + i;
    url.type = 'url';
    url.placeholder = 'https://…  paste the page address here';
    url.setAttribute('spellcheck', 'false');

    wrap.appendChild(lab); wrap.appendChild(nm); wrap.appendChild(url);
    $('srcSlots').appendChild(wrap);

    $('btnSrcAdd').disabled = P.slots >= MAX_SOURCES;
    $('srcCount').textContent = P.slots + ' of ' + MAX_SOURCES + ' sites';
  }

  /* ---------------- fetching ---------------- */

  /* A browser cannot read another site directly - the cross-origin rule
     stops it. r.jina.ai fetches the page server-side and hands back its
     rendered text, which is enough to read a name, address and phone.

     It does not execute a site's own scripts, so pages that draw their
     listings after load (botoxcosmetic's /search and /browse) still come
     back empty. Their individual provider pages read perfectly. */
  var READER = 'https://r.jina.ai/';

  function fetchPage(url) {
    return fetch(READER + url, { headers: { 'Accept': 'text/plain' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
  }

  /* The reader puts the page title on the first line and renders phone
     numbers as tel: links, so those are more reliable than scraping the
     body text for them. */
  function fromPage(text, fallbackName) {
    var title = (text.match(/^Title:\s*(.+)$/m) || [])[1] || '';
    title = cleanName(title).split(/\s[|\-\u2013\u2014]\s/)[0].trim();

    var rows = parse(text);

    if (rows.length > 1) {
      return rows.filter(function (r) { return !looksNoiseName(r.name); });
    }

    if (rows.length === 1) {
      if (!rows[0].name || looksNoiseName(rows[0].name)) rows[0].name = title || fallbackName;
      if (!rows[0].phone) {
        var tel = text.match(/tel:\+?1?(\d{10})/);
        if (tel) rows[0].phone = tel[1];
      }
      return rows;
    }

    /* no address found - still worth keeping if there is a phone */
    var tel2 = text.match(/tel:\+?1?(\d{10})/);
    if (title && tel2) {
      return [{ name: title, street: '', suite: '', city: '', state: '', zip: '', phone: tel2[1] }];
    }
    return [];
  }

  /* The reader's markdown leaves link labels and nav text lying around;
     a "name" that is really a heading or a menu item should not win over
     the page title. */
  function looksNoiseName(n) {
    if (!n) return true;
    var t = n.replace(/^[#*\->\s]+/, '').trim();      /* markdown headings and bullets */
    if (/click here|online store|learn more|read more|sign up|subscribe|book now|schedule now/i.test(t)) return true;
    if (/[?!]$/.test(t)) return true;
    return !t || /^!?image\b/i.test(t) ||
           /^(get directions|directions|book|call|website|email|home|menu|location|hours|contact|about|services|our team|find a provider)/i.test(t) ||
           t.length > 70 || t.indexOf('](') >= 0;
  }

  /* ---------------- wiring ---------------- */

  function boot() {
    if (!$('srcSlots')) return;

    addSlot('BOTOX Cosmetic directory');
    addSlot('Google');

    $('btnSrcAdd').addEventListener('click', function () { addSlot(); });

    $('btnPasteXref').addEventListener('click', function () {
      var jobs = gather();
      if (!jobs.length) { msg('Paste at least one web address first.', 'err'); return; }

      var btn = $('btnPasteXref');
      btn.disabled = true;
      var sets = [], done = 0, notes = [];

      msg('Reading ' + jobs.length + ' site' + (jobs.length === 1 ? '' : 's') + '…');

      /* Different hosts, so there is no reason to queue them behind each
         other - that turned ten sites into ten round trips. Run a few at
         a time instead: fast, but not a thundering herd at the reader. */
      var LANES = 4;
      var queue = jobs.slice();

      function worker() {
        var job = queue.shift();
        if (!job) return Promise.resolve();
        return fetchPage(job.url).then(function (text) {
          var rows = fromPage(text, job.source);
          if (rows.length) sets.push({ source: job.source, rows: rows });
          else notes.push(job.source + ': nothing readable (the page may build its list with script)');
        }).catch(function (e) {
          notes.push(job.source + ': ' + ((e && e.message) || 'could not be read'));
        }).then(function () {
          done++;
          msg('Read ' + done + ' of ' + jobs.length + '…');
          return worker();
        });
      }

      var lanes = [];
      for (var L = 0; L < Math.min(LANES, jobs.length); L++) lanes.push(worker());

      Promise.all(lanes).then(function () {
        btn.disabled = false;
        if (!sets.length) { msg(notes.join(' · ') || 'Nothing could be read from those addresses.', 'err'); return; }

        var total = sets.reduce(function (n, x) { return n + x.rows.length; }, 0);
        var existing = (window.RP_FIND && window.RP_FIND.all()) || [];
        P.review = crossReference(sets, existing);
        renderReview(P.review);
        msg('Read ' + total + ' account' + (total === 1 ? '' : 's') + ' from ' +
            sets.length + ' of ' + jobs.length + ' sites.' +
            (notes.length ? ' ' + notes.join(' · ') : ''), notes.length ? 'warn' : 'ok');
      });
    });

    $('btnPasteSave').addEventListener('click', save);
    $('btnPasteAll').addEventListener('click', function () {
      var boxes = document.querySelectorAll('#pasteBody input[type=checkbox]');
      var anyOff = Array.prototype.slice.call(boxes).some(function (b) { return !b.checked; });
      Array.prototype.slice.call(boxes).forEach(function (b) { b.checked = anyOff; });
    });
  }

  window.RP_PASTE = { parse: parse, crossReference: crossReference, looksPerson: looksPerson };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

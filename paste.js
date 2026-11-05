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
  /* Sites write the state either way - "Lakewood, CO 80227" and
     "Lakewood, Colorado 80227" both turn up, sometimes on one site. */
  var STATES = {
    alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',
    connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',
    illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',
    maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',
    mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV',
    'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
    'north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',
    pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',
    tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA',
    'west virginia':'WV',wisconsin:'WI',wyoming:'WY','district of columbia':'DC'
  };
  function stateCode(v) {
    var t = clean(v);
    if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
    return STATES[t.toLowerCase()] || '';
  }
  var CSZ    = /([A-Za-z .'\-]+),\s*([A-Za-z]{2}|[A-Za-z]{4,20}(?:\s[A-Za-z]+)?)\.?\s+(\d{5})(?:-\d{4})?/;
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
  var STZIP = /\b([A-Z]{2}|[A-Za-z]{4,20})\.?\s+(\d{5})(?:-\d{4})?\b/;

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
        state = stateCode(m[1]); zip = m[2];
        raw = clean(raw.slice(0, m.index).replace(/[,]\s*$/, ''));
      } else {
        for (j = i + 1; j <= i + 3 && j < lines.length; j++) {
          var m2 = lines[j].match(CSZ);
          if (m2) { city = clean(m2[1]); state = stateCode(m2[2]); zip = m2[3]; break; }
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

      /* A second unit designator can trail the first and land in the city:
         "6200 S Syracuse Way Ste 260, Rm 15 Englewood" was parsing its
         town as "Rm 15 Englewood". */
      city = clean(city.replace(/^(?:ste|suite|unit|apt|bldg|fl|floor|rm|room|studio|#)\s*\.?\s*[A-Za-z0-9-]+\s+/i, ''));

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

  function gather(opts) {
    var jobs = [];
    for (var i = 1; i <= P.slots; i++) {
      var nameEl = $('srcName' + i), urlEl = $('srcUrl' + i);
      if (!nameEl || !urlEl) continue;
      var u = clean(urlEl.value);
      if (!u) continue;
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      var label = clean(nameEl.value);
      if (!label) { try { label = new URL(u).hostname.replace(/^www\./, ''); } catch (e) { label = 'Site ' + i; } }

      var t = templateFor(u);
      if (t && opts && opts.location) {
        u = t.build(opts);
        if (!clean(nameEl.value)) label = t.label;
      }
      jobs.push({ source: label, url: u, templated: !!t });
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

  /* ---------------- slots ---------------- */

  function addSlot(presetName, presetUrl) {
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
    /* The first row is BOTOX, so fill its address in. A labelled row with an
       empty box looks configured and searches nothing - gather() skips it. */
    if (presetUrl) url.value = presetUrl;

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

  /* Directory pages stream their listings in after loading, so the reader
     sometimes snapshots the empty shell - roughly one read in three came
     back at 5 KB with nothing in it while the same URL gave 32 KB on the
     next try. A short shell is the tell; read it again. */
  function fetchOnce(url) {
    return fetch(READER + url, { headers: { 'Accept': 'text/plain' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
  }

  function fetchPage(url, attempt) {
    attempt = attempt || 1;
    return fetchOnce(url).then(function (text) {
      var thin = text.length < 10000 && parse(text).length === 0;
      if (thin && attempt < 3) {
        return new Promise(function (go) { setTimeout(go, 1500); })
          .then(function () { return fetchPage(url, attempt + 1); });
      }
      return text;
    });
  }

  /* ---------------- site templates ---------------- */

  /* Directories have their own search URLs. Rather than make you paste
     one, the anchor and radius from step 1 are used to build it - which
     is the point of setting them there. A URL with a path or a query of
     its own is left alone: that is a specific page you chose. */
  var TEMPLATES = [
    {
      host: /(^|\.)botoxcosmetic\.com$/i,
      label: 'BOTOX Cosmetic directory',
      searchPaths: ['', '/', '/search'],
      /* the site only honours 2, 5 and 10 */
      build: function (p) {
        var d = p.radius <= 2 ? 2 : (p.radius <= 5 ? 5 : 10);
        return 'https://www.botoxcosmetic.com/search?location=' +
               encodeURIComponent(p.location) + '&distance=' + d + '-miles&page=1&sm=ALLE';
      }
    }
  ];

  function templateFor(url) {
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    for (var i = 0; i < TEMPLATES.length; i++) {
      var t = TEMPLATES[i];
      if (!t.host.test(u.hostname)) continue;
      if (u.search) return null;                                   /* they gave their own query */
      if (t.searchPaths.indexOf(u.pathname.replace(/\/$/, '')) < 0) return null;  /* a specific page */
      return t;
    }
    return null;
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

  /* ---------------- brand-list loader ---------------- */

  function msg(t, k) {
    var el = $('findMsg');
    if (!el) return;
    el.textContent = t || '';
    el.className = 'note' + (k ? ' ' + k : '');
  }

  /* Specialty is inferred from the business name as a starting point. It
     stays editable, and nothing here claims a clinician was verified. */
  function inferSpecialty(name) {
    var n = (name || '').toLowerCase(), out = [];
    if (/derm/.test(n)) out.push('Dermatology');
    if (/plastic surg/.test(n)) out.push('Plastic surgery');
    if (/facial plastic|facial aesthet/.test(n)) out.push('Facial plastics');
    if (/cosmetic surg/.test(n)) out.push('Cosmetic surgery');
    if (/ob.?gyn|midwif|women/.test(n)) out.push('OB/GYN');
    if (/dental|dentist/.test(n)) out.push('Dentistry');
    if (/\bent\b|sinus/.test(n)) out.push('ENT');
    if (!out.length && /med ?spa|medspa|aesthet|skin|laser|beauty|glow|rejuven/.test(n)) out.push('Med spa');
    return out;
  }

  function importBrandFile(file) {
    var user = window.RP_AUTH && window.RP_AUTH.user;
    var db = window.RP_DB;
    if (!user || !db) { msg('Sign in first.', 'err'); return; }

    var fr = new FileReader();
    fr.onload = function () {
      var rows;
      try { rows = JSON.parse(fr.result); } catch (e) { msg('That file is not valid JSON.', 'err'); return; }
      if (!Array.isArray(rows)) { msg('Expected a list of accounts.', 'err'); return; }

      var known = {};
      ((window.RP_FIND && window.RP_FIND.all()) || []).forEach(function (c) {
        known[(c.name || '').toLowerCase() + '|' + (c.zip || '')] = true;
      });

      var batch = [];
      rows.forEach(function (r) {
        var name = r.Name || r.name;
        if (!name) return;
        var zip = String(r.Zip || r.zip || '').slice(0, 5);
        var k = name.toLowerCase() + '|' + zip;
        if (known[k]) return;
        known[k] = true;

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

      if (!batch.length) { msg('Nothing new in that file - all of it is already loaded.', 'ok'); return; }

      msg('Loading ' + batch.length + ' accounts…');
      var chunks = [], i;
      for (i = 0; i < batch.length; i += 100) chunks.push(batch.slice(i, i + 100));

      chunks.reduce(function (pr, chunk) {
        return pr.then(function () { return db.from('candidates').insert(chunk); });
      }, Promise.resolve())
        .then(function () {
          msg('Loaded ' + batch.length + ' accounts.', 'ok');
          if (window.RP_FIND && window.RP_FIND.reload) window.RP_FIND.reload();
        })
        .catch(function (e) {
          msg('Load failed: ' + ((e && e.message) || 'unknown error'), 'err');
        });
    };
    fr.readAsText(file);
  }

  /* ---------------- exports ---------------- */

  /* Fetch every listed site, a few at a time. Different hosts, so there
     is no reason to queue them; four lanes keeps it quick without
     leaning on the reader. */
  function fetchAll(jobs, onProgress) {
    var sets = [], notes = [], done = 0;
    var queue = jobs.slice();

    function worker() {
      var job = queue.shift();
      if (!job) return Promise.resolve();
      return fetchPage(job.url).then(function (text) {
        var rows = fromPage(text, job.source);
        if (rows.length) sets.push({ source: job.source, rows: rows });
        else notes.push(job.source + ': nothing readable (the page builds its list with script)');
      }).catch(function (e) {
        notes.push(job.source + ': ' + ((e && e.message) || 'could not be read'));
      }).then(function () {
        done++;
        if (onProgress) onProgress(done, jobs.length);
        return worker();
      });
    }

    var lanes = [];
    for (var L = 0; L < Math.min(4, jobs.length); L++) lanes.push(worker());
    return Promise.all(lanes).then(function () { return { sets: sets, notes: notes }; });
  }

  function boot() {
    if (!$('srcSlots')) return;
    addSlot('BOTOX Cosmetic directory', 'https://www.botoxcosmetic.com/search');
    $('btnSrcAdd').addEventListener('click', function () { addSlot(); });
    $('btnBrandBrowse').addEventListener('click', function () { $('brandFile').click(); });
    $('brandFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importBrandFile(f);
      e.target.value = '';
    });
  }

  window.RP_SITES = {
    gather: gather,
    templateFor: templateFor,
    fetchAll: fetchAll,
    crossReference: crossReference,
    parse: parse,
    looksPerson: looksPerson,
    clean: clean
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

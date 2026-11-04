/* OrthoTrack — case store (Phase 0, task 0.3). Plain JS, no dependencies.

   window.OT.store is the one place case data is read or written:
     list()            every case (v2 shape), in seed order
     get(id)           one case, or null (no fallback to another case)
     update(id, patch) shallow merge: each top-level field in `patch` replaces the stored one. Null for an unknown id.
     create(data)      new case, id = ORT-<year of DEMO_TODAY>-<max NNNN among that year's ids + 1>, 4 digits. Returns the case.
     createFromIntake(info, stage)  the same, from the intake forms (Records and Case create screens). Keeps info.dob (ISO) when typed.
     currentId() / setCurrent(id)   the case that is open (null / false when unknown)
     reset()           back to the seed (for the demo)

   Helpers for the screens (task 0.5a), on window.OT:
     OT.current()        the open case (a copy), or null. Never a fallback to another case.
     OT.fmtDate(iso)     '4 Nov 2026' from '2026-11-04'; null or invalid gives ''
     OT.fmtRel(iso)      'today', '23 days ago', 'in 7 days' relative to OT.DEMO_TODAY; null or invalid gives ''
     OT.age(dob)         whole years at OT.DEMO_TODAY; null when dob is missing
     OT.empty(value)     the value when it is there, else OT.EMPTY ('Not recorded yet'). OT.empty() gives OT.EMPTY.
     OT.EMPTY, OT.DEMO_TODAY    the strings above, and the fixed demo day ('2026-11-04')

   Storage (localStorage, write-through on every change):
     orthotrack.en.cases.v2    { seedVersion: 4, cases: [ ...v2 cases ] }
     orthotrack.en.current.v1  current case id
   If the cases key is absent, unreadable, or has another seedVersion (an old browser: a bare array, or an older
   seed) the store is seeded from the demo data in the knowledge block. Bump SEED_VERSION when the seed changes.
   Seed dates are computed from DEMO_TODAY, a fixed day, never from the live clock (decision in DECISIONS_LOG).

   Read-through: window.OrthoCases (the old exports the screens read: seed, detail, chart, records, byId) is
   replaced here by views computed from the store, with the same shapes as before. Old exports stay the
   same shape until task 0.5 moves each screen to the store.

   How a screen reads the current case (screens run in the page window, see dc-runtime.js evalDcLogic,
   so window.OT is there without props):
     var c = window.OT.current();                  // the open case, or null
     var name = c ? c.patient.name : null;          // null when no case is open
     var shown = window.OT.empty(name);             // 'Not recorded yet' when missing
     var when = window.OT.fmtDate(c && c.nextVisit); // '' when no next visit
     // a screen with no case open shows the empty state; it never shows another case's data.
   The store is read on each render (store.get returns a copy). Writes: window.OT.store.update(id, patch).

   Must load after the OT-DATA block (window.OrthoKnowledge and window.OrthoCases) in index.html. */
(function () {
  'use strict';

  var CASES_KEY = 'orthotrack.en.cases.v2';
  var CURRENT_KEY = 'orthotrack.en.current.v1';
  var SEED_VERSION = 4;            // 2: Ehab's clinical data moved into his case, Dana's readings removed (task 0.4)
  //                                  3: Ehab's guardian, city, file number, occlusion/growth/dentition rows and media (task 0.5a)
  //                                  4: Ehab's media has no radiographs (ceph.png, opg.png are not in assets/; 404s) (task 0.5 WP-D)
  var DEMO_TODAY = '2026-11-04';   // fixed demo day for seed dates
  var DEMO_YEAR = 2026;            // dob = 1 Jan of (DEMO_YEAR - age)
  var DAY = 86400000;
  var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CASE_NUM_RE = /^ORT-\d{4}-(\d{4})$/;
  // gate facts stored in `flags`, with the one-letter codes the Dashboard still reads (R, P, A, D). No consent (C).
  var FLAG_CODES = [['R', 'records-complete'], ['P', 'problems-approved'], ['A', 'plan-approved'], ['D', 'debond-done']];

  var legacy = window.OrthoCases;
  var K = window.OrthoKnowledge;
  if (!legacy || !K) {
    console.error('OrthoTrack: case-store.js must load after the knowledge and seed block in index.html');
    return;
  }

  /* ---------- small helpers ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function isISO(v) { return typeof v === 'string' && ISO_RE.test(v); }
  function orNull(v) { return v === undefined || v === '' ? null : v; }
  function utcOf(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function isoOfUTC(ms) { var d = new Date(ms); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function addDays(iso, n) { return isoOfUTC(utcOf(iso) + n * DAY); }
  function daysBetween(from, to) { return Math.round((utcOf(to) - utcOf(from)) / DAY); }
  function liveToday() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function ageAt(dob, today) {
    var y = +today.slice(0, 4) - +dob.slice(0, 4);
    if (today.slice(5) < dob.slice(5)) y--;
    return y;
  }
  function dobFromAge(age) { return age === null || age === undefined ? null : (DEMO_YEAR - age) + '-01-01'; }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function canonId(id) {
    var s = String(id === null || id === undefined ? '' : id).trim();
    return /^\d{4}-\d{4}$/.test(s) ? 'ORT-' + s : s;
  }
  function stageOf(v) {
    var k = K.stageKey(v);
    return K.stageList.some(function (s) { return s.key === k; }) ? k : null;
  }
  function medicalEntry(name) {
    var cond = (K.conditions || []).filter(function (c) { return c[0] === name; })[0];
    return { key: slug(name), label: name, constraint: cond && cond[3] ? cond[3] : null, status: null, severity: null };
  }
  // "12y · Female · Open bite" → { age: 12, sex: 'Female', chip: 'Open bite' }
  function parseMeta(meta) {
    var parts = String(meta || '').split('·').map(function (t) { return t.trim(); });
    var age = /(\d+)\s*y/.exec(parts[0] || '');
    return {
      age: age ? +age[1] : null,
      sex: parts[1] || null,
      chip: parts[2] || null,
    };
  }

  /* ---------- the v2 case ---------- */
  function blankCase(cid) {
    return {
      id: cid || null,
      patient: { name: null, phone: null, dob: null, sex: null, guardian: null, city: null, fileNo: null },
      stage: null,
      stageBeforePause: null,
      pause: null,                       // { reason, note, since } or null
      nextVisit: null,                   // YYYY-MM-DD or null (never a time)
      nextKind: null,                    // visit type key of the next visit (from the old next.v)
      nextTasks: [],                     // planned items of the next visit (from the old next.plan)
      flags: [],                         // gate facts (records-complete, problems-approved, plan-approved, debond-done) and others
      alerts: [],                        // [{ tone: 'red'|'amber', text }] (from the old detail.al)
      medical: [],                       // [{ key, label, constraint }]
      complaint: { chip: null, words: null },
      measurements: {},                  // key → { baseline, current }
      problems: [],                      // HANDOVER section 5 shape (+ status: pending|progress|resolved)
      occlusion: [],                     // [{ label, value, severity: 0|1|2, note }] (the Summary's occlusion rows)
      growth: [],                        // [{ label, value, severity, note }] (growth and function rows)
      dentition: [],                     // [{ label, value, severity, note }] (dentition status rows)
      plan: null,                        // { extraction, appliance, mechanics, anchorage, ... } or null
      wire: null,                        // current upper archwire text or null
      appliance: [],                     // [[label, value]] (from the old detail.ap)
      compliance: [],                    // [[label, value, ok]] (from the old detail.cmp)
      carry: [],                         // planned last time but not done (from the old detail.carry)
      findings: [],                      // [{ text, tone }] (from the old chart.dx)
      treatment: { months: 0, estMonths: null, bonded: null, sessions: null, missedAt: [], phase: null },
      visits: [],                        // [{ date, kind, note, tasks }], newest first
      records: { photos: null, xray: { status: null }, exam: null, history: null, done: null, total: null, missing: [], files: [],
                 media: [] },              // [{ src, label, group }] photos and radiographs; media[0] is the hero photo
      midTreatment: false,
      screenDraft: { records: null, diagnosis: null },  // raw snapshots from Records and Diagnosis until task 0.5
    };
  }

  // Fills missing fields, migrates an old stage key, and drops a bad nextVisit. Every read and write goes through it.
  function normalize(raw) {
    var src = clone(raw) || {};
    var defaults = blankCase(src.id);            // a fresh copy: Object.assign below replaces nested objects
    var c = Object.assign(blankCase(src.id), src);
    ['patient', 'complaint', 'treatment', 'records', 'screenDraft'].forEach(function (k) {
      c[k] = Object.assign({}, defaults[k], src[k] || {});
    });
    c.stage = stageOf(src.stage);
    c.stageBeforePause = stageOf(src.stageBeforePause);
    if (!isISO(c.nextVisit)) c.nextVisit = null;
    c.visits = (c.visits || []).filter(function (v) { return v && isISO(v.date); });
    return c;
  }

  /* ---------- seed: the old demo data → v2 ---------- */
  // Ehab (ORT-2026-0148): clinical facts that were typed into Case Summary and Records Collection (task 0.4).
  // The screens keep their own copy until task 0.5 reads them from here. Values are the Summary's `values`.
  var EHAB_ID = 'ORT-2026-0148';
  var DANA_ID = 'ORT-2026-0144';
  var EHAB_MEASUREMENTS = {
    'ap-0': 79.3, 'ap-1': 82.8, 'ap-2': -3.5, 'ap-3': -6.7, 'ap-4': -3.3, 'ap-5': -4.7,
    'vert-0': 8.6, 'vert-1': 27.0, 'vert-2': 28.4, 'vert-3': 56.6,
    'dent-0': 119.9, 'dent-1': 99.4, 'dent-2': 126.4, 'dent-3': 7.6, 'dent-4': 113.7,
    'soft-0': 77.4, 'soft-1': 1.0
  };

  // Ehab's rows, copied from the Summary (task 0.5a). Values are the Summary's; the screens read them from here.
  var EHAB_OCCLUSION = [
    { label: 'Incisor relationship', value: 'Class III', severity: 1, note: 'Reverse incisor relationship' },
    { label: 'Molar — right', value: 'Class III ½ unit', severity: 1, note: 'Mesial molar relationship' },
    { label: 'Molar — left', value: 'Class III ½ unit', severity: 1, note: 'Mesial molar relationship — symmetric' },
    { label: 'Overjet', value: '-2.5 mm', severity: 2, note: 'Reverse overjet' },
    { label: 'Overbite', value: '1.5 mm', severity: 1, note: 'Reduced overbite' },
    { label: 'Crowding — upper', value: '+2.0 mm', severity: 1, note: 'Upper arch spacing' },
    { label: 'Crowding — lower', value: '-1.0 mm', severity: 0, note: 'Minimal lower crowding' }
  ];
  var EHAB_GROWTH = [
    { label: 'CVM stage', value: 'CS3', severity: 2, note: 'Growth peak now — functional window open' },
    { label: 'TMJ status', value: 'WNL', severity: 0, note: 'No joint limitation' },
    { label: 'CO–CR shift', value: '< 2 mm', severity: 0, note: 'No significant shift' },
    { label: 'Airway', value: 'Mouth breather', severity: 1, note: 'Review vertical pattern and tongue posture' }
  ];
  var EHAB_DENTITION = [
    { label: 'Impacted', value: '13', severity: 2, note: 'Palatal — needs 3D localisation' },
    { label: 'Missing', value: 'None', severity: 0, note: 'Full permanent dentition' },
    { label: 'Supernumerary', value: 'None', severity: 0, note: '' },
    { label: 'Third molars', value: 'Developing', severity: 0, note: 'Monitor at review' }
  ];
  var EHAB_MEDIA = [
    ['assets/p04.jpeg', 'Frontal repose', 'extraoral'], ['assets/p06.jpeg', 'Frontal smile', 'extraoral'],
    ['assets/p12.jpeg', 'Oblique repose', 'extraoral'], ['assets/p14.jpeg', 'Oblique smile', 'extraoral'],
    ['assets/p08.jpeg', 'Profile repose', 'extraoral'], ['assets/p10.jpeg', 'Profile smile', 'extraoral'],
    ['assets/p02.jpeg', 'Lips at rest', 'extraoral'], ['assets/p07.jpeg', 'Frontal occlusion', 'intraoral'],
    ['assets/p05.jpeg', 'Frontal open', 'intraoral'], ['assets/p03.jpeg', 'Upper occlusal', 'intraoral'],
    ['assets/p01.jpeg', 'Lower occlusal', 'intraoral'], ['assets/p09.jpeg', 'Right buccal', 'intraoral'],
    ['assets/p11.jpeg', 'Left buccal', 'intraoral'], ['assets/p13.jpeg', 'Buccal detail', 'intraoral'],
  ].map(function (m) { return { src: m[0], label: m[1], group: m[2] }; });

  function applyClinicalSeed(c) {
    if (c.id === EHAB_ID) {
      c.patient.dob = '2011-04-18';
      c.patient.phone = '+20 100 442 8817';
      c.patient.guardian = 'Mohammed Hosny';
      c.patient.city = 'Cairo · Egypt';
      c.patient.fileNo = '005025';
      c.medical = ['Nickel allergy', 'Mouth breathing'].map(medicalEntry);
      c.medical[0].status = 'Confirmed'; c.medical[0].severity = 2;
      c.medical[1].status = 'Present'; c.medical[1].severity = 1;
      c.occlusion = EHAB_OCCLUSION.map(function (r) { return Object.assign({}, r); });
      c.growth = EHAB_GROWTH.map(function (r) { return Object.assign({}, r); });
      c.dentition = EHAB_DENTITION.map(function (r) { return Object.assign({}, r); });
      c.records.media = EHAB_MEDIA.map(function (m) { return Object.assign({}, m); });
      // captured at records time: no later reading yet, so baseline and current are the same value
      Object.keys(EHAB_MEASUREMENTS).forEach(function (k) {
        c.measurements[k] = { baseline: EHAB_MEASUREMENTS[k], current: EHAB_MEASUREMENTS[k] };
      });
      c.records.exam = { 'occ-incisor-incisorRel': 'Class III' };
      c.records.files = [
        { name: 'Most important cephalometric readings.pdf', type: 'PDF', source: 'Asnan Scan', date: '2026-07-31', size: '820 KB' },
        { name: 'Ehab Mohammed Hosny — CBCT.pdf', type: 'PDF', source: 'Asnan Scan', date: '2026-07-31', size: '1.4 MB' }
      ];
    }
    if (c.id === DANA_ID) {
      // Dana has no records, no measurements and no medical alerts (audit). Her two legacy readings
      // (overjet, crossbite) are not among the 17 measurements, so they are removed with the rest.
      c.measurements = {};
      c.medical = [];
    }
    return c;
  }

  function fromSeed(s) {
    var full = 'ORT-' + s.id;
    var d = legacy.detail[full] || {};
    var ch = legacy.chart[full] || null;
    var rec = legacy.records[full] || null;
    var m = parseMeta(s.meta);
    var last = s.last || {};
    var next = s.next || {};
    var c = blankCase(full);

    c.patient = { name: s.n, phone: null, dob: dobFromAge(m.age), sex: m.sex };
    c.stage = stageOf(s.stage);
    c.nextVisit = next.off === null || next.off === undefined ? null : addDays(DEMO_TODAY, next.off);
    c.nextKind = next.v || null;
    c.nextTasks = (next.plan || []).slice();
    c.flags = FLAG_CODES.filter(function (f) { return (s.f || []).indexOf(f[0]) >= 0; }).map(function (f) { return f[1]; });
    c.alerts = (d.al || []).map(function (a) { return { tone: a[0], text: a[1] }; });
    c.medical = ch ? (ch.med || []).map(medicalEntry) : [];
    c.complaint = { chip: m.chip, words: orNull(d.cc) };
    if (ch) Object.keys(ch.meas || {}).forEach(function (k) {
      var p = ch.meas[k];
      c.measurements[k] = { baseline: orNull(p[0]), current: orNull(p[1]) };
    });
    c.problems = ch ? (ch.problems || []).map(function (p) {
      return { dimension: null, description: p[0], severity: null, certainty: null, evidence: [], priority: null,
               decision: null, decisionReason: null, review: null, status: p[1] };
    }) : [];
    c.plan = ch && ch.plan ? { extraction: ch.plan.ex, appliance: ch.plan.appl, mechanics: ch.plan.mech, anchorage: ch.plan.anch } : null;
    c.appliance = (d.ap || []).map(function (a) { return [a[0], a[1]]; });
    var upper = c.appliance.filter(function (a) { return a[0] === 'UPPER'; })[0];
    c.wire = upper ? upper[1] : null;
    c.compliance = (d.cmp || []).map(function (r) { return [r[0], r[1], r[2]]; });
    c.carry = (d.carry || []).slice();
    c.findings = ch ? (ch.dx || []).map(function (x) { return { text: x[0], tone: x[1] }; }) : [];
    c.treatment = {
      months: s.mo || 0,
      estMonths: d.est === undefined ? null : d.est,
      bonded: ch && ch.bonded !== undefined ? ch.bonded : null,
      sessions: ch && ch.sessions !== undefined ? ch.sessions : null,
      missedAt: ch && ch.missedAt ? ch.missedAt.slice() : [],
      phase: ch && ch.phase ? ch.phase : null,
    };
    c.visits = last.items !== undefined || last.d !== undefined
      ? [{ date: addDays(DEMO_TODAY, -(last.d || 0)), kind: null, note: null, tasks: (last.items || []).slice() }]
      : [];
    c.records = rec
      ? { photos: null, xray: { status: null }, exam: null, history: null, done: rec.done, total: rec.total, missing: rec.missing.slice(), files: [] }
      : blankCase().records;
    return normalize(applyClinicalSeed(c));
  }

  function seedAll() { return legacy.seed.map(fromSeed); }

  /* ---------- storage ---------- */
  var cache = null;
  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* blocked: memory still works */ } }
  function storageDel(key) { try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  function all() {
    if (cache) return cache;
    var raw = storageGet(CASES_KEY);
    var arr = null;
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.seedVersion === SEED_VERSION && Array.isArray(parsed.cases)) arr = parsed.cases;
      } catch (e) { arr = null; }
    }
    if (!arr) {
      arr = seedAll();
      storageSet(CASES_KEY, JSON.stringify({ seedVersion: SEED_VERSION, cases: arr }));
    }
    cache = arr.map(normalize);
    return cache;
  }
  function save() { storageSet(CASES_KEY, JSON.stringify({ seedVersion: SEED_VERSION, cases: cache })); }
  function indexOf(id) {
    var key = canonId(id);
    var list = all();
    for (var i = 0; i < list.length; i++) if (list[i].id === key) return i;
    return -1;
  }
  // per-year sequence: the year is DEMO_TODAY's (never the clock), and only that year's ids count
  function nextId() {
    var year = DEMO_TODAY.slice(0, 4);
    var max = 0;
    all().forEach(function (c) {
      var m = CASE_NUM_RE.exec(c.id || '');
      if (m && m[0].slice(4, 8) === year && +m[1] > max) max = +m[1];
    });
    return 'ORT-' + year + '-' + ('000' + (max + 1)).slice(-4);
  }

  /* ---------- the intake forms → a new case ---------- */
  function fromIntake(info, stage) {
    var info2 = info || {};
    var age = /(\d+)/.exec(String(info2.ageText || ''));
    var names = (info2.conditions || []).map(function (c) { return typeof c === 'string' ? c : c && c.en; }).filter(Boolean);
    return {
      patient: {
        name: orNull(info2.name) || 'New patient',
        phone: orNull(info2.phone || info2.guardianPhone),
        // the typed date when it is a real ISO day; the age (1 Jan of DEMO_YEAR - age) only when none was typed
        dob: isISO(info2.dob) && realISO(info2.dob) ? info2.dob : dobFromAge(age ? +age[1] : null),
        sex: orNull(info2.gender),
      },
      stage: stageOf(String(stage || 'consultation').toLowerCase()),
      complaint: { chip: orNull(info2.complaint), words: orNull(info2.complaintText) },
      medical: names.map(medicalEntry),
    };
  }

  /* ---------- the public store ---------- */
  var store = {
    list: function () { return all().map(clone); },

    get: function (id) {
      var i = indexOf(id);
      return i < 0 ? null : clone(cache[i]);
    },

    update: function (id, patch) {
      var i = indexOf(id);
      if (i < 0) return null;
      var next = normalize(Object.assign({}, clone(cache[i]), clone(patch || {}), { id: cache[i].id }));
      cache[i] = next;
      save();
      return clone(next);
    },

    create: function (data) {
      var cid = nextId();
      var c = normalize(Object.assign(blankCase(cid), clone(data || {}), { id: cid }));
      all().push(c);
      save();
      return clone(c);
    },

    createFromIntake: function (info, stage) {
      return store.create(fromIntake(info, stage));
    },

    currentId: function () {
      var v = storageGet(CURRENT_KEY);
      if (!v) return null;
      var i = indexOf(v);
      return i < 0 ? null : cache[i].id;
    },

    setCurrent: function (id) {
      var i = indexOf(id);
      if (i < 0) return false;
      storageSet(CURRENT_KEY, cache[i].id);
      return true;
    },

    reset: function () {
      storageDel(CASES_KEY);
      storageDel(CURRENT_KEY);
      cache = null;
      all();
      return true;
    },
  };

  /* ---------- views: the old shapes, computed from the store ---------- */
  function ageOf(c, today) { return isISO(c.patient.dob) ? ageAt(c.patient.dob, today) : null; }
  function metaOf(c, today) {
    var age = ageOf(c, today);
    return [age === null ? '' : age + 'y', c.patient.sex || '', c.complaint.chip || ''].filter(Boolean).join(' · ');
  }

  // one row of the old seed: { id, n, p, meta, stage, mo, f, last, next }
  function toSeedRow(c, today) {
    var first = c.visits[0] || null;
    return {
      id: c.id.replace(/^ORT-/, ''),
      n: c.patient.name,
      p: null,
      meta: metaOf(c, today),
      stage: c.stage,
      mo: c.treatment.months || 0,
      f: FLAG_CODES.filter(function (f) { return c.flags.indexOf(f[1]) >= 0; }).map(function (f) { return f[0]; }),
      last: { d: first ? daysBetween(first.date, today) : 0, items: first ? first.tasks.slice() : [] },
      next: {
        off: c.nextVisit ? daysBetween(today, c.nextVisit) : null,
        t: '',
        v: c.nextKind || '',
        plan: c.nextTasks.slice(),
      },
    };
  }

  // the old detail[id]: { cc, est, al, ap, cmp, carry }; a key appears only when it has something
  function toDetail(c) {
    var d = {};
    if (c.complaint.words) d.cc = c.complaint.words;
    if (c.treatment.estMonths !== null && c.treatment.estMonths !== undefined) d.est = c.treatment.estMonths;
    if (c.alerts.length) d.al = c.alerts.map(function (a) { return [a.tone, a.text]; });
    if (c.appliance.length) d.ap = c.appliance.map(function (a) { return a.slice(); });
    if (c.compliance.length) d.cmp = c.compliance.map(function (r) { return r.slice(); });
    if (c.carry.length) d.carry = c.carry.slice();
    return d;
  }

  // the old chart[id]; undefined for a case that never had one
  function toChart(c) {
    var t = c.treatment;
    var meas = {};
    Object.keys(c.measurements).forEach(function (k) {
      var v = c.measurements[k];
      meas[k] = [v.baseline === null || v.baseline === undefined ? '' : v.baseline,
                 v.current === null || v.current === undefined ? '' : v.current];
    });
    var has = c.findings.length || c.problems.length || c.plan || c.medical.length || t.sessions !== null || Object.keys(meas).length;
    if (!has) return undefined;
    var out = {
      dx: c.findings.map(function (f) { return [f.text, f.tone]; }),
      plan: c.plan ? { ex: c.plan.extraction, appl: c.plan.appliance, mech: c.plan.mechanics, anch: c.plan.anchorage } : null,
      phase: t.phase,
      med: c.medical.map(function (m) { return m.label; }),
    };
    if (t.sessions !== null) {
      out.bonded = t.bonded;
      out.sessions = t.sessions;
      out.missedAt = t.missedAt.slice();
    }
    out.problems = c.problems.map(function (p) { return [p.description, p.status]; });
    out.meas = meas;
    return out;
  }

  // the old records[id]: { done, total, missing }; undefined when there is no record set
  function toRecords(c) {
    var r = c.records;
    if (r.done === null || r.done === undefined) return undefined;
    return { done: r.done, total: r.total, missing: r.missing.slice() };
  }

  function legacyById(id) {
    var i = indexOf(id);
    if (i < 0) return null;
    var c = cache[i];
    var today = liveToday();
    return {
      seed: toSeedRow(c, today),
      id: c.id,
      name: c.patient.name,
      meta: metaOf(c, today),
      stage: c.stage,
      mo: c.treatment.months || 0,
      detail: toDetail(c),
      chart: toChart(c) || {},
      records: toRecords(c) || null,
    };
  }

  function forEachCase(fn) {
    var today = liveToday();
    all().forEach(function (c) { fn(c, today); });
  }

  window.OrthoCases = {
    get seed() {
      var out = [];
      forEachCase(function (c, today) { out.push(toSeedRow(c, today)); });
      return out;
    },
    get detail() {
      var out = {};
      forEachCase(function (c) { out[c.id] = toDetail(c); });
      return out;
    },
    get chart() {
      var out = {};
      forEachCase(function (c) { var ch = toChart(c); if (ch) out[c.id] = ch; });
      return out;
    },
    get records() {
      var out = {};
      forEachCase(function (c) { var r = toRecords(c); if (r) out[c.id] = r; });
      return out;
    },
    byId: legacyById,
    history: legacy.history,         // still builds the visit log from chart and detail (uses the live clock)
    applianceLog: legacy.applianceLog,
  };

  /* ---------- helpers for the screens (task 0.5a) ---------- */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var EMPTY = 'Not recorded yet';
  // a real calendar day in YYYY-MM-DD (2026-02-30 is not)
  function realISO(v) {
    if (!isISO(v)) return false;
    var p = v.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.getUTCFullYear() === +p[0] && d.getUTCMonth() === +p[1] - 1 && d.getUTCDate() === +p[2];
  }
  function isPresent(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (typeof v === 'number') return !isNaN(v);
    if (Array.isArray(v)) return v.length > 0;
    return true;
  }

  window.OT = window.OT || {};
  window.OT.store = store;
  window.OT.EMPTY = EMPTY;
  window.OT.DEMO_TODAY = DEMO_TODAY;
  window.OT.current = function () {
    var id = store.currentId();
    return id ? store.get(id) : null;
  };
  window.OT.fmtDate = function (iso) {
    if (!realISO(iso)) return '';
    var p = iso.split('-');
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  };
  window.OT.fmtRel = function (iso) {
    if (!realISO(iso)) return '';
    var d = daysBetween(DEMO_TODAY, iso);
    if (d === 0) return 'today';
    var n = Math.abs(d);
    var unit = n === 1 ? 'day' : 'days';
    return d < 0 ? n + ' ' + unit + ' ago' : 'in ' + n + ' ' + unit;
  };
  window.OT.age = function (dob) {
    return realISO(dob) ? ageAt(dob, DEMO_TODAY) : null;
  };
  window.OT.empty = function (value) {
    return isPresent(value) ? value : EMPTY;
  };
})();

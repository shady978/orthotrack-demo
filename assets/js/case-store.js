/* OrthoTrack — case store (Phase 0, task 0.3). Plain JS, no dependencies.

   window.OT.store is the one place case data is read or written:
     list()            every case (v2 shape), in seed order
     get(id)           one case, or null (no fallback to another case)
     update(id, patch) shallow merge: each top-level field in `patch` replaces the stored one. Null for an unknown id.
     create(data)      new case, id = ORT-<this year>-<max existing number + 1>. Returns the case.
     createFromIntake(info, stage)  the same, from the intake forms (Records and Case create screens).
     currentId() / setCurrent(id)   the case that is open (null / false when unknown)
     reset()           back to the seed (for the demo)

   Storage (localStorage, write-through on every change):
     orthotrack.en.cases.v2    array of v2 cases
     orthotrack.en.current.v1  current case id
   If the cases key is absent (or unreadable) the store is seeded once from the demo data in the knowledge block.
   Seed dates are computed from DEMO_TODAY, a fixed day, never from the live clock (decision in DECISIONS_LOG).

   Read-through: window.OrthoCases (the old exports the screens read: seed, detail, chart, records, byId) is
   replaced here by views computed from the store, with the same shapes as before. Old exports stay the
   same shape until task 0.5 moves each screen to the store.

   Must load after the OT-DATA block (window.OrthoKnowledge and window.OrthoCases) in index.html. */
(function () {
  'use strict';

  var CASES_KEY = 'orthotrack.en.cases.v2';
  var CURRENT_KEY = 'orthotrack.en.current.v1';
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
    return { key: slug(name), label: name, constraint: cond && cond[3] ? cond[3] : null };
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
      patient: { name: null, phone: null, dob: null, sex: null },
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
      plan: null,                        // { extraction, appliance, mechanics, anchorage, ... } or null
      wire: null,                        // current upper archwire text or null
      appliance: [],                     // [[label, value]] (from the old detail.ap)
      compliance: [],                    // [[label, value, ok]] (from the old detail.cmp)
      carry: [],                         // planned last time but not done (from the old detail.carry)
      findings: [],                      // [{ text, tone }] (from the old chart.dx)
      treatment: { months: 0, estMonths: null, bonded: null, sessions: null, missedAt: [], phase: null },
      visits: [],                        // [{ date, kind, note, tasks }], newest first
      records: { photos: null, xray: { status: null }, exam: null, history: null, done: null, total: null, missing: [] },
      midTreatment: false,
      screenDraft: { records: null, diagnosis: null },  // raw snapshots from Records and Diagnosis until task 0.5
    };
  }

  // Fills missing fields, migrates an old stage key, and drops a bad nextVisit. Every read and write goes through it.
  function normalize(raw) {
    var src = clone(raw) || {};
    var base = blankCase(src.id);
    var c = Object.assign(base, src);
    ['patient', 'complaint', 'treatment', 'records', 'screenDraft'].forEach(function (k) {
      c[k] = Object.assign({}, base[k], src[k] || {});
    });
    c.stage = stageOf(src.stage);
    c.stageBeforePause = stageOf(src.stageBeforePause);
    if (!isISO(c.nextVisit)) c.nextVisit = null;
    c.visits = (c.visits || []).filter(function (v) { return v && isISO(v.date); });
    return c;
  }

  /* ---------- seed: the old demo data → v2 ---------- */
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
      ? { photos: null, xray: { status: null }, exam: null, history: null, done: rec.done, total: rec.total, missing: rec.missing.slice() }
      : blankCase().records;
    return normalize(c);
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
    if (raw) { try { arr = JSON.parse(raw); } catch (e) { arr = null; } }
    if (!Array.isArray(arr)) {
      arr = seedAll();
      storageSet(CASES_KEY, JSON.stringify(arr));
    }
    cache = arr.map(normalize);
    return cache;
  }
  function save() { storageSet(CASES_KEY, JSON.stringify(cache)); }
  function indexOf(id) {
    var key = canonId(id);
    var list = all();
    for (var i = 0; i < list.length; i++) if (list[i].id === key) return i;
    return -1;
  }
  function nextId() {
    var max = 0;
    all().forEach(function (c) {
      var m = CASE_NUM_RE.exec(c.id || '');
      if (m && +m[1] > max) max = +m[1];
    });
    return 'ORT-' + new Date().getFullYear() + '-' + ('000' + (max + 1)).slice(-4);
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
        dob: dobFromAge(age ? +age[1] : null),
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

  window.OT = window.OT || {};
  window.OT.store = store;
})();

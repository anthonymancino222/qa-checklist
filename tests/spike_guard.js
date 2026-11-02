/* Spike guard (run by smoke.js; also: node tests/spike_guard.js).
 * Drives the REAL Worker code (cloudflare-backend/src/index.js) against a fake database that counts every row
 * written/read, with the REAL app (index.html) in jsdom on a virtual clock, through:
 *   1. a normal 20-job shift (both gluers + other stations): write/request budgets, no oversize record ever stored
 *   2. a 3-hour photo-upload outage with 4 jobs holding embedded photos: nothing oversize is sent, held jobs cost
 *      ZERO network, photo retries stay inside the backoff budget, everything heals + syncs once uploads recover,
 *      and no photo is ever lost locally while waiting
 *   3. the Worker backstop (oversize bulk/PUT) and the health endpoint
 *   4. sharing a draft: embedded photos are uploaded first, never sent in the record
 * A budget failure here means a change would have caused a Cloudflare usage spike. */
const fs = require('fs'), path = require('path'), os = require('os');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(process.env.QA_HTML || path.join(ROOT, 'index.html'), 'utf8'); // QA_HTML: compare against an older copy of the app

let fails = 0;
const ck = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'test-secret';
const BIG = 'data:image/jpeg;base64,';
const photoOf = (tag, chars) => BIG + tag + 'A'.repeat(chars - tag.length);

function fakeDB() {
  const rows = new Map(), stats = { written: 0, read: 0, queries: 0, perId: {} };
  function exec(sql, a) {
    stats.queries++;
    if (/^INSERT INTO records/.test(sql)) { rows.set(a[0], { id: a[0], type: a[1], data: a[2], updated_at: a[3], deleted: 0 }); stats.written++; stats.perId[a[0]] = (stats.perId[a[0]] || 0) + 1; return { results: [] }; }
    if (/^UPDATE records SET deleted = 1/.test(sql)) { const r = rows.get(a[1]); if (r) { r.deleted = 1; r.updated_at = a[0]; stats.written++; } return { results: [] }; }
    if (/WHERE type = \? AND updated_at > \?/.test(sql)) { stats.read += rows.size; return { results: [...rows.values()].filter((r) => r.type === a[0] && r.updated_at > a[1]).sort((x, y) => x.updated_at - y.updated_at) }; }
    if (/WHERE type = \? AND id = \?/.test(sql)) { stats.read += 1; return { results: [...rows.values()].filter((r) => r.type === a[0] && r.id === a[1]) }; }
    if (/GROUP BY type/.test(sql)) {
      stats.read += rows.size; const g = {};
      rows.forEach((r) => { const t = g[r.type] || (g[r.type] = { type: r.type, n: 0, bytes: 0, maxBytes: 0, touched24h: 0, big: 0 }); t.n++; t.bytes += r.data.length; t.maxBytes = Math.max(t.maxBytes, r.data.length); if (r.updated_at > a[0]) t.touched24h++; if (r.data.length > a[1]) t.big++; });
      return { results: Object.values(g) };
    }
    if (/ORDER BY size DESC LIMIT 5/.test(sql)) { stats.read += rows.size; return { results: [...rows.values()].map((r) => ({ id: r.id, type: r.type, size: r.data.length })).sort((x, y) => y.size - x.size).slice(0, 5) }; }
    throw new Error('fake D1: unhandled SQL ' + sql);
  }
  return { rows, stats, prepare(sql) { return { run: async () => exec(sql, []), all: async () => exec(sql, []), bind(...a) { return { sql, args: a, run: async () => exec(sql, a), all: async () => exec(sql, a) }; } }; }, batch: async (st) => st.map((s) => exec(s.sql, s.args)) };
}

async function loadWorker() {
  const f = path.join(os.tmpdir(), 'qa_worker_under_test.mjs');
  fs.writeFileSync(f, fs.readFileSync(path.join(ROOT, 'cloudflare-backend', 'src', 'index.js'), 'utf8'));
  return (await import(pathToFileURL(f).href + '?t=' + Date.now())).default;
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function mintToken() {
  const now = Math.floor(Date.now() / 1000);
  const p = b64url(JSON.stringify({ e: 'anthony.mancino@moquinpress.com', n: 'T', iat: now, exp: now + 86400 * 100 }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('qs1.' + p));
  return 'qs1.' + p + '.' + b64url(sig);
}

// One simulated world: Worker + fake D1 + photo endpoint + counters.
async function world() {
  const worker = await loadWorker(), db = fakeDB(), token = await mintToken();
  const env = { DB: db, SESSION_SECRET: SECRET };
  const W = { worker, db, env, token, photoMode: 'ok', photos: 0, photoAttempts: {}, photoFails: 0, req: { bulk: 0, bulkBytes: 0, reconcile: 0, pull: 0, put: 0, del: 0, other: 0 }, bulkLog: [] };
  W.call = (method, p, body) => worker.fetch(new Request('https://worker.test' + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) }), env);
  return W;
}

function makeApp(W, localJobs) {
  const vt = { now: Date.now(), timers: [], seq: 0, inflight: 0 };
  const dom = new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new VirtualConsole(), beforeParse(w) {
    w.localStorage.setItem('qa_local_session_v1', JSON.stringify({ name: 'T', email: 'anthony.mancino@moquinpress.com', idToken: 'x', sessionToken: W.token, sessionExp: vt.now + 30 * 864e5, sessionEmail: 'anthony.mancino@moquinpress.com', sessionRefreshedAt: vt.now, lastActivityAt: vt.now }));
    if (localJobs) w.localStorage.setItem('moquin-qa-inprogress', JSON.stringify(localJobs));
    w.setTimeout = (fn, ms, ...a) => { const id = ++vt.seq; vt.timers.push({ id, at: vt.now + Math.max(0, +ms || 0), fn: () => fn(...a) }); return id; };
    w.setInterval = (fn, ms, ...a) => { ms = +ms || 0; if (ms < 5000) return ++vt.seq; /* UI clocks/animations: not part of the sync story */ const id = ++vt.seq; vt.timers.push({ id, at: vt.now + ms, every: ms, fn: () => fn(...a) }); return id; };
    w.clearTimeout = w.clearInterval = (id) => { vt.timers = vt.timers.filter((t) => t.id !== id); };
    w.Date.now = () => vt.now;
    /* Responses are read to the end before the app sees them, so the app's follow-up work is pure microtasks and the virtual clock can never outrun an in-flight request chain */
    w.fetch = async (u, o) => { vt.fetches = (vt.fetches || 0) + 1; vt.inflight++; try { const res = await fetchImpl(u, o); const text = await res.text(); return { ok: res.ok, status: res.status, headers: res.headers, text: async () => text, json: async () => JSON.parse(text) }; } finally { vt.inflight--; } };
    const fetchImpl = async (u, o) => {
      u = String(u); o = o || {}; const m = o.method || 'GET', p = u.replace(/^https?:\/\/[^/]+/, '');
      if (p.indexOf('/photo') === 0) {
        if (m === 'GET') return new Response('img', { status: 200 });
        let body = {}; try { body = JSON.parse(o.body); } catch (e) {}
        const key = String(body.dataBase64 || '').slice(0, 24);
        W.photoAttempts[key] = (W.photoAttempts[key] || 0) + 1;
        if (W.photoMode === 'throw') { W.photoFails++; throw new TypeError('Failed to fetch'); }
        if (W.photoMode === 'fail') { W.photoFails++; return new Response('{"error":"x"}', { status: 502 }); }
        W.photos++;
        return new Response(JSON.stringify({ id: 'F' + W.photos, url: '/photo/F' + W.photos }), { status: 200 });
      }
      if (!/^\/(records|records-meta|auth|admin)/.test(p)) return new Response('{}', { status: 404 });
      if (m === 'POST' && p === '/records/bulk') { W.req.bulk++; W.req.bulkBytes += String(o.body).length; try { W.bulkLog.push(JSON.parse(o.body).records.map((r) => r.id)); } catch (e) {} }
      else if (m === 'GET' && /^\/records\/[^?]+\?/.test(p)) W.req.reconcile++;
      else if (m === 'GET') W.req.pull++;
      else if (m === 'PUT') W.req.put++;
      else if (m === 'DELETE') W.req.del++;
      else W.req.other++;
      return W.worker.fetch(new Request('https://worker.test' + p, { method: m, headers: o.headers, body: o.body }), W.env);
    };
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {}; w.print = () => {}; w.HTMLElement.prototype.scrollIntoView = function () {};
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,SIG';
    w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }; w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  } });
  const drain = async () => { /* wait until the network is quiet for several consecutive checks, so virtual time never outruns an in-flight push chain */ let quiet = 0, n = 0; vt.fetches = vt.fetches || 0; let last = -1; while (quiet < 2 && n++ < 3000) { await realSleep(1); if (vt.inflight === 0 && vt.fetches === last) quiet++; else quiet = 0; last = vt.fetches; } };
  const advance = async (ms) => {
    const end = vt.now + ms;
    await drain(); // let whatever the caller just did (e.g. a save and its push) finish before time moves on
    while (vt.now < end) {
      const nextAt = Math.min(end, ...vt.timers.map((t) => t.at));
      vt.now = Math.max(vt.now, nextAt);
      const due = vt.timers.filter((t) => t.at <= vt.now).sort((a, b) => a.at - b.at || a.id - b.id);
      due.forEach((t) => { if (t.every) t.at = vt.now + t.every; else vt.timers = vt.timers.filter((x) => x.id !== t.id); });
      for (const t of due) { try { t.fn(); } catch (e) {} }
      await drain();
    }
  };
  return { dom, w: dom.window, vt, advance, drain };
}

const mkJob = (id, station, over) => Object.assign({ id, jobNumber: id.toUpperCase(), station, process: 'production', customer: 'Cust', productNumber: 'P-' + id, timestamp: 'Nov 2, 2026 at 05:08:44 AM', mrPhoto: 'https://qa-checklist-backend.anthony-mancino2.workers.dev/photo/BASE', stageHistory: [{ stage: 'make_ready', label: 'MR', ts: 'x', data: { photo: true } }] }, over || {});
const serverJobs = (W) => [...W.db.rows.values()].filter((r) => r.type === 'job');
const maxSize = (W) => Math.max(0, ...[...W.db.rows.values()].map((r) => r.data.length));

(async () => {
  const STATIONS = ['Long Gluer', 'Short Gluer', 'Bindery Cutter', 'Pressroom Cutter', 'Kama Foil Press', 'Packing'];
  const HOUR = 3600 * 1000;

  // ───────── 1) normal shift ─────────
  console.log('\n-- 1. normal 20-job shift (8 hours, both gluers + other stations)');
  let W = await world(), app = makeApp(W); let w = app.w;
  await app.advance(40 * 1000);
  const w0 = W.db.stats.written;
  for (let i = 0; i < 20; i++) {
    w.eval('ipAdd(' + JSON.stringify(mkJob('shift' + i, STATIONS[i % STATIONS.length])) + ')');
    await app.advance(10 * 60 * 1000);
    w.eval("ipUpdate('shift" + i + "', { process: 'qa_pending' })"); await app.advance(15 * 60 * 1000);
    w.eval("ipUpdate('shift" + i + "', { process: 'finished', finishedAt: 'Nov 2, 2026 at 11:00:00 AM' })"); await app.advance(15 * 60 * 1000);
  }
  await app.advance(2 * HOUR);
  const wrote = W.db.stats.written - w0, jobsOnServer = serverJobs(W).length;
  console.log('   rows written: ' + wrote + ' | bulk pushes: ' + W.req.bulk + ' | reconcile GETs: ' + W.req.reconcile + ' | pulls: ' + W.req.pull + ' | deletes: ' + W.req.del);
  ck(jobsOnServer === 20, 'all 20 jobs reached the server (' + jobsOnServer + ')');
  ck(wrote <= 20 * 5, 'rows written for the shift within budget: ' + wrote + ' <= 100 (about 3 per job)');
  ck(Math.max(0, ...Object.values(W.db.stats.perId)) <= 6, 'no single job written more than 6 times (max ' + Math.max(0, ...Object.values(W.db.stats.perId)) + ')');
  ck(W.req.del === 0, 'zero deletes sent');
  ck(W.req.bulk + W.req.reconcile + W.req.pull <= 1500, 'total sync requests for 8 hours within budget: ' + (W.req.bulk + W.req.reconcile + W.req.pull) + ' <= 1500');
  ck(maxSize(W) < 150000, 'largest stored record ' + maxSize(W) + ' chars (< 150000)');
  // a multi-product submit saves once per product in a tight loop: each product must be written once, not once per later save
  {
    const Wm = await world(), am = makeApp(Wm); await am.advance(40 * 1000);
    const before = Wm.db.stats.written;
    for (let i = 0; i < 6; i++) am.w.eval('ipAdd(' + JSON.stringify(mkJob('multi' + i, 'Bindery Cutter')) + ')');
    await am.advance(2 * 60 * 1000);
    const wr = Wm.db.stats.written - before;
    console.log('   6-product submit: rows written ' + wr);
    ck(serverJobs(Wm).length === 6, 'all 6 products reached the server');
    ck(wr <= 8, 'a 6-product submit writes about 6 rows, not 21: ' + wr + ' <= 8');
    am.w.close();
  }
  w.close();

  // ───────── 2) upload outage ─────────
  console.log('\n-- 2. photo-upload outage: 4 jobs with embedded photos, uploads failing for 3 hours');
  W = await world(); W.photoMode = 'throw'; app = makeApp(W); w = app.w;
  await app.advance(40 * 1000);
  const tags = ['T1', 'T2', 'T3', 'T4'];
  tags.forEach((t, i) => {
    const photo = photoOf(t, 420000);
    w.eval('window.__p' + i + ' = ' + JSON.stringify(photo) + ';');
    w.eval('ipAdd(Object.assign(' + JSON.stringify(mkJob('big' + i, i % 2 ? 'Short Gluer' : 'Long Gluer')) + ', { mrPhoto: window.__p' + i + ' })); _backgroundUploadPhoto("big' + i + '", window.__p' + i + ', "mrPhoto");');
  });
  w.eval('ipAdd(' + JSON.stringify(mkJob('small1', 'Packing')) + ')'); // a normal job in the same storm must still sync
  await app.advance(60 * 1000);
  const bulkBefore = W.req.bulk;
  const reconBefore = W.req.reconcile;
  await app.advance(3 * HOUR);
  const bigOnServer = serverJobs(W).filter((r) => /^big/.test(r.id)).length;
  ck(bigOnServer === 0, 'no held job reached the server during the outage');
  ck(maxSize(W) < 150000, 'nothing oversize stored (largest ' + maxSize(W) + ')');
  ck(serverJobs(W).some((r) => r.id === 'small1'), 'a normal job still synced during the outage');
  const bulkDuring = W.req.bulk - bulkBefore, reconDuring = W.req.reconcile - reconBefore;
  ck(W.bulkLog.every((ids) => !ids.some((i) => /^big/.test(i))), 'no push request ever contained a held job');
  ck(bulkDuring <= 2 && reconDuring <= 2, 'held jobs cost no network: ' + bulkDuring + ' pushes, ' + reconDuring + ' reconcile GETs over 3 hours');
  const attempts = tags.map((t) => W.photoAttempts[('/9j/' + t).slice(0, 24)] || Object.keys(W.photoAttempts).filter((k) => k.indexOf(t) > -1).reduce((a, k) => a + W.photoAttempts[k], 0));
  const maxAttempts = Math.max(...Object.keys(W.photoAttempts).filter((k) => /^T\d/.test(k)).map((k) => W.photoAttempts[k]));
  console.log('   upload attempts per photo: ' + JSON.stringify(Object.keys(W.photoAttempts).filter((k) => /^T\d/.test(k)).map((k) => W.photoAttempts[k])) + ' | total photo failures: ' + W.photoFails);
  ck(maxAttempts <= 9, 'upload retries stay inside the backoff budget: max ' + maxAttempts + ' per photo in 3 hours (<= 9)');
  ck(w.eval('ipLoad()').filter((j) => /^big/.test(j.id) && String(j.mrPhoto).indexOf('data:image') === 0 && j.mrPhoto.length > 400000).length === 4, 'no photo lost locally while waiting (all 4 still on the device)');
  // recovery
  W.photoMode = 'ok';
  await app.advance(75 * 60 * 1000);
  const healed = serverJobs(W).filter((r) => /^big/.test(r.id));
  ck(healed.length === 4, 'after uploads recover all 4 held jobs reached the server (' + healed.length + ')');
  ck(healed.every((r) => r.data.length < 20000 && r.data.indexOf('data:image') === -1), 'and they were stored with Drive links, never embedded photos');
  ck(maxSize(W) < 150000, 'largest stored record after recovery ' + maxSize(W));
  ck(w.eval('ipLoad()').every((j) => !(typeof j.mrPhoto === 'string' && j.mrPhoto.indexOf('data:') === 0)), 'device copies now point at Drive too');
  const rewrites = Math.max(...healed.map((r) => W.db.stats.perId[r.id] || 0));
  ck(rewrites <= 2, 'each healed job written at most twice (' + rewrites + ')');
  const bulkLater = W.req.bulk; await app.advance(HOUR);
  ck(W.req.bulk - bulkLater <= 1, 'after healing, pushes go quiet: ' + (W.req.bulk - bulkLater) + ' pushes in the next hour');
  w.close();

  // ───────── 3) Worker backstop + health ─────────
  console.log('\n-- 3. Worker backstop and health endpoint');
  W = await world();
  const small = { id: 'ok1', type: 'job', data: { id: 'ok1', n: 1 } }, small2 = { id: 'ok2', type: 'job', data: { id: 'ok2' } };
  const huge = { id: 'huge1', type: 'job', data: { id: 'huge1', mrPhoto: photoOf('H', 600000) } };
  let r = await W.call('POST', '/records/bulk', { records: [small, huge, small2] }); let j = await r.json();
  ck(r.status === 200 && j.count === 2 && j.rejected.length === 1 && j.rejected[0].id === 'huge1', 'bulk with one oversize record: stores the 2 good ones, rejects the big one: ' + JSON.stringify(j).slice(0, 90));
  ck(W.db.rows.has('ok1') && W.db.rows.has('ok2') && !W.db.rows.has('huge1'), 'good records stored, oversize record not stored');
  r = await W.call('PUT', '/records/huge2', { type: 'job', data: huge.data });
  ck(r.status === 413 && !W.db.rows.has('huge2'), 'single PUT of an oversize record answers 413 and stores nothing');
  r = await W.call('PUT', '/records/fine', { type: 'job', data: { id: 'fine' } });
  ck(r.status === 200 && W.db.rows.has('fine'), 'a normal PUT still works');
  r = await W.call('GET', '/admin/health'); j = await r.json();
  ck(r.status === 200 && j.status === 'ok' && j.alerts.length === 0 || (console.log('   health said:', JSON.stringify(j).slice(0, 300)), false), 'health endpoint: ok on a clean database');
  W.db.rows.set('legacy1', { id: 'legacy1', type: 'job', data: JSON.stringify({ mrPhoto: photoOf('L', 200000) }), updated_at: Date.now(), deleted: 0 });
  r = await W.call('GET', '/admin/health'); j = await r.json();
  ck(j.status === 'alert' && /over 150000/.test(j.alerts.join()), 'health endpoint: raises an alert when a big record is present: ' + j.alerts.join(' | ').slice(0, 80));
  for (let i = 0; i < 1600; i++) W.db.rows.set('burst' + i, { id: 'burst' + i, type: 'job', data: '{}', updated_at: Date.now(), deleted: 0 });
  r = await W.call('GET', '/admin/health'); j = await r.json();
  ck(/rows changed in 24h/.test(j.alerts.join()), 'health endpoint: raises an alert on a write burst (1600 rows in a day)');
  const rd0 = W.db.stats.read, wr0 = W.db.stats.written;
  await W.call('GET', '/admin/health');
  ck(W.db.stats.written === wr0, 'health check writes nothing');
  r = await fetch('data:,'); // keep the event loop honest; no-op

  // ───────── 4) share a draft ─────────
  console.log('\n-- 4. sharing a draft never sends embedded photos');
  W = await world(); app = makeApp(W); w = app.w; await app.advance(40 * 1000);
  w.eval('window.__d = { id: "draft1", station: "Long Gluer", photos: [' + JSON.stringify(photoOf('D1', 300000)) + ', ' + JSON.stringify(photoOf('D2', 300000)) + '], notes: "x" }');
  W.photoMode = 'fail';
  let shared = await w.eval('_syncShareDraft(window.__d)');
  ck(shared === false && !W.db.rows.has('draft1'), 'upload failing: share reports failure and sends nothing');
  W.photoMode = 'ok';
  shared = await w.eval('_syncShareDraft(window.__d)');
  const sd = W.db.rows.get('draft1');
  ck(shared === true && sd && sd.data.indexOf('data:image') === -1 && sd.data.length < 5000, 'upload ok: draft shared with Drive links only (' + (sd ? sd.data.length : 'none') + ' chars)');
  ck(w.eval('window.__d.photos[0]').indexOf('data:image') === 0, 'the local draft keeps its own photos untouched');
  w.close();

  console.log(fails ? '\nFAILED ' + fails : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });

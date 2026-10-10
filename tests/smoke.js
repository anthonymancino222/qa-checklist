/* Smoke test for the QA app — run before every push (the git pre-push hook runs it for you).
 *
 *   node tests/smoke.js
 *
 * It loads the REAL index.html in a simulated browser (jsdom) several times with different saved
 * data on the "device" (empty, contacts saved, a full set of records...) and checks:
 *   1. every inline script is valid JavaScript
 *   2. the app finishes starting (the last line of the main script sets window.__QA_BOOT_OK) with no
 *      uncaught errors — a half-started app is exactly how "the Submit button does nothing" happens
 *   3. every screen opens without an error
 *   4. key flows work: Long Gluer first-page submit, NCR + Sales Approval submit, CAR save/PDF/email box,
 *      Records popup, shortage "who to notify" picker
 * Exit code 0 = safe to ship, 1 = DO NOT ship.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const FILES = (process.argv[2] ? [process.argv[2]] : ['index.html']);
let failures = 0;
const log = (ok, msg) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + msg); if (!ok) failures++; };

function checkSyntax(file, html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, i = 0, ok = true;
  while ((m = re.exec(html))) {
    i++;
    try { new Function(m[1]); } catch (e) { ok = false; log(false, file + ': inline script #' + i + ' has a syntax error: ' + e.message); }
  }
  if (ok) log(true, file + ': all ' + i + ' inline scripts are valid JavaScript');
}

const CONTACTS = {
  version: 1,
  people: [
    { id: 'jayro', name: 'Jayro Molina', label: 'Jayro M', email: 'jayro@moquinpress.com' },
    { id: 'danny', name: 'Danny Robertson', label: 'Danny R', email: 'danny@moquinpress.com' },
    { id: 'ship', name: 'Shipping Dept.', label: 'Shipping Dept', email: 'shipping@moquinpress.com' }
  ],
  stations: { 'Packing': ['jayro'], 'Kama Foil Press': ['danny', 'jayro'], 'Shipping': ['ship'] },
  qaTeam: ['qualitygroup@moquinpress.com'], qaCc: 'anthony.mancino@moquinpress.com', directory: []
};
const SCENARIOS = [
  { name: 'fresh device (nothing saved)', storage: {} },
  { name: 'device with CAR contacts saved', storage: { qa_car_contacts_v1: JSON.stringify(CONTACTS) } },
  { name: 'device with contacts + CARs + NCR + jobs saved', storage: {
      qa_car_contacts_v1: JSON.stringify(CONTACTS),
      'moquin-qa-rcas': JSON.stringify([
        { cloudId: 'car-2026-1', carNo: '2026-1', status: 'Open', jobNumber: '111', station: 'Packing', customer: 'Acme', path: 'Path 1 — QA completes all', savedAt: 'Oct 1, 2026' },
        { cloudId: 'RCA-AAAA1111', status: 'Pending', jobNumber: '222', station: 'Long Gluer', customer: 'Beta', path: 'Path 2 — Escalate to manager', savedAt: 'Oct 2, 2026' },
        { cloudId: 'car-tbd-x1', carTbd: true, status: 'Open', jobNumber: '333', station: 'Samples', customer: 'Gamma', savedAt: 'Oct 3, 2026' }
      ]),
      'moquin-qa-ncrs': JSON.stringify([{ ncrId: 'NCR-001', path: 'ncr', status: 'Open', customerFinal: 'Acme', jobNumber: '111', station: 'Packing', product: 'P', date: '2026-10-01', photos: [] }])
    } },
  // A device that is ALREADY SIGNED IN (the stay-signed-in session is restored at the very top of the
  // script, before most of the file has been read) with real saved jobs/NCRs/drafts/CARs. This is the
  // everyday state of every shop tablet, and it runs code the other scenarios never reach: a variable
  // declared further down the file is still undefined at that moment. On 2026-10-10 a new `var` used
  // that way stopped the app half-way through starting on every signed-in device, and no test caught it
  // because none of them were signed in.
  { name: 'SIGNED-IN device (session restored) with saved jobs + NCRs + drafts + CARs', storage: {
      qa_local_session_v1: JSON.stringify({ name: 'Tester', email: 'anthony.mancino@moquinpress.com', idToken: 'test-id-token',
        sessionToken: 'test-session', sessionExp: Date.now() + 30 * 86400000, sessionEmail: 'anthony.mancino@moquinpress.com',
        sessionRefreshedAt: Date.now(), lastActivityAt: Date.now() }),
      qa_car_contacts_v1: JSON.stringify(CONTACTS),
      'moquin-qa-inprogress': JSON.stringify([
        { id: 'job-1', jobNumber: '111', station: 'Packing', process: 'finished', product: 'P1', customer: 'Acme', finishedAt: 'Oct 9, 2026, 08:00:00 AM', checklist: [], stageHistory: [], lastTouchedAt: 'Oct 9, 2026, 08:00:00 AM' },
        { id: 'job-2', jobNumber: '222', station: 'Bindery Cutter', process: 'production', product: 'P2', customer: 'Beta', checklist: [], stageHistory: [] }
      ]),
      'moquin-qa-ncrs': JSON.stringify([{ ncrId: 'NCR-001', path: 'ncr', status: 'Open', customerFinal: 'Acme', jobNumber: '111', station: 'Packing', product: 'P', date: '2026-10-01', photos: [], createdAt: 'Oct 1, 2026, 08:00:00 AM' }]),
      'moquin-qa-ncr-drafts': JSON.stringify([{ __draftId: 'd1', path: 'ncr', jobNumber: '333' }]),
      'moquin-qa-rcas': JSON.stringify([{ cloudId: 'car-2026-1', carNo: '2026-1', status: 'Open', jobNumber: '111', station: 'Packing', customer: 'Acme', path: 'Path 1 — QA completes all', savedAt: 'Oct 1, 2026' }])
    } }
];

// ---- steps run INSIDE the loaded page; each returns 'ok' or throws ----
const FLOWS = `
(async function(){
  var R = [], sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  async function step(name, fn){ try { await fn(); R.push([name, 'ok']); } catch(e){ R.push([name, 'FAILED: ' + (e && e.message) + ' @ ' + String(e && e.stack || '').split('\\n')[1]]); } }
  var $ = function(id){ return document.getElementById(id); };
  window.showAlert = function(m){ window.__alerts.push(m); }; window.__alerts = []; window.open = function(){};
  window.showToast = window.showToast || function(){};
  $('google-signin-overlay') && ($('google-signin-overlay').style.display = 'none');
  $('appLayout') && ($('appLayout').style.display = 'flex');
  _googleIdToken = 'test-token'; _signedInUser = { name: 'Tester', email: 'anthony.mancino@moquinpress.com' };

  await step('every screen opens', async function(){
    var ids = Array.prototype.map.call(document.querySelectorAll('#mainContent > .screen'), function(e){ return e.id.replace(/^view-/, ''); });
    var bad = [];
    for (var i = 0; i < ids.length; i++){ try { switchView(ids[i]); } catch(e){ bad.push(ids[i] + ': ' + e.message); } }
    switchView('home');
    if (bad.length) throw new Error(bad.join(' | '));
  });

  await step('Help page built (topic buttons + collapsible answers) — proves startup code after the early session restore ran', async function(){
    var chips = $('faq-chips') ? $('faq-chips').children.length : -1;
    var bodies = document.querySelectorAll('.faq-body').length;
    if (chips < 8 || bodies < 20) throw new Error('Help layout did not build (topic buttons=' + chips + ', answers=' + bodies + ') — startup stopped early');
    if (typeof _showUpdateBanner !== 'function' || typeof APP_VERSION_HASH_KEY !== 'string') throw new Error('update-check startup values missing');
  });

  await step('shortage "who to notify" picker builds', async function(){
    var h = _glrReasonPickerHTML('t-why', 't-notify', 'red', '#fff', 'red', 'H', 'L');
    if (h.indexOf('type="checkbox"') < 0) throw new Error('no checkboxes');
  });

  await step('Long Gluer first-page submit adds the job', async function(){
    var before = ipLoad().length;
    switchView('qc'); await sleep(50);
    Array.prototype.find.call(document.querySelectorAll('#setup-station-btns button'), function(b){ return /Long Gluer/.test(b.textContent); }).click();
    await sleep(50); $('setup-job').value = '987654';
    var PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    for (var i = 0; i < 12; i++){
      window.__alerts.length = 0; await beginInspection(); await sleep(30); var a = window.__alerts[0] || '';
      if (!a) break;
      if (/operator name/i.test(a)) $('gluer-operator-group').querySelector('.tgl').click();
      else if (/Product ID/i.test(a)){ $('gluer-product-0').value = '115843'; }
      else if (/photo/i.test(a)){ $('gluer-prod-photo-prev-0').src = PX; $('gluer-prod-photo-prev-0').style.display = 'block'; }
      else throw new Error('unexpected prompt: ' + a);
    }
    if (ipLoad().length !== before + 1) throw new Error('job was not added (last prompt: ' + (window.__alerts[0] || 'none') + ')');
  });

  await step('NCR + Sales Approval submit (with a picked person)', async function(){
    ['ncr', 'sales'].forEach(function(path){});
    for (var k = 0; k < 2; k++){
      var path = k ? 'sales' : 'ncr';
      switchView('ncr'); ncrStart(path); await sleep(30);
      var d = ncrState.d; d.customer = 'Acme'; d.customerIsOther = false; d.jobNumber = '1'; d.products = ['P-1']; d.reportedBy = 'Tester'; d.station = 'Packing'; d.issue = 'x'; d.rootCause = 'y'; d.disposition = 'Rework'; d.salesSummary = 's'; d.proposedResolution = 'r'; d.urgency = 'High';
      ncrToSummary(); if (ncrState.mode !== 'summary') throw new Error(path + ': did not reach the summary (' + (window.__alerts[0] || '') + ')');
      var cb = $('ncr-notify') && $('ncr-notify').querySelector('input[type=checkbox]'); if (cb) cb.click();
      var n0 = ncrLoad().length; ncrFinalize(); if (ncrLoad().length !== n0 + 1) throw new Error(path + ': NCR was not saved');
    }
  });

  await step('CAR: form, save, notify box, PDF report', async function(){
    switchView('rca'); rcaResetForm(); rcaSetPath(1); await sleep(30);
    $('rca-car-no').value = 'SMOKE-1'; $('rca-job-num').value = '9001'; $('rca-problem-stmt').value = 'x';
    if (!$('rca-notify-box').querySelector('.qa-nt-row') && _notifyOptions().length) throw new Error('notify box has no people');
    var d = rcaCollectData('Open', 'car_save'); _rcaBuildReport(d);
    rcaRenderDraftList();
  });

  await step('Gluer batch: change number of products (fewer, more, while entering, single->batch)', async function(){
    var keep = ipLoad().slice(); ipSave([], { preserveTouch: true });
    ipAdd({ id: 'gluer-t1', jobNumber: '555', station: 'Long Gluer', productNumber: 'P1', customer: 'T', process: 'qa_release', batchId: 'batch-t', batchSize: 5, batchIndex: 2, scheduleProductsUsed: ['P1', 'P2', 'P3'], scheduleProductPool: [], stageHistory: [], checklist: [] });
    function cards(){ return _computeIPCols(ipLoad()).needsNextProduct.length; }
    if (cards() !== 1) throw new Error('start-next card should show for 3 of 5');
    renderInProgress();
    if (!document.querySelector('.gluer-count-edit')) throw new Error('no visible "change number of products" control on the card');
    // fewer: 5 -> 3 (all done) makes the prompt go away; cannot go below the 3 already started
    openGluerCountEditor('job', 'gluer-t1'); var pop = document.getElementById('gluer-count-pop');
    document.getElementById('gcp-minus').click(); document.getElementById('gcp-minus').click(); document.getElementById('gcp-minus').click();
    if (document.getElementById('gcp-val').textContent !== '3') throw new Error('stepper went below the products already started: ' + document.getElementById('gcp-val').textContent);
    document.getElementById('gcp-save').click();
    if (ipLoad()[0].batchSize !== 3 || cards() !== 0) throw new Error('reducing to 3 should finish the job (batchSize=' + ipLoad()[0].batchSize + ', cards=' + cards() + ')');
    // more: 3 -> 5 brings the prompt back
    openGluerCountEditor('job', 'gluer-t1'); document.getElementById('gcp-plus').click(); document.getElementById('gcp-plus').click(); document.getElementById('gcp-save').click();
    if (ipLoad()[0].batchSize !== 5 || cards() !== 1) throw new Error('raising to 5 should bring the prompt back');
    // while entering the next product: bar visible, minimum = the product being entered
    _startGluerNextProduct(ipLoad()[0], 'P4');
    var bar = document.getElementById('gluer-batch-bar');
    if (bar.style.display === 'none' || !/4/.test(document.getElementById('gluer-batch-bar-text').textContent)) throw new Error('entry-screen bar missing');
    openGluerCountEditor('continue'); document.getElementById('gcp-minus').click(); document.getElementById('gcp-minus').click(); document.getElementById('gcp-save').click();
    if (_gluerContinueBatch.batchSize !== 4 || ipLoad()[0].batchSize !== 4) throw new Error('edit while entering did not apply (min should be the product being entered)');
    startNewJob();
    if (document.getElementById('gluer-batch-bar').style.display !== 'none') throw new Error('bar should hide on a fresh job');
    // a single-product gluer job grown into a batch gets a batch id and the prompt
    ipSave([], { preserveTouch: true });
    ipAdd({ id: 'gluer-t2', jobNumber: '556', station: 'Short Gluer', productNumber: 'Q1', customer: 'T', process: 'qa_release', batchSize: 1, scheduleProductsUsed: ['Q1'], stageHistory: [], checklist: [] });
    openGluerCountEditor('job', 'gluer-t2'); document.getElementById('gcp-plus').click(); document.getElementById('gcp-plus').click(); document.getElementById('gcp-save').click();
    if (!ipLoad()[0].batchId || ipLoad()[0].batchSize !== 3 || cards() !== 1) throw new Error('single job was not grown into a batch');
    ipSave(keep, { preserveTouch: true });
  });

  await step('CAR target close date: date / ASAP / TBD, saved and reloaded', async function(){
    switchView('rca'); rcaResetForm(); rcaSetPath(1); await sleep(30);
    $('rca-open-date').value = '2026-10-07'; rcaOpenDateChanged();
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(rcaCollectData('Open', 'x').targetClose)) throw new Error('default target close should be a date');
    rcaSetTargetMode('ASAP');
    if (rcaCollectData('Open', 'x').targetClose !== 'ASAP' || !$('rca-target-close').disabled) throw new Error('ASAP not applied');
    rcaSetTargetMode('TBD');
    if (rcaCollectData('Open', 'x').targetClose !== 'TBD') throw new Error('TBD not applied');
    var rec = rcaCollectData('Open', 'x'); _rcaFillCarFields(rec);
    if (rcaCollectData('Open', 'x').targetClose !== 'TBD') throw new Error('TBD lost when a saved CAR is reopened');
    rcaSetTargetMode('TBD');   // tapping the lit option again goes back to a date
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(rcaCollectData('Open', 'x').targetClose) || $('rca-target-close').disabled) throw new Error('could not go back to a date');
    var d = rcaCollectData('Open', 'x'); d.carNo = 'T-1'; d.targetClose = 'ASAP'; _rcaBuildReport(d);
    if (!/ASAP/.test($('rca-pdf-report').textContent)) throw new Error('ASAP missing from the PDF report');
    rcaResetForm();
    if ($('rca-target-mode').value !== '') throw new Error('reset did not clear the target mode');
  });

  await step('Records list + CAR popup', async function(){
    switchView('records'); renderRecords();
    if (rcaLoadRecords().length) openRecordRCA('rca-0');
  });

  window.__FLOW = R;
})();
`;

function loadPage(file, scenario) {
  return new Promise((resolve) => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const errors = [], consoleErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail && e.detail.message || e.message)));
    vc.on('error', (...a) => consoleErrors.push(a.map(String).join(' ')));
    const dom = new JSDOM(html, {
      url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(w) {
        Object.keys(scenario.storage).forEach((k) => w.localStorage.setItem(k, scenario.storage[k]));
        w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
        w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
        w.scrollTo = () => {}; w.print = () => {};
        w.HTMLElement.prototype.scrollIntoView = function () {};
        w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (t, p) => (p === 'canvas' ? {} : (p === 'measureText' ? () => ({ width: 0 }) : () => {})), set: () => true });
        w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
        w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
        w.addEventListener('error', (e) => errors.push('uncaught: ' + (e.message || e.error)));
        w.addEventListener('unhandledrejection', (e) => errors.push('unhandled rejection: ' + String(e.reason && e.reason.message || e.reason)));
        w.IntersectionObserver = w.IntersectionObserver || class { observe() {} disconnect() {} unobserve() {} };
        w.ResizeObserver = w.ResizeObserver || class { observe() {} disconnect() {} unobserve() {} };
      }
    });
    const w = dom.window;
    const t0 = Date.now();
    (function wait() {
      if (w.__QA_BOOT_OK || Date.now() - t0 > 4000) return resolve({ dom, w, errors, consoleErrors });
      setTimeout(wait, 50);
    })();
  });
}

(async () => {
  for (const file of FILES) {
    console.log('\n=== ' + file + ' ===');
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    checkSyntax(file, html);
    for (const sc of SCENARIOS) {
      console.log('\n-- ' + sc.name);
      const { w, errors, consoleErrors } = await loadPage(file, sc);
      log(!!w.__QA_BOOT_OK, 'app finished starting (last line of the main script ran)');
      log(errors.length === 0, 'no uncaught errors while loading' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
      const initFail = consoleErrors.filter((e) => /failed to initialize/i.test(e));
      log(initFail.length === 0, 'optional features started cleanly' + (initFail.length ? ': ' + initFail[0] : ''));
      if (w.__QA_BOOT_OK) {
        try { w.eval(FLOWS); } catch (e) { log(false, 'flow runner crashed: ' + e.message); }
        const t0 = Date.now();
        while (!w.__FLOW && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
        (w.__FLOW || [['flows did not finish', 'FAILED: timeout']]).forEach((r) => log(r[1] === 'ok', r[0] + (r[1] === 'ok' ? '' : ' — ' + r[1])));
        const after = errors.filter((e) => !/Not implemented/.test(e));
        log(after.length === 0, 'no uncaught errors during the flows' + (after.length ? ': ' + after.slice(0, 3).join(' | ') : ''));
      }
      w.close();
    }
  }
  console.log('\n' + (failures ? 'RESULT: ' + failures + ' CHECK(S) FAILED — do NOT ship this version.' : 'RESULT: all checks passed.'));
  process.exit(failures ? 1 : 0);
})();

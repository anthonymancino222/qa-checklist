/* Two guards, run by smoke.js (also: node tests/ship_photo_race.js):
 *  1. Shipping Approval never saves the make-ready photo a second time (no second copy, no second Drive upload) —
 *     only a photo QA actually changed (marked up / replaced) is saved.
 *  2. A sync pull that was started BEFORE a trim finishes AFTER it without writing the trimmed jobs back into the
 *     local list (which made the next push re-send every trimmed job to the server). */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const mk = (id, over) => Object.assign({ id, jobNumber: id.toUpperCase(), station: 'Bindery Cutter', process: 'finished', finishedAt: 'Oct 20, 2026 at 05:08:44 AM', timestamp: 'Oct 20, 2026 at 05:08:44 AM', customer: 'C', productNumber: 'P' + id, mrPhoto: 'http://x/photo/MRPHOTO', stageHistory: [{ stage: 'make_ready', label: 'MR', ts: 'x', data: { photo: true } }] }, over || {});
const server = {}, writes = [], uploads = [];
const put = (j) => { server[j.id] = { id: j.id, type: 'job', data: j, updatedAt: 1, deleted: false }; };
const session = { qa_local_session_v1: JSON.stringify({ name: 'T', email: 'anthony.mancino@moquinpress.com', idToken: 'x', sessionToken: 's', sessionExp: Date.now() + 30 * 864e5, sessionEmail: 'anthony.mancino@moquinpress.com', sessionRefreshedAt: Date.now(), lastActivityAt: Date.now() }) };
let holdPull = null;
function make(localJobs) {
  return new JSDOM(html, { url: 'http://localhost:8000/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new VirtualConsole(), beforeParse(w) {
    Object.keys(session).forEach((k) => w.localStorage.setItem(k, session[k]));
    w.localStorage.setItem('moquin-qa-inprogress', JSON.stringify(localJobs));
    w.fetch = (u, o) => {
      u = String(u); const m = (o && o.method) || 'GET';
      const ok = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b), text: () => Promise.resolve('') });
      if (u.indexOf('/photo') > -1 && m === 'POST') { let mt = ''; try { mt = JSON.parse(o.body).mimeType; } catch (e) {} if (/jpeg/.test(mt)) uploads.push(1); /* photos only; the signature upload is expected */ return ok({ url: '/photo/NEW' }); }
      if (u.indexOf('/records') > -1) {
        if (m !== 'GET') { writes.push(m + ' ' + u.replace(/^https?:\/\/[^/]+/, '')); return ok({ ok: true, count: 0 }); }
        const mm = u.match(/\/records\/([^?]+)\?type=job/); if (mm) { const r = server[decodeURIComponent(mm[1])]; return r ? ok({ record: r }) : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }); }
        if (u.indexOf('type=job') > -1) { const body = { records: Object.values(server) }; if (holdPull) { const h = holdPull; return new Promise((res) => h.push(() => res({ ok: true, status: 200, json: () => Promise.resolve(body) }))); } return ok(body); }
        return ok({ records: [] });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
    };
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {}; w.print = () => {}; w.HTMLElement.prototype.scrollIntoView = function () {};
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,SIG';
    w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }; w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  } });
}
let fails = 0; const ck = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function approve(w, id, changePhoto) {
  w.eval("showConfirm = function(m, cb){ cb(true); }");
  w.eval("openShippingModal('" + id + "')");
  await sleep(300);
  w.eval("shipState.data.transportRate = 'Customer'; shipSigHasMark.val = true;");
  const img = w.document.getElementById('ship-photo-preview');
  if (changePhoto) { img.setAttribute('src', 'data:image/jpeg;base64,MARKEDUP'); }
  w.eval('submitShippingApproval()');
  await sleep(600);
  return w.eval('ipLoad()').filter((j) => j.id === id)[0];
}
(async () => {
  // 1) Shipping Approval photo handling
  put(mk('ship1')); put(mk('ship2'));
  let dom = make([mk('ship1'), mk('ship2')]); let w = dom.window; await sleep(3500);
  uploads.length = 0;
  const a = await approve(w, 'ship1', false);
  ck(a && a.shippingApproved === true, 'job approved for shipping');
  ck(a.shipping.cutterPicture === null, 'carried-over make-ready photo is NOT saved again as a second photo');
  ck(a.mrPhoto === 'http://x/photo/MRPHOTO', 'the make-ready photo itself is untouched');
  const sh = a.stageHistory.filter((s) => s.stage === 'shipping_approval')[0];
  ck(sh && !sh.data.cutterPicture, 'shipping timeline entry carries no second copy of the photo');
  ck(uploads.length === 0, 'no extra photo uploaded to Drive for the carried-over photo (uploads: ' + uploads.length + ')');
  const b = await approve(w, 'ship2', true);
  ck(b.shipping.cutterPicture && b.shipping.cutterPicture.length > 0, 'a photo QA actually changed (marked up) IS saved');
  w.close();

  // 2) stale pull vs trim
  Object.keys(server).forEach((k) => delete server[k]); writes.length = 0;
  const olds = ['old1', 'old2', 'old3'].map((id) => mk(id, { shippingApproved: true, finishedAt: 'Aug 3, 2026 at 05:08:44 AM' }));
  olds.concat([mk('recent1', { shippingApproved: true, finishedAt: 'Oct 25, 2026 at 05:08:44 AM' })]).forEach(put);
  dom = make(olds.concat([mk('recent1', { shippingApproved: true, finishedAt: 'Oct 25, 2026 at 05:08:44 AM' })])); w = dom.window; await sleep(150);
  const ids = () => w.eval('ipLoad()').map((j) => j.id).sort().join(',');
  // start a pull with the FULL list (before any trim) and hold its response
  put(mk('newjob', { shippingApproved: true })); // gives the held pull something to add, so it saves
  holdPull = []; const held = holdPull;
  w.eval("window.__stale = ipLoad(); _syncPullAndMerge('job', window.__stale, ipSave)");
  await sleep(150);
  holdPull = null; await sleep(6000); // the startup pull finishes and the trim runs while the held pull is still in flight
  ck(ids() === 'recent1', 'trim moved the old jobs off the device (' + ids() + ')');
  held.forEach((f) => f()); await sleep(2500);
  ck(ids().indexOf('old') === -1, 'a pull started before the trim does not write the trimmed jobs back (' + ids() + ')');
  await w.eval("_syncPushDelta('job', ipLoad())"); await sleep(1500);
  ck(writes.filter((x) => /bulk|PUT|DELETE/.test(x)).length === 0, 'and nothing is sent to the server: ' + JSON.stringify(writes));
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();

/* ══════════════════════════════════════════════════════════════════════
   QA Checklist — Version B backend (Google Sheets + Drive, via Apps Script)

   This is the Apps Script sibling of the main QA Checklist app's Cloudflare
   Worker + D1 backend (cloudflare-backend/src/index.js in the parent
   folder) — same job (store every job/NCR/draft record, store photos and
   signatures, hand back a URL for each), different plumbing:
     - Records live as rows in this spreadsheet's "Records" sheet instead of
       a D1 table. The full record is still kept whole as one JSON blob (the
       `data` column) — that's the only thing the app itself ever reads back
       — but a handful of the most-asked-about fields (job/product number,
       station, form number, customer, quantities) are ALSO broken out into
       their own real columns purely so a person opening this Sheet directly
       can read/filter/sort it without decoding JSON. See _handleBulkUpsert's
       own comment for exactly which fields and why those.
     - Photos/signatures upload to a Drive folder instead of the Worker's
       service-account-proxied Drive folder, and come back as a plain
       "anyone with the link can view" Drive URL — there's no proxy step
       here, so unlike the main app, these files are NOT kept private.
       That's a real, deliberate trade-off for the simplicity of not running
       a proxy — see the README in this same folder before treating this as
       equivalent to the main app's access control.

   Deploy: see backend/README.md in this same folder for the full walk-
   through (bind this script to a new Google Sheet, run setupSheet() once,
   deploy as a Web App, paste the /exec URL into ../index.html).
══════════════════════════════════════════════════════════════════════ */

var RECORDS_SHEET_NAME = 'Records';

// Must match QA_BACKEND_API_KEY in index.html. This is the ONLY gate on this
// endpoint — Apps Script Web Apps deployed "Execute as: Me / Anyone" are
// otherwise open to anyone who has the URL, and a bearer-token check like
// the Worker's (verifying a real Google ID token) isn't practical to do from
// a fetch() call here (see index.html's own comment on why the transport
// looks the way it does). Rotate this string in both places if it's ever
// exposed somewhere it shouldn't be.
var API_KEY = 'MoquinQA2026SecureKeyAlpha7';

// Photos/signatures land in a Drive folder, auto-created under this name the
// first time anything uploads if DRIVE_PHOTO_FOLDER_ID below is left blank.
// Paste an existing folder's id there instead if you'd rather control where
// this lands (e.g. share a specific folder with whoever needs to browse the
// raw files).
var DRIVE_PHOTO_FOLDER_NAME = 'QA Checklist Version B Photos';
var DRIVE_PHOTO_FOLDER_ID = '';

// ── Records sheet ────────────────────────────────────────────────────────
// Column layout — id/type/data/updatedAt/deleted are what the app itself
// actually reads back (via _rowToRecord); everything between `type` and
// `data` is read-only-for-humans, written from the record's own data at
// upsert time (see _handleBulkUpsert) purely so this Sheet is skimmable
// without decoding the `data` JSON. If the app's own field names for any
// of these ever change, update the RECORD_COLUMNS map below to match —
// nothing else needs to change.
var RECORD_COLUMNS = ['id', 'type', 'jobNumber', 'station', 'formNumber', 'productNumber', 'customer', 'operatorName', 'qtyToExecute', 'finalQty', 'notes', 'finishedAt', 'data', 'updatedAt', 'deleted'];
var COL = {}; // field name -> 1-based column number, built once below
RECORD_COLUMNS.forEach(function(name, i) { COL[name] = i + 1; });

function _getRecordsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RECORDS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RECORDS_SHEET_NAME);
    sheet.appendRow(RECORD_COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// One-time setup — run this once from the Apps Script editor (select
// setupSheet in the function dropdown, click ▶ Run) right after pasting this
// file in. Safe to run again later; it only creates the sheet if missing —
// if you're adding the new job/product/etc. columns to a Records sheet that
// already exists from before they were added, see the README's "Adding the
// extra columns to an existing sheet" section instead of just re-running this.
function setupSheet() {
  _getRecordsSheet();
  Logger.log('Records sheet ready.');
}

// "Job Number/ID" and "Product Number/ID" are deliberately ONE column each
// here, not two — jobNumber/jobId and productNumber/productId mean the same
// thing at Moquin, the app itself only ever uses one field name per concept
// (jobNumber, productNumber). Several of these also need a fallback to a
// second field name because different stations write the same concept under
// a different key in index.html — same pattern that file's own code already
// uses in a few places (see e.g. its job.finalQty fallback chains):
//   - qtyToExecute: Gluer-station jobs store this as totalOrderedQty instead
//     (this was the actual bug behind "Qty to Execute" showing blank for a
//     Long Gluer job — totalOrderedQty was never read before this fix).
//   - finalQty: some Gluer jobs write gluerFinalQty instead.
//   - notes: QC stations write qcNotes, make-ready stations write
//     mrComments — both mean "notes a person typed," just under different
//     names depending on which screen captured them.
//   - finishedAt: not every record type sets this; timestamp is the
//     more-universal fallback (set on effectively every record).
function _extractColumns(data) {
  data = data || {};
  return {
    jobNumber: data.jobNumber || '',
    station: data.station || '',
    formNumber: data.formNumber || '',
    productNumber: data.productNumber || data.product || '',
    customer: data.customer || '',
    operatorName: data.operatorName || '',
    qtyToExecute: data.qtyToExecute || data.totalOrderedQty || '',
    finalQty: data.finalQty || data.gluerFinalQty || '',
    notes: data.qcNotes || data.mrComments || data.notes || '',
    finishedAt: data.finishedAt || data.timestamp || ''
  };
}

function _rowToRecord(row) {
  var data = null;
  try { data = JSON.parse(row[COL.data - 1]); } catch (e) { /* leave null on a corrupt cell rather than throw */ }
  return { id: row[COL.id - 1], type: row[COL.type - 1], data: data, updatedAt: Number(row[COL.updatedAt - 1]) || 0, deleted: row[COL.deleted - 1] === true };
}

// values includes the header row at index 0 — returns a 0-based index into
// values, or -1. Only used for single-record lookups (delete); bulk upserts
// build their own id->row map once instead of calling this per record.
function _findRowIndexById(values, id) {
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return i;
  }
  return -1;
}

function _handleListRecords(type, since) {
  var sheet = _getRecordsSheet();
  var values = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (String(row[COL.type - 1]) !== String(type)) continue;
    var updatedAt = Number(row[COL.updatedAt - 1]) || 0;
    if (since && updatedAt <= since) continue;
    out.push(_rowToRecord(row));
  }
  return { records: out };
}

// LockService around every sheet-mutating handler below — multiple devices
// can push at the same time, and Sheets has no equivalent of D1's atomic
// "ON CONFLICT DO UPDATE" upsert; without a lock, two near-simultaneous
// upserts of records that both need to insert a genuinely new row could
// both read the sheet before either one's appendRow() lands, and both
// append instead of one appending and one updating.
function _handleBulkUpsert(records) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = _getRecordsSheet();
    var values = sheet.getDataRange().getValues();
    var idIndex = {}; // id -> 1-based sheet row
    for (var i = 1; i < values.length; i++) idIndex[String(values[i][0])] = i + 1;

    var now = Date.now();
    var count = 0;
    (records || []).forEach(function(r) {
      if (!r || !r.id || !r.type || r.data === undefined) return;
      var dataJson = JSON.stringify(r.data);
      var c = _extractColumns(r.data);
      var rowValues = [r.id, r.type, c.jobNumber, c.station, c.formNumber, c.productNumber, c.customer, c.operatorName, c.qtyToExecute, c.finalQty, c.notes, c.finishedAt, dataJson, now, false];
      var rowNum = idIndex[String(r.id)];
      if (rowNum) {
        sheet.getRange(rowNum, 1, 1, rowValues.length).setValues([rowValues]);
      } else {
        sheet.appendRow(rowValues);
        idIndex[String(r.id)] = sheet.getLastRow();
      }
      count++;
    });
    return { ok: true, count: count, updatedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function _handleDelete(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = _getRecordsSheet();
    var values = sheet.getDataRange().getValues();
    var idx = _findRowIndexById(values, id);
    var now = Date.now();
    if (idx === -1) return { ok: true, updatedAt: now }; // already gone — soft-delete is idempotent
    sheet.getRange(idx + 1, COL.updatedAt, 1, 2).setValues([[now, true]]);
    return { ok: true, updatedAt: now };
  } finally {
    lock.releaseLock();
  }
}

// ── Photo/signature storage (Drive) ──────────────────────────────────────

function _getPhotoFolder() {
  if (DRIVE_PHOTO_FOLDER_ID) return DriveApp.getFolderById(DRIVE_PHOTO_FOLDER_ID);
  var folders = DriveApp.getFoldersByName(DRIVE_PHOTO_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DRIVE_PHOTO_FOLDER_NAME);
}

// Uploads straight to Drive and makes the file "anyone with the link can
// view" — unlike the main app's Worker (which keeps photos private and
// proxies the bytes through itself), there's no proxy step here, so this
// file is genuinely reachable by anyone who has (or guesses/finds) its URL.
// See the README for why that trade-off was made and what to do if it
// turns out to matter for this deployment.
function _handleUploadPhoto(filename, mimeType, dataBase64) {
  var folder = _getPhotoFolder();
  var bytes = Utilities.base64Decode(dataBase64);
  var blob = Utilities.newBlob(bytes, mimeType || 'image/jpeg', filename || ('qa-photo-' + Date.now()));
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // The lh3.googleusercontent.com form is the reliable one for hotlinking as
  // a plain <img src> — drive.google.com/uc?export=view often serves an
  // interstitial page instead of the raw image bytes for a browser-embedded
  // <img> tag, which is why an earlier version of this returned a URL that
  // rendered as a blank box in the app.
  return { id: file.getId(), url: 'https://lh3.googleusercontent.com/d/' + file.getId() };
}

// ── JSONP / poll-result plumbing ─────────────────────────────────────────
// See index.html's own comment (near _qaJsonpGet/_qaWriteAndPoll) for why
// the frontend talks to this backend this way: JSONP for reads (Apps Script
// GET responses carry no CORS headers a plain fetch() could read), and a
// fire-and-forget POST followed by a polled GET for writes that need a
// result back (a POST response isn't reliably readable cross-origin either).

function _reply(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback && /^[A-Za-z0-9_$.]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// doPost's actual HTTP response is never read by the frontend (it POSTs
// with mode:'no-cors', which makes every response opaque) — the real result
// goes out through this cache entry instead, picked up by the frontend's
// poll loop hitting doGet(action=pollResult) below. 6h TTL is just "long
// enough that a slow/retried poll loop won't miss it," not a meaningful
// retention window — nothing reads a requestId this old in practice.
var _POLL_RESULT_TTL_SECONDS = 21600;

function doPost(e) {
  var body = null;
  try {
    body = e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : null;
  } catch (err) {
    return ContentService.createTextOutput('bad request');
  }
  if (!body || body.key !== API_KEY) {
    return ContentService.createTextOutput('unauthorized');
  }

  var result;
  try {
    if (body.action === 'bulkUpsert') result = _handleBulkUpsert(body.records);
    else if (body.action === 'delete') result = _handleDelete(body.id);
    else if (body.action === 'uploadPhoto') result = _handleUploadPhoto(body.filename, body.mimeType, body.dataBase64);
    else result = { error: 'unknown action: ' + body.action };
  } catch (err) {
    result = { error: String(err && err.message || err) };
  }

  if (body.requestId) {
    CacheService.getScriptCache().put(body.requestId, JSON.stringify(result), _POLL_RESULT_TTL_SECONDS);
  }
  // Returned for completeness/manual testing (e.g. curl) — the real caller
  // (index.html, via mode:'no-cors') never reads this.
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = p.callback || '';
  if (p.key !== API_KEY) return _reply({ error: 'unauthorized' }, callback);

  if (p.action === 'pollResult') {
    var cached = CacheService.getScriptCache().get(p.requestId || '');
    if (!cached) return _reply({ done: false }, callback);
    var parsed = JSON.parse(cached);
    parsed.done = true;
    return _reply(parsed, callback);
  }
  if (p.action === 'listRecords') {
    return _reply(_handleListRecords(p.type, Number(p.since) || 0), callback);
  }
  if (p.action === 'getRecord') {
    var rec = _handleListRecords(p.type, 0).records.filter(function(r) { return String(r.id) === String(p.id); })[0];
    return _reply(rec ? { record: rec } : { error: 'not found' }, callback);
  }
  return _reply({ ok: true, message: 'QA Checklist Version B backend is live' }, callback);
}

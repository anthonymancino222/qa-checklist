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
       station, form number, customer, quantities, notes, checklist) are
       ALSO broken out into their own real columns purely so a person
       opening this Sheet directly can read/filter/sort it without decoding
       JSON. See _handleBulkUpsert's own comment for exactly which fields.
     - Photos/signatures upload to a Drive folder instead of the Worker's
       service-account-proxied Drive folder, and come back as a plain
       "anyone with the link can view" Drive URL — there's no proxy step
       here, so unlike the main app, these files are NOT kept private.
       That's a real, deliberate trade-off for the simplicity of not running
       a proxy — see the README in this same folder before treating this as
       equivalent to the main app's access control.
     - Schedule Pull (the CERM-export .xlsx auto-fill) uses Apps Script's
       own Drive-to-Sheets conversion instead of the Worker's hand-rolled
       zip/xlsx parser — genuinely simpler here, since Apps Script can just
       ask Drive to convert the file and then read it as a normal Sheet.
       Requires the "Drive API" Advanced Service enabled (Services + in the
       editor) and SCHEDULE_FOLDER_ID set below — see README.
     - QA Release "notify" emails send directly via MailApp instead of the
       app handing off to a mailto: link — see the sendEmail action below.

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

// The same Drive folder Anthony already drops the CERM machine-schedule
// (and optional Sales Orders) .xlsx export into for the main app — paste
// that folder's id here (open it in Drive, copy the id out of the URL).
// Required for Pull Schedule; leave blank and that feature just fails
// gracefully (same as before this was built).
var SCHEDULE_FOLDER_ID = '';

// Where QA Release "did not make overs" / "job short" alerts get sent —
// same recipient the main app's mailto: link was already addressed to.
var QA_ALERT_EMAIL = 'anthony.mancino@moquinpress.com';

// ── Records sheet ────────────────────────────────────────────────────────
// Column layout — id/type/data/updatedAt/deleted are what the app itself
// actually reads back (via _rowToRecord); everything between `type` and
// `data` is read-only-for-humans, written from the record's own data at
// upsert time (see _handleBulkUpsert) purely so this Sheet is skimmable
// without decoding the `data` JSON. If the app's own field names for any
// of these ever change, update the RECORD_COLUMNS map below to match —
// nothing else needs to change.
var RECORD_COLUMNS = ['id', 'type', 'jobNumber', 'station', 'formNumber', 'productNumber', 'customer', 'operatorName', 'qtyToExecute', 'finalQty', 'notes', 'finishedAt', 'checklistSummary', 'data', 'updatedAt', 'deleted'];
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
// if you're adding new columns to a Records sheet that already exists from
// before they were added, see the README's "Adding columns to an existing
// sheet" section instead of just re-running this.
function setupSheet() {
  _getRecordsSheet();
  Logger.log('Records sheet ready.');
}

// Compact one-line readable summary of a checklist array (kept as one
// column, not one column per question — different stations ask different
// questions, so a fixed column per question would mean 40-60+ mostly-blank
// columns; this stays readable without that). Each item is
// {id, name, val, note}; only name+val show here (id/note stay in the full
// `data` blob for anyone who needs them).
function _summarizeChecklist(checklist) {
  if (!checklist || !checklist.length) return '';
  return checklist.map(function(item) {
    return (item.name || item.id || '?') + ': ' + (item.val || '—');
  }).join('; ');
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
    finishedAt: data.finishedAt || data.timestamp || '',
    checklistSummary: _summarizeChecklist(data.checklist || data.qcChecklist)
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
      var rowValues = [r.id, r.type, c.jobNumber, c.station, c.formNumber, c.productNumber, c.customer, c.operatorName, c.qtyToExecute, c.finalQty, c.notes, c.finishedAt, c.checklistSummary, dataJson, now, false];
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

// ── Email (QA Release "notify" alerts) ───────────────────────────────────
// Sent directly via MailApp — no popup, no manual "click Send" step. This
// replaces the main app's mailto: hand-off (which opens the browser's/OS's
// default mail client for a person to review and send) — that's still how
// the ORIGINAL app works; this silent-send is Version B only, per Anthony's
// call, since the main app's Cloudflare Worker has no built-in email
// sending of its own.
function _handleSendEmail(to, subject, body) {
  MailApp.sendEmail({ to: to || QA_ALERT_EMAIL, subject: subject || '(no subject)', body: body || '' });
  return { ok: true, sentAt: Date.now() };
}

// ── Schedule bridge (CERM export, read from Drive) ───────────────────────
// Anthony can't get this app talking to CERM directly (standing rule), so
// he drops the day's exported schedule as .xlsx into SCHEDULE_FOLDER_ID —
// same folder the main app's Worker already reads from. Converting the
// .xlsx to a real Google Sheet (via the Drive Advanced Service) and reading
// it with SpreadsheetApp is what makes this whole feature much shorter here
// than the Worker's version, which had to hand-parse the zip/xlsx format
// itself with no library available in that runtime.
//
// Requires the "Drive API" Advanced Service enabled for this project
// (Services + in the left sidebar of the Apps Script editor → find "Drive
// API" → Add) — see README for the one-time steps.

function _listXlsxFilesNewestFirst(folder) {
  var files = [];
  var it = folder.getFilesByType(MimeType.MICROSOFT_EXCEL);
  while (it.hasNext()) files.push(it.next());
  files.sort(function(a, b) { return b.getLastUpdated().getTime() - a.getLastUpdated().getTime(); });
  return files;
}

// Converts one .xlsx Drive file to a temporary Google Sheet (via the Drive
// Advanced Service's files.copy, which converts when the target mimeType
// differs from the source), reads every tab as a plain 2D array, then
// trashes the temporary copy (not a permanent delete — recoverable from
// Drive's Trash like anything else) so these don't pile up.
function _convertXlsxToSheetsData(file) {
  var copied = Drive.Files.copy(
    { title: 'tmp-schedule-import-' + Date.now(), mimeType: MimeType.GOOGLE_SHEETS },
    file.getId(),
    { convert: true }
  );
  try {
    var ss = SpreadsheetApp.openById(copied.id);
    return ss.getSheets().map(function(sheet) {
      return { name: sheet.getName(), rows: sheet.getDataRange().getValues() };
    });
  } finally {
    DriveApp.getFileById(copied.id).setTrashed(true);
  }
}

// headerRowIndex's row is the header; every row after becomes
// { headerText: value }. Defaults to row 0, but the Sales Orders export
// groups columns under a category label on row 0 with the real headers one
// row down — see the retry-at-row-1 in _sheetToRecords below for how that's
// detected without special-casing a specific file, same rule the Worker's
// version used.
function _rowsToRecords(rows, headerRowIndex) {
  headerRowIndex = headerRowIndex || 0;
  if (rows.length <= headerRowIndex) return [];
  var headerRow = rows[headerRowIndex];
  var records = [];
  for (var i = headerRowIndex + 1; i < rows.length; i++) {
    var rec = {};
    var hasAny = false;
    for (var c = 0; c < headerRow.length; c++) {
      var header = String(headerRow[c] || '').trim();
      if (!header) continue;
      rec[header] = rows[i][c];
      if (rows[i][c] !== '' && rows[i][c] != null) hasAny = true;
    }
    if (hasAny) records.push(rec);
  }
  return records;
}

function _looksLikeHeader(recs) {
  return recs.length > 0 && Object.keys(recs[0]).some(function(h) { return h === 'Job' || h === 'Job ID'; });
}

function _sheetToRecords(rows) {
  var records = _rowsToRecords(rows, 0);
  if (!_looksLikeHeader(records)) {
    var alt = _rowsToRecords(rows, 1);
    if (_looksLikeHeader(alt)) records = alt;
  }
  return records;
}

// Anthony's rule for the DieCutter tab's "Components" cell: several
// newline-separated lines like "Blanker bottom / 9184-F1-B / CR-06 / ...",
// and the die number is the leading digits of the SECOND slash-separated
// field (ignore the "-F1-B" suffix and everything else on the line).
function _extractDieNumbers(componentsText) {
  if (!componentsText) return [];
  var found = {};
  String(componentsText).split(/\r\n|\r|\n/).forEach(function(line) {
    var parts = line.split('/');
    if (parts.length < 2) return;
    var m = parts[1].trim().match(/^(\d+)/);
    if (m) found[m[1]] = true;
  });
  return Object.keys(found);
}

// Stations whose QA release goes by product number, per Anthony — Die
// Cutter and Kama release by form number instead (unaffected by any of
// this). Only these two get backfilled from the Sales Orders file.
var PRODUCT_NUMBER_SHEETS = ['LabelCutter', 'FolderGluer'];

// The two source files are told apart by shape, not filename — the
// multi-tab machine schedule has "Job" + "Station/Product" (or
// "Components"), the single-tab Sales Orders export has "Job ID" +
// "Product ID" columns.
function _classifySheets(sheetsData) {
  var isScheduleFile = false, isSalesOrdersFile = false;
  sheetsData.forEach(function(s) {
    if (!s.records.length) return;
    var headers = Object.keys(s.records[0]);
    if (headers.indexOf('Job') !== -1 && (headers.indexOf('Components') !== -1 || headers.some(function(h) { return h.replace(/\s+/g, '') === 'Station/Product'; }))) isScheduleFile = true;
    if (headers.indexOf('Job ID') !== -1 && headers.indexOf('Product ID') !== -1) isSalesOrdersFile = true;
  });
  return { isScheduleFile: isScheduleFile, isSalesOrdersFile: isSalesOrdersFile };
}

// Job ID -> {products, customer} from a Sales Orders export. Not station-
// aware — the caller only consults this for jobs already known (from the
// schedule file) to be on a PRODUCT_NUMBER_SHEETS sheet.
function _parseSalesOrders(sheetsData) {
  var out = {};
  sheetsData.forEach(function(s) {
    if (!s.records.length) return;
    var headers = Object.keys(s.records[0]);
    if (headers.indexOf('Job ID') === -1 || headers.indexOf('Product ID') === -1) return;
    s.records.forEach(function(rec) {
      var jobNum = String(rec['Job ID'] || '').trim();
      if (!jobNum) return;
      if (!out[jobNum]) out[jobNum] = { products: {}, customer: '' };
      var prodId = String(rec['Product ID'] || '').trim();
      if (prodId) out[jobNum].products[prodId] = true;
      if (rec['Customer name'] && !out[jobNum].customer) out[jobNum].customer = String(rec['Customer name']).trim();
    });
  });
  return out;
}

// Every file among the newest 10 in the folder that matches a known shape
// gets merged in — not just the single newest — so an extra file dropped
// in (a second/test export) adds its jobs instead of silently replacing
// them; same-numbered jobs across files just union their data.
function _handleSchedulePull() {
  if (!SCHEDULE_FOLDER_ID) return { error: 'SCHEDULE_FOLDER_ID is not set in Code.gs — see README' };
  var folder = DriveApp.getFolderById(SCHEDULE_FOLDER_ID);
  var allFiles = _listXlsxFilesNewestFirst(folder).slice(0, 10);
  if (!allFiles.length) return { error: 'no .xlsx files found in the schedule bridge folder' };

  var scheduleSheets = [], salesOrdersSheets = [];
  var scheduleFileNames = [], salesOrdersFileNames = [];
  allFiles.forEach(function(file) {
    var sheetsRaw = _convertXlsxToSheetsData(file);
    var sheetsData = sheetsRaw.map(function(s) { return { name: s.name, records: _sheetToRecords(s.rows) }; });
    var cls = _classifySheets(sheetsData);
    if (cls.isScheduleFile) { scheduleFileNames.push(file.getName()); scheduleSheets = scheduleSheets.concat(sheetsData); }
    if (cls.isSalesOrdersFile) { salesOrdersFileNames.push(file.getName()); salesOrdersSheets = salesOrdersSheets.concat(sheetsData); }
  });
  if (!scheduleFileNames.length) return { error: 'no machine-schedule .xlsx (Job + Station/Product or Components columns) found among the newest files in the schedule bridge folder' };

  var jobs = {};
  function ensureJob(jobNum) {
    if (!jobs[jobNum]) jobs[jobNum] = { customer: '', products: {}, dieNumbers: {}, sheets: {} };
    return jobs[jobNum];
  }

  scheduleSheets.forEach(function(sheet) {
    if (!sheet.records.length) return;
    var headers = Object.keys(sheet.records[0]);
    if (headers.indexOf('Job') === -1) return;

    if (headers.indexOf('Components') !== -1) {
      sheet.records.forEach(function(rec) {
        var jobNum = String(rec.Job || '').trim();
        if (!jobNum) return;
        var job = ensureJob(jobNum);
        job.sheets[sheet.name] = true;
        _extractDieNumbers(rec.Components).forEach(function(d) { job.dieNumbers[d] = true; });
      });
    } else {
      var productKey = headers.filter(function(h) { return h.replace(/\s+/g, '') === 'Station/Product'; })[0];
      sheet.records.forEach(function(rec) {
        var jobNum = String(rec.Job || '').trim();
        if (!jobNum) return;
        var job = ensureJob(jobNum);
        job.sheets[sheet.name] = true;
        if (rec.Customer && !job.customer) job.customer = String(rec.Customer).trim();
        if (productKey && rec[productKey]) job.products[String(rec[productKey]).trim()] = true;
      });
    }
  });

  if (salesOrdersSheets.length) {
    var salesOrders = _parseSalesOrders(salesOrdersSheets);
    Object.keys(jobs).forEach(function(jobNum) {
      var job = jobs[jobNum];
      var eligible = Object.keys(job.sheets).some(function(s) { return PRODUCT_NUMBER_SHEETS.indexOf(s) !== -1; });
      if (!eligible) return;
      var so = salesOrders[jobNum];
      if (!so) return;
      Object.keys(so.products).forEach(function(p) { job.products[p] = true; });
      if (so.customer && !job.customer) job.customer = so.customer;
    });
  }

  var jobsOut = {};
  Object.keys(jobs).forEach(function(jobNum) {
    jobsOut[jobNum] = {
      customer: jobs[jobNum].customer,
      products: Object.keys(jobs[jobNum].products),
      dieNumbers: Object.keys(jobs[jobNum].dieNumbers),
      sheets: Object.keys(jobs[jobNum].sheets)
    };
  });

  return {
    ok: true,
    sourceFile: scheduleFileNames.join(', '),
    salesOrdersFile: salesOrdersFileNames.length ? salesOrdersFileNames.join(', ') : null,
    fetchedAt: Date.now(),
    jobCount: Object.keys(jobsOut).length,
    jobs: jobsOut
  };
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
    else if (body.action === 'sendEmail') result = _handleSendEmail(body.to, body.subject, body.body);
    else if (body.action === 'schedulePull') result = _handleSchedulePull();
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

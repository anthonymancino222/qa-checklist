# QA Checklist — Version B backend (Google Sheets + Drive)

This is an alternate backend for the same `index.html` app in the folder
above, swapping the main app's Cloudflare Worker + D1 for Google Apps
Script + a Google Sheet + Drive. Same frontend, same offline-first
behavior — only the storage plumbing is different.

## What's implemented vs. the main app

**Implemented** (same behavior as the Cloudflare Worker backend):
- Job / NCR / NCR-draft / QC-draft records — create, update, soft-delete,
  bulk sync, cross-device pull-and-merge. All the same offline-first
  behavior as the main app (see `index.html`'s own comments near
  `_syncPushDelta`).
- Photo and signature uploads to Drive, returned as a URL stored on the
  record instead of embedded as base64.
- Deleted Items view / restore (QA Manager screen).

**Not implemented** (falls back gracefully, doesn't crash):
- **Schedule Pull** (the CERM-export `.xlsx` auto-fill on job setup) — the
  Worker's xlsx-parsing-from-Drive logic hasn't been ported. Tapping "Pull
  Schedule" will show "Pull failed" and nothing else; job setup still works
  fine typed in by hand, same as before that feature existed.
- **Admin backup/restore-from-backup** and the **daily automatic backup** —
  the Worker's `/admin/backup-now` / `/admin/restore-record` and its
  scheduled daily export aren't ported. The Sheet itself IS your data store
  now, so treat normal Google Sheets version history / Drive backup of the
  Sheet file as your safety net for this version, at least until/unless
  this gets ported too.
- **RCA** — unrelated to either backend; it already has its own separate
  Apps Script (`RCCA Form/RCA_AppScript_v3.gs`) and isn't affected by any
  of this.

## A real trade-off to know about: photo/signature privacy

The main app's Worker keeps uploaded photos **private** in Drive and proxies
the bytes through itself so a browser can display them without ever having
Google auth of its own (see that Worker's `handlePhotoGet` for how). This
Apps Script version does **not** do that — `_handleUploadPhoto` in
`Code.gs` sets each uploaded file to **"Anyone with the link can view."**
That's what makes it possible to hand back a URL a plain `<img src>` can
load at all, without also building a proxy layer, but it means anyone who
gets hold of a photo's Drive URL (not just anyone who has the app open) can
view that one file. For internal shop-floor QC/NCR photos this is likely an
acceptable trade-off, but it's a real one — don't treat this as equivalent
to the main app's access model without deciding that's fine for what
you're storing here.

## Why the frontend talks to this backend so differently

Apps Script Web Apps are a single URL (`doGet`/`doPost` only — no REST-style
routing by path or method) and their responses aren't reliably readable
cross-origin. This app's own RCA module already hit exactly that and solved
it with two techniques:
- **JSONP** for reads (a `<script>` tag, not `fetch` — sidesteps CORS
  entirely because script tags aren't subject to it).
- A **fire-and-forget POST** (`mode:'no-cors'`) for writes that don't need
  to read a response back.

Version B's `index.html` reuses both, plus one addition: for the writes
that DO need something read back (a bulk push's success/failure, an
uploaded photo's resulting URL), it fires the same no-cors POST and then
polls via the same JSONP-GET technique for a result Code.gs stashed under
a matching request id (see `_qaWriteAndPoll` in `index.html` and the
`pollResult` action in `Code.gs`). Nothing here relies on an unproven
cross-origin trick — every request is one of the two techniques already
working in this app's RCA module.

## Deploying this backend

1. **Create a new Google Sheet** (blank spreadsheet) — this holds the
   `Records` sheet Code.gs manages. Name it whatever you like, e.g.
   "QA Checklist Version B — Data".
2. **Open Extensions → Apps Script** from that Sheet.
3. Delete the default `Code.gs` boilerplate content, then paste in the
   entire contents of this folder's `Code.gs`.
4. In the Apps Script editor's function dropdown (top toolbar, next to the
   ▶ Run button), select **`setupSheet`**, then click ▶ Run once. Approve
   the permissions prompt (this account needs Sheets + Drive access). This
   creates the `Records` sheet tab with its header row.
5. **Deploy → New deployment** → gear icon → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone** (this is what lets the app's browser tab
     call it without its own Google OAuth flow — see the "photo privacy"
     section above for the trade-off this implies; the shared `API_KEY` in
     `Code.gs` is the only real gate on this URL)
   - Click **Deploy**, authorize again if prompted, then **copy the Web
     app URL** (ends in `/exec`).
6. Open `../index.html` (the Version B copy, NOT the main app's) and paste
   that URL into `QA_BACKEND_URL` near the top of the "CHUNK 2 BACKEND
   SYNC" section.
7. Confirm `API_KEY` in `Code.gs` still matches `QA_BACKEND_API_KEY` in
   `index.html` — they ship matching by default; only change one if you
   change both.

**Redeploying after an edit to `Code.gs`:** Apps Script Web App URLs don't
change automatically when you edit the script — you need **Deploy → Manage
deployments → (pencil/edit icon on the existing deployment) → New version →
Deploy** to push a code change live at the same URL. A brand new deployment
(rather than a new version of the existing one) gets a different URL, which
would mean updating `index.html` again.

## Optional: pick your own Drive folder for photos

By default, the first photo/signature upload auto-creates a folder named
"QA Checklist Version B Photos" in the Apps Script account's own Drive. To
use a specific existing folder instead (e.g. one you've already shared with
whoever needs to browse the raw files), open that folder in Drive, copy its
id out of the URL (`.../folders/<this part>`), and paste it into
`DRIVE_PHOTO_FOLDER_ID` in `Code.gs`.

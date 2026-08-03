# CLAUDE.md — Moquin Press QA Checklist System

Reference notes for working on this app. See also `REGRESSION_CHECKLIST.md` (manual test checklist) and `cloudflare-backend/src/index.js` (backend source, gitignored from GitHub Pages but tracked here locally).

## Architecture

- **Frontend**: single file `index.html` — plain HTML/CSS/JS, no build step, no framework. Deployed via GitHub Pages at `https://anthonymancino222.github.io/qa-checklist/`. Push to `main` on `https://github.com/anthonymancino222/qa-checklist.git` → live in about 15–30s (GitHub Pages CDN cache lag; a fetch with `cache: 'no-store'` right after push often still shows stale content for the first ~15s — wait and retry rather than assuming the push failed).
- **Backend**: Cloudflare Worker `qa-checklist-backend` (source at `cloudflare-backend/src/index.js`, **gitignored** — not pushed to GitHub, deployed manually). Base URL: `https://qa-checklist-backend.anthony-mancino2.workers.dev`. Data store: Cloudflare D1 database `qa-checklist-db` (one `records` table, JSON blob per record — see `cloudflare-backend/schema.sql`).
- **Auth**: shared header `X-API-Key: MoquinQA2026SecureKeyAlpha7` (constants `QA_BACKEND_URL` / `QA_BACKEND_API_KEY` near the top of `index.html`) — required on writes, reads are open.
- **Sync model**: offline-first. Every save writes to `localStorage` immediately; a background push/pull (`_syncPushAll`, `_syncPullAndMerge`, `_syncNowAll`) reconciles with the Worker. Retries every 30s and on `online` event. Same-id conflicts: local wins (no overwrite) except server-side deletes always win (pruned locally on pull) to avoid resurrecting deleted records.
- **Manual sync**: header "🔄 Sync" button (`headerSyncNowClick()`) next to DATA EDIT — pushes pending, pulls fresh, re-renders the current screen, updates nav badges.

## Backend deployment (no local Node/wrangler available in this environment)

The Cloudflare dashboard's in-browser code editor (Quick Edit) is used directly via browser automation or manual copy-paste — there is no `npx`/`wrangler` CLI in this environment. Gotchas:

- **Large pastes via automated typing are unreliable** — has corrupted the editor mid-paste more than once (stray keystrokes opened command-palette/search overlays, or dropped a chunk of text). For anything beyond a one-line edit, prefer having the user paste the code manually (Ctrl+A, Ctrl+V, Deploy) over automating it — always verify with a fresh `Ctrl+Home` → `Ctrl+Shift+End` style check that nothing got corrupted before deploying, and if in doubt, **discard and reload** rather than risk deploying broken code (the live Worker keeps its last-good version until you explicitly click Deploy).
- Editing the Worker's env vars: Overview → Settings → "Variables and secrets" → Add/Edit → set Type to **Secret** for anything sensitive (private keys, API keys) and **Text** for plain config (emails, IDs) → Deploy.
- The Cloudflare dashboard also surfaces unrelated upsell/onboarding flows (an "Enable Agent Lee access" panel, a "Cloudflare Zero Trust — choose a plan" page) that can appear from stray clicks/keystrokes — back out of these (Cancel/X), never grant access or select a plan.

## Google Drive photo storage

Photos (make-ready, QA release, NCR, RCA) are uploaded to a Google Drive **Shared Drive** and referenced by a backend-proxied link instead of being embedded as base64 in synced job/NCR/RCA records (which was filling up `localStorage`).

- **Why a Shared Drive, not a regular "My Drive" folder**: a service account has zero storage quota of its own. Even when a personal folder is *shared* with the service account, uploading into it still fails with `storageQuotaExceeded` — the service account is the file's creator/owner, and owners need real quota. A Shared Drive owns its files itself, sidestepping that entirely. Both the upload and retrieval Drive API calls need `&supportsAllDrives=true` for this to work against a Shared Drive.
- **Service account**: `qa-photo-uploader@qa-photo-storage.iam.gserviceaccount.com` (Google Cloud project `qa-photo-storage`), scope `drive.file`, added as a **Content Manager** member of the Shared Drive.
- **Secrets** (set as Cloudflare Worker secrets/vars — never committed to the repo): `GOOGLE_SA_EMAIL` (plaintext), `GOOGLE_SA_PRIVATE_KEY` (secret — the PEM from the service account's JSON key; needs real/stripped whitespace, not literal `\n` — see `pemToArrayBuffer` in the backend), `GOOGLE_DRIVE_FOLDER_ID` (plaintext — currently the Shared Drive's own ID, `0AHhuh7Nddb6UUk9PVA`).
- **Backend endpoints**: `POST /photo` (auth required, body `{filename, mimeType, dataBase64}` → `{id, url}`) uploads via a JWT-signed (RS256, Web Crypto) service-account token exchanged at Google's OAuth token endpoint; `GET /photo/:id` (no auth — id itself is unguessable) proxies the file bytes back through the Worker using the same service-account token, so the Drive file stays **private** and the browser never needs its own Google auth to display it.
- **Frontend helper**: `_uploadPhotoToDrive(dataUrl)` in `index.html` — POSTs the captured photo, returns the backend proxy URL (`QA_BACKEND_URL + result.url`). **On any failure it resolves to the original data URL unchanged** — a photo must never be lost to a flaky shop-floor connection; worst case it just falls back to the old embedded-base64 behavior for that one photo. Wired into every photo-commit point: `submitForQAApproval`, `beginVeritivPacking`, `beginInspection` (Kama/DC/Gluer, both production and make-ready branches), `submitJob` (Bindery/Pressroom Cutter + non-Veritiv Packing multi-product path), NCR photo capture, RCA photo capture.
- Photos taken/synced **before** this was added remain stored as base64 — no retroactive migration was done; only new captures go through Drive.

## DATA EDIT mode (`_dataEditMode`)

Global passcode-gated toggle (`toggleDataEditMode()` — passcode required only to turn ON, never to turn off, after a "stuck in edit mode" field bug). Turning it on reveals:
- Edit pencils on editable summary fields inside the job popup (only for `production`/`qa_pending`/`qa_release` stages — see `dataEditShown` in `openContinueModal`).
- A **"🗑️ Delete Job" button** — independent of the above, shown for **any** process stage as long as `_dataEditMode` is on. Two separate confirmations (differently worded) guard every delete, so an accidental/reflexive tap can't push it through.
- Delete is wired into **every** job-detail surface, because each has its own separate popup:
  - `_cmDeleteJob()` — the shared continue-modal (make ready / production / QA release / on-hold — anything opened via `openContinueModal`).
  - `_shipDeleteJob()` — the separate Shipping Approval modal (`openShippingModal`/`shipState.jobId`).
  - Per-job kanban/list delete (`deleteIPJob`, `_jpDeleteBtnHTML`) — Job in Progress tile/list cards directly.
- `_updateHeaderDataEditBtn()` is the central sync point — flipping DATA EDIT from the header button updates every open modal's delete-button visibility in one place, so a new per-modal delete button just needs to read `_dataEditMode` there rather than wiring its own toggle listener.

## Workflow — who pushes what

The user has granted standing permission for Claude to directly execute deploys in this project, and that has been the actual working pattern throughout: Claude controlled essentially every push to GitHub and every Cloudflare deploy across this whole session — not just writing the code, but running `git add`/`commit`/`push` directly via PowerShell, and deploying the Worker/editing its secrets directly through the connected Cloudflare dashboard browser tab. The user only stepped in for the handful of things that are structurally outside Claude's reach:
- Google Cloud Console setup (creating the project, service account, and Shared Drive) — Cloudflare Console and Google Cloud Console are blocked domains for the browser-automation tool, so the user drove those steps directly (with Claude giving step-by-step instructions).
- Approving the Cloudflare tab connection itself, and one large code paste after the in-browser editor got corrupted by automated typing (see "Backend deployment" gotchas above) — the user pasted that one manually.
- Anything requiring their own Google/Cloudflare account login.

**Instruction for future sessions**: keep this same division of labor by default. Once the user has connected a Cloudflare (or similar) browser tab and confirmed permission, don't ask them to run `git push` or click through a deploy yourself-narrating-it-to-them — just do it directly (PowerShell for git, the connected browser tab for Cloudflare), the same way this session did, end to end, for every change. Only hand a step back to the user when it's something Claude is actually blocked from doing (a blocked domain, a corrupted editor state, an account-login wall) — and say so explicitly when that happens, rather than silently trying to work around it.

## Standing rules (also saved in Claude's cross-session memory)

- **Test cleanup**: after any testing pass in the sandbox, delete test/loose job/NCR/RCA records from **both** local storage and the live Cloudflare backend (sandbox and production share the same backend — nothing is isolated). Verify deletes held by re-querying after ~30–40s. Stop this once the user says the app has gone live; from then on only clean up Claude's own test data.
- **Never touch the CERM MIS/ERP system** from this codebase, under any circumstance.
- The sister app **Gluer Shift Handoff** shares some UI patterns (offline-first sync design, History/Records year-month drill-down) — worth checking there for precedent before designing something from scratch here.

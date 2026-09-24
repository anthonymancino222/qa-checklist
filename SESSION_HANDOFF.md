# Handoff for a new chat — Moquin Press QA Checklist Approval work

Paste this whole file as your first message in a new chat to pick up where we left off without re-establishing permissions or re-litigating workflow.

## Standing permissions — act, don't ask

Full standing permission to act autonomously on this project: `git push`, editing/testing code, running Bash/PowerShell — without stopping to ask first. Only real capability walls stop you (not permission):

1. The built-in browser tool **cannot open local files** (`file://` URLs refused) and has no real Google sign-in. For anything requiring real signed-in backend access, hand the user copy-paste console scripts to run in their own already-authenticated Chrome tab instead — don't try to sign in yourself.
2. `github.com` and Cloudflare/Google Cloud dashboards may be blocked domains for the browser tool directly — navigate there anyway first; if refused, fall back to giving the user manual steps.
3. A separate safety classifier can block a specific risky-looking action (e.g., a live production bulk-mutation script, a Worker code deploy) even after explicit chat approval — don't retry past it, hand the user the exact manual step instead.

**Git**: `index.html` (root) and `version-b/index.html` are both in this repo (`github.com/anthonymancino222/qa-checklist`), deployed via GitHub Pages at `https://anthonymancino222.github.io/qa-checklist/` (main app) and `.../version-b/` (fork). A push deploys automatically within ~30-60s — always confirm live via a genuinely fresh, no-cache `curl` fetch afterward (`curl -s "URL?nocache=$(date +%s)" -H "Cache-Control: no-cache, no-store" | grep ...`), and explicitly tell the user it's live, not just that the push succeeded.

The **Cloudflare Worker backend** (`cloudflare-backend/src/index.js`) has no local deploy tooling — changes there need the user to paste into the dashboard's Quick Edit themselves.

**Cloudflare billing**: the user upgraded to the **Workers Paid plan ($5/month)** this session — the free-tier daily-limit concern is now much less pressing, though bulk/migration scripts should still batch sensibly rather than blast writes.

## Hard rules established this session (in addition to standing project rules already in memory)

- **Every change verified live**, not just code-reviewed — extract the real function from the file and unit-test it in Node against multiple real scenarios before shipping anything sync/data-related. This session's sync fixes were each verified against 7-11 scenario test suites before being pushed.
- **Every fix to `index.html` gets applied identically to `version-b/index.html`**, unless the underlying mechanism is genuinely different (version-b uses Google Apps Script/JSONP for its transport, not `fetch` — same bugs, different transport, same fix pattern).
- **Never trust a script's own "success" report for a production data write** — always independently re-verify against a fresh server fetch afterward, from a clean/new script, not just reading back the same variables. This caught the stageHistory-cleanup-appeared-to-work-but-didn't incident below.
- **A tablet can stay open for a full shift or more without reloading** — this is normal, not an edge case. A fix to sync/data-integrity logic is not actually "shipped" to the fleet until devices reload; the 20-minute auto-update check (already built this session) is what makes that happen without relying on someone remembering to tap Sync.
- **Don't fabricate approval/QA records.** `SHIP_AUTO_APPROVE_TESTING` must stay `false` outside active testing. When a bulk recovery script has to write real backend records (like this session's shipping-approval recovery), tag them distinctly (e.g., `_recoveredFromSyncBug: true`) and use a stage-history label that's honest about it being a recovery action, not a real human sign-off.
- **RCA records are device-local only**, never synced to the Cloudflare backend (a separate legacy Apps Script handles daily Drive backups) — don't assume RCA data behaves like job/NCR data.
- **Data sync priority rule (explicit user requirement, not yet fully built — see Next Goal)**: "most recent confirmed edit wins," like Google Sheets — not "whoever created the record wins." A device with a genuinely unsynced edit must never have it silently discarded by another device's stale pull.
- Pair any complex technical explanation with a short, plain-English version (standing user preference).
- The user explicitly does not want to pay for a second backend platform (this is why version-b uses Apps Script instead of a second paid service) — Cloudflare's $5/mo upgrade was a considered exception, not a green light for other paid services.

## Where things stand (end of a very long, incident-heavy session — 2026-09-23)

### 1. THE MAIN INCIDENT — now fully resolved
User reported jobs already approved for shipping kept reappearing as pending, on every device, no matter how many times cleared/synced.

- **Root cause #1**: `_syncPullAndMerge` unconditionally kept the LOCAL copy of any record it already had locally — a genuine change made elsewhere could never land, ever, no matter how many syncs ran.
- Fixed this once (added last-write-wins via a "confirmed sync snapshot" comparison) — **this fix itself caused a second, worse incident**: it reverted ~110 already-approved shipping jobs back to "pending," because...
- **Root cause #2 (the real one)**: `_syncPushDelta`'s one-time migration path seeded that "confirmed" snapshot from LOCAL data alone whenever `SYNC_PENDING_KEY` looked clean, with **zero network confirmation**. A device whose earlier push had silently failed (expired Google sign-in token — tokens expire hourly, the background silent-refresh via `google.accounts.id.prompt()` is unreliable) could carry a snapshot dishonestly claiming the server was caught up.
- **Real fix (now live, both files)**: the migration path always asks the server directly first (one GET) and only marks an id "confirmed" when the server's copy byte-for-byte matches local. Last-write-wins in `_syncPullAndMerge` was then safely restored on top of this now-honest snapshot. A separate migration marker (not the snapshot's own emptiness) gates the one-time reconciliation, since a legitimate zero-match result must not be mistaken for "never ran" and loop forever. Verified with an 11-scenario test suite reproducing the exact incident — all passing on both `index.html` and `version-b/index.html`.
- Also fixed: `_syncPullAndMerge` didn't check `res.ok` before parsing JSON, so a 401 (expired token) silently looked like "server has zero records" instead of a real failure.
- **The 110 reverted jobs were restored** via direct per-record `PUT` to the server (bypassing local storage, which was hitting its quota — see #3), tagged `_recoveredFromSyncBug: true`, Freight transport, generic signature. Confirmed via independent fresh server fetch: 0 pending, 110 tagged recovered.
- **Follow-up feature added (explicit user request)**: Shipping Approval queue now has a hard cutoff — `SHIPPING_APPROVAL_CUTOFF_DATE = new Date('2026-09-22T00:00:00')` in both files. Any job that reached "finished" before that date never shows in the queue again, on any device, regardless of local cache staleness. This was requested because the user can't practically track every shop-floor tablet's individual cache state — it's a single code change every device picks up automatically.

### 2. Long-open-tablet blind spot — fixed
Found because a browser tab open through several deploys that same night was still silently running OLD buggy JS in memory (JS doesn't hot-reload just because new code is deployed).

- `_checkForAppUpdate()` only ran when someone tapped Sync, AND had a real separate bug: it wrote its "last known version" to storage on every check regardless of whether the update was actually applied — so declining the prompt even once meant it would **never ask again** for that version, silently running stale code indefinitely.
- **Fixed**: the version marker only advances once an update is actually accepted and applied; added a 20-minute background auto-check (`setInterval(_checkForAppUpdate, 20*60*1000)`) so a long-open tablet gets prompted within roughly a shift, not only whenever someone happens to tap Sync. Guarded against stacking a duplicate prompt. 11-scenario test suite passing on both files.

### 3. localStorage quota — partially fixed, ONE STEP LEFT UNVERIFIED
A device hit `QuotaExceededError` (~9.93MB total, over the ~5-10MB browser limit) trying to save the shipping-approval recovery mutation.

- Diagnosed precisely via a real device: NOT embedded photos (~205KB only) — it was `stageHistory` (2.8MB total), of which **~2.4MB was duplicate signature images re-embedded at every single stage transition** (`_stageSnapshot()` stored whatever `data` object it was handed verbatim, including raw base64 signature images, forever, on top of the job's own current signature field holding the same image).
- **Fixed going forward (live, both files)**: `_stageSnapshot()` now recursively strips any embedded `data:image...` string out of what it's given, replacing it with `true` (keeps the audit fact "a signature was captured here," drops the weight). Verified no display feature reads an image back out of stageHistory, and the async Drive-upload-then-patch flow for signatures/photos still works correctly on top of this.
- **Historical cleanup attempted but NOT confirmed working — needs to be redone.** A one-time server-side script stripped existing embedded images from all 121 affected job records' `stageHistory`. It reported "Succeeded: 121, Failed: 0," but an independent re-verification immediately after showed the data **unchanged** (~2804KB still, 144 embedded images still found). Strong suspicion: the exact stale-tab problem from #2 above — an old, buggy background sync loop running in that same browser tab silently pushed the pre-cleanup data right back over the fix within the following ~30 seconds to a few minutes.
  - **Next step**: confirm the browser tab that will run this has been fully reloaded (hard refresh) so it's on current code — this alone may have been the entire problem, given #2 was only fixed and deployed partway through that session.
  - Re-run the dry-run script first (logs what WOULD change + sizes, writes nothing), confirm the numbers still show ~121 records / ~2.4MB, THEN run the real write script (both scripts are straightforward to reconstruct: fetch `/records?type=job`, recursively replace `data:image...` strings inside each `data.stageHistory[].data` with `true`, PUT only records that actually changed).
  - **Independently re-verify after** with a fresh server fetch (total stageHistory size across all jobs, count of remaining embedded images, and a spot-check that `qaSignature`/current signature fields on the jobs themselves are unchanged) — do not trust the write script's own success count alone, per the hard rule above.

### 4. Cloudflare D1 daily write-quota alert — root cause understood, resolved by user's own action
- The account hit Cloudflare's D1 free-tier 100k-writes/day cap and got a "service paused" email — bad timing, right after the user had presented this app.
- **Likely root cause**: a stale tablet running OLD sync code (from before fix #1's proper version) had a bug where, if it believed a record wasn't confirmed synced, it would re-push the ENTIRE ~339-record job store every 5-minute cooldown window — this session's direct-server-PUT recovery scripts (which deliberately bypassed local storage/snapshots to dodge the quota crash) likely left various records looking "unconfirmed" from that stale device's old-code perspective, potentially triggering repeated full-store re-pushes for hours.
- This class of bug is now fixed by #1 and #2 above (no more blind full-store resends; devices get nudged to update within ~20 minutes).
- **User has already upgraded to Workers Paid ($5/mo)** — their own decision after discussion; not something to revisit unless they raise it.

## NEXT GOAL — build a proper field-level (three-way) merge for job/NCR sync

**Explicit user requirement**: "whatever device started an entry will have priority" was the opening ask, refined through discussion to: **most recent CONFIRMED edit wins, at the field level** — like a shared Google Sheet, where two people editing different fields of the same row never stomp on each other. User was explicit: build this properly the first time, with the same test rigor as tonight's fixes — not a quick version to revisit later. Also explicit: build with future heavy-traffic/scale in mind, not just today's usage level.

### Design already agreed with the user (not yet implemented)

Three versions of any record are already available at sync time:
- **base** — the last version this device confirmed the server actually had (already tracked today via the sync snapshot, and now honest per fix #1 above)
- **local** — this device's current copy
- **remote** — the server's current copy

**Per top-level field:**
- Only local changed it from base → keep local's value
- Only remote changed it from base → take remote's value
- Neither changed it → no-op
- **Both changed it to different values → genuine conflict**, needs a tie-break rule (see below)

**Fields needing special handling, not plain overwrite:**
- `stageHistory` — must be **unioned**, never overwritten. It's an append-only audit log; both devices' entries are equally valid and neither side should ever lose entries. (Dedup by matching stage+ts+label, most likely.)
- `checklist` — already has a merge-by-item-id helper (`_mergeChecklist`, line ~6612 in `index.html` as of tonight) built for a similar problem (QA stages losing earlier stages' fields). Extend that same by-id merge logic into the sync path instead of a raw field overwrite.

**For genuine same-field conflicts** (rare — jobs normally move through one device at a time sequentially, make-ready → production → QA → shipping — so true simultaneous conflicting edits to the *same field* should be uncommon, but must still be handled correctly, not just assumed away):
- Proposed: add a lightweight per-record "last touched" timestamp, stamped automatically at the one true choke point every save already goes through (`ipSave()`, called by literally every job mutation path including `ipUpdate()`) — avoids needing to touch dozens of scattered call sites individually.
- Let the more recently-touched side win for that specific conflicting field.
- **Log the conflict itself into `stageHistory`** so it's visible later for audit purposes, never silently dropped/hidden.

### Before writing code
1. Confirm `ipSave()` is genuinely the single universal choke point for every job mutation (spot-checked tonight, looked correct, but verify thoroughly — grep for any place that writes directly to `localStorage.getItem(IN_PROGRESS_KEY)`/`setItem` bypassing `ipSave`/`ipLoad`).
2. Design the exact conflict-log shape for `stageHistory` before implementing (what fields, what the label says, whether it needs a dedicated `stage: 'merge_conflict'` type).
3. Decide whether this applies to `job` only, or also `ncr`/`ncr_draft` (NCR doesn't have `stageHistory`/`checklist` in the same shape — check its actual field list before assuming the same special-cases apply).
4. Build a standalone Node test harness (same pattern as tonight — extract the real function via `node -e`, mock `fetch`/`localStorage`) covering at minimum: non-overlapping field edits merge cleanly both ways, a genuine same-field conflict resolves via the tie-break and gets logged, `stageHistory` entries from both sides survive a merge with no duplicates and no loss, `checklist` merges by id correctly when both sides touched different items vs. the same item, and repeated/idempotent merges are stable.
5. Apply identically to `version-b/index.html` once proven, same as every other fix this session.
6. Ship, confirm live via fresh no-cache fetch, tell the user explicitly.

## Deploy mechanics (reference)

- **Frontend** (`index.html`, `version-b/index.html`): `git add`, `git commit`, `git push` — auto-deploys to GitHub Pages. Confirm live via a fresh no-cache `curl` fetch of a distinctive string from the change (a comment, a new function name), not just that the push succeeded.
- **Backend** (`cloudflare-backend/src/index.js`): no self-service deploy — hand the user the exact code to paste into the Cloudflare dashboard's Quick Edit.
- **Testing sync/data logic**: extract the real function(s) from the live file via a small Node script (`html.indexOf('function name')` + brace-matching), stub `fetch`/`localStorage`/whatever else is needed, run realistic scenarios, confirm pass/fail explicitly before shipping.

Ask what to pick up next, or just start on the field-level merge design above if nothing new has come in.

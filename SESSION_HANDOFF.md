# Handoff for a new chat — Moquin Press QA Checklist Approval work

Paste this whole file as your first message in a new chat to pick up where we left off without re-establishing permissions.

## Standing permission — act, don't ask

I've already granted standing permission to act autonomously on this project: push to GitHub, deploy/edit the Cloudflare Worker backend, run PowerShell/Bash commands on my actual machine — all without stopping to ask "can I do this?" first. This has been the real working pattern across this whole session. **Default to doing, not asking.**

The only things that actually stop you are *capability* walls, not permission — and no amount of me saying "yes" lifts these, so don't keep retrying past them, just tell me plainly which one you hit and hand me the specific step:

1. **`github.com` is a blocked domain** for your browser tool (Cloudflare Console and Google Cloud Console too).
2. On `script.google.com`/`docs.google.com`, screenshot and page-text-reading are blocked (privacy protection) even though clicking/navigating works fine.
3. **A separate safety classifier** can block one specific risky-looking action even after I've said yes in chat. This session it blocked one particular Cloudflare Worker credential-scope change (tried two different tools, twice, even after I approved it twice in chat). If you hit this again, stop and hand me the exact one-line diff to paste in myself, or tell me to unblock that action class in my Claude Code settings.

Full detail is saved in cross-session memory (`feedback-standing-autonomy`, `project-moquin-press-apps-overview`) and in `CLAUDE.md` in this project folder — read both before starting if you haven't already loaded them.

## Where things stand right now

**QA Checklist Approval app** (`Desktop\Anthony\A3 and Kaizen projects\QA Checklist Approval\index.html`, git repo, GitHub Pages + Cloudflare Pages, live at `anthonymancino222.github.io/qa-checklist/` and `moquin-qa-checklist.pages.dev`):

- **Schedule bridge** is fully built and live: I manually export the CERM job schedule to Excel, drop it in a Google Drive Shared Drive folder, and the app's Cloudflare Worker parses it (zero-dependency hand-rolled XLSX parser) to auto-fill Job/Customer/Product/Die on the job-entry screens. A second "Sales Orders" export backfills Product ID specifically for Label-cutter and Gluer jobs (the only stations that release by product number — everything else releases by form number). Two-row-header vs one-row-header detection is handled automatically.
- **Broken and NOT yet fixed**: the bridge folder's automatic cleanup (deletes files older than 5 days, via Drive Trash not permanent delete) still fails silently (`checked: N, trashed: 0`). Root cause confirmed: the service account's Google Drive API credential only has read-plus-own-file-write access, so it can only write files it created itself — bumping the folder's sharing role to Content Manager wasn't enough, since that's a permissions problem, not a scope problem. See `CLAUDE.md`'s schedule-bridge section for the exact fix (a one-line change in `cloudflare-backend/src/index.js`'s token-request function). I approved this fix twice in chat but the edit is blocked by the safety classifier described above — this still needs to actually get made and deployed.
- **Explicitly deferred, not started**: a Label-station (Bindery Cutter / Pressroom Cutter) equivalent of the Gluer sequential multi-product batch feature (Start Next Product button, popup/auto-fill for remaining product numbers) — same pattern, but gated on reaching **Shipping Approval** instead of QA Release, and without the "same CAD?" gate question. Those stations still use the older all-at-once wizard.
- **This session's UI work** (all deployed, all confirmed working in the live app):
  - Sticky "Start New" button in the black header banner (confirms before reloading), header button groups switched from center-aligned-on-mobile to right-aligned everywhere.
  - Station selection no longer auto-opens the job picker popup — only tapping the (now bigger, pink) "Pull Schedule" button does, paired with a "?" info button explaining what it does in 2-3 lines, bilingual.
  - "Test Job?" toggle asks "are you sure?" before switching to Yes.
  - Yellow ID-highlight (`hlId()` / `.id-hl`) extended to "Product ID" (renamed from "Product") and "Qty to Execute" everywhere they appear — job-summary cards *and* modal headers (continue-modal, shipping-modal, records view, RCA records).
  - Job-number matching dropdown now auto-dismisses after 3 seconds instead of lingering indefinitely if the field never blurs.
  - Fixed a real bug: alert/confirm popups (like the Pull Schedule info box) only rendered their text once at open time, so toggling language while one was open left it frozen in the old language even though the rest of the page switched. `showAlert`/`showConfirm` now take an optional `relang` callback that `toggleAppLang()` re-invokes for whichever popup is currently open.
  - Added a job search box (by job #, product, or customer) to **Job in Progress**, **QA Release**, and **Shipping Approval** — same pattern the Records view already had.

## Deploy mechanics (in case you need a refresher)

- **Frontend** (`index.html`): `git add`, `git commit`, `git push origin main` — auto-deploys to both GitHub Pages and Cloudflare Pages. GitHub Pages' CDN can lag a few minutes on propagation to a given edge/region — if something looks stale after a push, check the raw served file via `curl` before assuming it's a code bug (this cost real time this session).
- **Backend** (`cloudflare-backend/src/index.js`, gitignored, never pushed to GitHub): deployed via a raw multipart `PUT` to the Cloudflare API — no `wrangler`/npm available locally. See `CLAUDE.md` for the exact deploy-metadata setting needed to avoid wiping the backend's stored secrets on deploy. The Cloudflare API token lives in the session scratchpad, not this repo — it won't carry over to a new chat, so if a backend deploy is needed, expect to either find/recreate that token or ask me for it. (This file is committed to a public repo via GitHub Pages — never put the actual token here.)

Ask me what we should pick up next.

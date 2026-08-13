# Handoff for a new chat — Moquin Press QA Checklist / RCA / Gluer Shift Handoff work

Paste this whole file as your first message in a new chat to pick up where we left off without re-establishing permissions.

## Standing permission — act, don't ask

I've already granted standing permission to act autonomously on these projects: push to GitHub, deploy/edit the Cloudflare Worker, edit the Apps Script backend, run PowerShell commands on my actual machine — all without stopping to ask "can I do this?" first. This has been the real working pattern across multiple sessions already. **Default to doing, not asking.**

The only things that actually stop you are *capability* walls, not permission — and no amount of me saying "you have permission" lifts these, so don't keep retrying past them, just tell me plainly which one you hit and hand me the specific step:

1. **`github.com` is a blocked domain** for your browser tool, period. (Cloudflare Console and Google Cloud Console too.) `script.google.com`/`docs.google.com` are NOT blocked for navigating/clicking, though —
2. — but on those two Google domains, **screenshot and page-text-reading are blocked** (privacy protection), even though clicking/navigating works fine. Verify state there via described click results or direct `Invoke-WebRequest` calls to a public API/doGet endpoint, not screenshots.
3. **A separate safety classifier** can block one specific risky-looking action (e.g. it blocked clicking Apps Script's "Deploy" button specifically, mid-session, with permission already established and other clicks on the same page working). If this happens, stop and hand that one click back to me with exact instructions.

Everything else — `git commit`/`push`, Cloudflare dashboard edits via a connected browser tab, editing local `.gs`/`.html` files — just do directly.

Full detail on all of this is saved in your cross-session memory (`feedback-standing-autonomy`, `project-moquin-press-apps-overview`) and in `CLAUDE.md` in the QA Checklist Approval project folder — read both before starting if you haven't already loaded them.

## Where things stand right now

**QA Checklist Approval app** (`Desktop\Anthony\A3 and Kaizen projects\QA Checklist Approval\index.html`, git repo, GitHub Pages, live at anthonymancino222.github.io/qa-checklist/):
- RCA module is fully live (`RCA_LIVE = true`) — real Apps Script backend, token-based manager/close-out email deep links, multi-select option grids, full-screen loading overlay, upload-progress overlay across every station's photo submission.
- **Pending**: `TESTING_ALL_TO_ANTHONY = true` in the Apps Script backend routes every manager email to Anthony only — flip to `false` and redeploy once he confirms he's done testing RCA.
- Load-tag OCR scanner is re-enabled (reads printed text via Tesseract.js, not barcodes yet). A real barcode-*decoding* approach was discussed but not built: read all of a tag's stacked barcodes in one photo via the native `BarcodeDetector` API, map each to its field by vertical position, cross-check against OCR of the adjacent printed number.
- GitHub Pages source is deliberately set to "Deploy from a branch" (not Actions) after a multi-hour stuck-deployment incident during a real GitHub outage — see `CLAUDE.md` for the full story if a deploy ever gets stuck in `deployment_queued` again.

**Gluer Shift Handoff app** (`Desktop\Anthony\A3 and Kaizen projects\Gluer Shift Handoff\index.html`, NOT a git repo, manual GitHub upload to the `mp-shift-tools` repo): already has a mature multi-job save/resume system (an "Active Job" list, "+ Start New Job" that never touches existing jobs, "Save Progress" per-job drafts, named-confirmation switching) — confirmed this already covers "pause a job to run something else, come back later" before assuming it needs building.

Ask me what we should pick up next.

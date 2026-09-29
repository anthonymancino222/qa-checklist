# Session Handoff — QA Checklist Approval

Read this whole file before doing anything else. It exists so a brand-new
chat session can pick up exactly where the last one left off, with the same
working style Anthony expects — most importantly: **you push, not him.**

## 0. The one rule that matters most

**Anthony wants 99.9% of git commits and pushes done by you, unprompted.**
Once you've made a change and verified it (see §3), commit and push it
yourself. Do not pause to ask "should I commit this?" or "should I push
this?" — that's already answered: yes. This applies to both `index.html`
and `version-b/index.html` in this repo.

The only things that still need his explicit go-ahead are the genuinely
risky categories: destructive git operations (force-push, hard reset),
anything that touches real production data directly (a one-time backend
migration script, deleting real records), or a change whose behavior he
hasn't actually asked for yet (a brand-new feature idea you thought of on
your own, not something he requested). Routine feature work, bug fixes,
and refactors — the overwhelming majority of what happens in this repo —
get committed and pushed by you as soon as they're verified working.
When in doubt on a *normal* code change, push.

If it helps to know why: this has already been confirmed explicitly,
repeatedly, across many prior sessions. Re-litigating it wastes his time.

## 1. What this repo is

Two parallel single-file vanilla-JS web apps, no build step, everything
inline in one giant `<script>` tag:

- **`index.html`** — the main app. Backend is a **Cloudflare Worker + D1
  database** (`QA_BACKEND_URL` near the top of the script). Deploy is
  automatic: `git push` → GitHub Pages rebuilds → live at
  `https://anthonymancino222.github.io/qa-checklist/`. There is no
  separate deploy step for the frontend. The Worker backend itself is
  NOT redeployed by this repo's pushes (it's a different, rarely-touched
  system) — if a task ever needs a Worker-side change, that's a distinct,
  much rarer kind of edit; say so explicitly if you think you need one.
- **`version-b/index.html`** — a fork using a **Google Apps
  Script/JSONP backend** instead (`_qaJsonpGet`/`_qaWriteAndPoll`,
  static API key). Deployed the same way, at `.../qa-checklist/version-b/`.
  Its Apps Script backend source lives at `version-b/backend/Code.gs` and
  auto-deploys via `clasp` (already installed and logged in) — you can
  edit and push that too if a task genuinely requires it.

**Standing rule: almost every real fix or feature belongs in BOTH files,
applied identically** (adjusting only for the different backend transport
where the two already differ — e.g. `_syncReconcileBeforePush` uses a
per-record fetch in index.html vs `_qaJsonpGet({action:'listRecords'})` in
version-b). Never ship a fix to only one. Before editing, `grep`/`Read` the
equivalent spot in the other file first — they're usually byte-for-byte
identical outside their transport-specific seams, which makes copying
straightforward.

Both apps require Google Sign-In to do anything real — you cannot sign in
as a real user from the built-in isolated browser tool (no real Google
session there). See §3 for how to still verify UI changes without one.

## 2. Reading the code

The files are huge (20k+ lines). Don't try to read them start-to-finish.
- Use `Grep` for function names / class names / comment landmarks, not a
  cover-to-cover `Read`.
- Favicon/icon `<link>` tags near the very top contain enormous inline
  base64 data URIs — reading a line range that includes one will blow the
  token budget. If a `Read` of a small range mysteriously exceeds the
  token limit, that's why; narrow the range or skip past that line.
- Search for a function, read just its body with `offset`/`limit`, make
  the edit, move on.

## 3. Verification methodology (do this, every time)

Two layers, both real, neither optional:

**A. Node unit tests against the REAL extracted code.** Don't hand-write
a re-implementation of the function you're testing — brace-match extract
it verbatim out of the live HTML file, `eval` it into a mocked Node
environment, and assert against real scenarios. The pattern (recreate
these scripts in your scratchpad, they don't persist between sessions):

```js
// extract_X.js — pulls a function out of the file verbatim
const src = fs.readFileSync(file, 'utf8');
function extractFn(name) {
  const marker = 'function ' + name + '(';
  const start = src.indexOf(marker);
  let i = src.indexOf('{', start), depth = 0, end = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}
```
```js
// test_X.js — mocks globals (localStorage, fetch, document, ipLoad/ipSave,
// Date.now — and if a function reads `new Date()` directly, mock the
// Date CONSTRUCTOR too, not just Date.now, or tests flake by time of day),
// then loads the extracted code with INDIRECT eval so `var` declarations
// become real globals:
(0, eval)(code); // not eval(code) — that scopes to this function only
```

Run this against **both files** after any change to shared logic (merge,
sync, conflict-review, photo-heal, etc.) — regressions in one file's copy
of a function are exactly as real as in the other's.

**B. Live browser check, every time something is visually or behaviorally
observable.** Never claim a UI change works without actually seeing it
render. Since you can't sign in for real:
1. `preview_start` a plain static file server over the project directory
   (Node `http.createServer`, or add a `.claude/launch.json` entry — clean
   either up when done).
2. Navigate the built-in browser to it.
3. Via `javascript_tool`, hide `#google-signin-overlay` and show
   `#appLayout`, then seed whatever local state you need directly (e.g.
   `ipSave([{...fake job...}], {preserveTouch:true})`) and call the
   relevant `switchView(...)`/`open...Modal(...)` function.
4. Screenshot / `get_page_text` / click through it for real.
5. Stop the temp server (`Get-NetTCPConnection -LocalPort ... | ...
   OwningProcess` then `Stop-Process`) before finishing.

This has caught real bugs in this project before (an `_rvjEs` reference
left dangling after a refactor, a pencil-icon showing when it shouldn't
have) that unit tests alone would have missed entirely.

**C. Cloudflare/D1 checks (only when actually investigating production
traffic/data).** The built-in isolated browser can't sign in to
Cloudflare either — use `claude-in-chrome` (the user's real, already
logged-in Chrome) via
`ToolSearch("select:mcp__claude-in-chrome__tabs_context_mcp,...")` for
that. The D1 **Console** tab is flaky (typed queries silently vanish);
use **Explore Data → Studio** instead (top-right "Explore Data" button) —
a real Monaco SQL editor, click into the query pane by `ref` (not raw
pixel coordinates — this dashboard's viewport scaling has bitten this
exact investigation before), type SQL, `ctrl+Return` to run.

## 4. Recent history (most recent session, chronological)

This is what actually happened last session, so you're not caught flat-
footed if Anthony references it:

1. **Cloudflare rebrand**: pink → black + neon green (with pink kept as a
   rare "critical" accent, then partially reinstated per explicit
   feedback for a few specific elements — header pills are green, the 4
   main home-dashboard cards + their sidebar icons are pink, QA/Help stay
   green). If a color looks off, it was almost certainly a deliberate,
   explicit choice — check `git log -p` on the relevant lines before
   assuming it's wrong.
2. **Real incident, found and fixed**: a massive Cloudflare traffic spike
   (2.4M invocations/week vs a normal baseline) turned out to be one job
   whose `productNumber` field was ping-ponging between two devices'
   values 124 times over 4 days (a genuine sync conflict that kept
   auto-re-triggering), plus two job records with a ~3.9MB photo embedded
   directly instead of uploaded to Drive. Root-caused via direct D1 SQL
   queries (see §3C), not guesswork.
3. Built a **field-level sync conflict system**: `_mergeJobRecord` still
   auto-resolves any two-device conflict immediately (never blocks a
   sync), but now (a) freezes a field once it's already an unresolved
   pending conflict instead of letting it flip forever, and (b) surfaces
   every pending conflict in a new **⚠ Conflicts header button** (amber,
   only visible when count > 0) where a QA Manager can pick "Keep mine /
   Keep theirs / Keep both" per field.
4. Built **`_healEmbeddedPhotos()`**: runs opportunistically off the
   existing idle-background tick, retries any photo/signature that's
   still a raw embedded `data:` URL (meaning its original Drive upload
   silently failed) and swaps in the real Drive link once it succeeds. No
   manual cleanup script should ever be needed again for this class of
   problem.
5. **Records job-detail popup is now editable** for `_isDataEditAllowedUser()`
   accounts (Job #, Station, Customer, Product ID/Form ID, Qty to
   Execute, Final Qty Produced where a real number applies) — pencil
   icons, reusing the existing `_startEditField` pattern.
6. **`SHIP_AUTO_APPROVE_TESTING` removed outright** (not just switched
   off) — there is now no code path anywhere in either app that can
   approve a shipment except a real person completing the Shipping
   Approval screen.
7. Confirmed (and reverted a wrong first attempt at changing) that a job
   pending Shipping Approval is *supposed to* also show in Records with a
   "not yet approved" status, updating in place once approved — Records
   was never meant to hide it.

## 5. Known outstanding items (not yet done — pick these up if relevant)

- **Two job records still have an oversized embedded photo**
  (`qc-1790424685850-0` and `-1`, job #049318, ~3.9MB/~3.7MB `mrPhoto`
  each). A one-time migration script was written and sent to Anthony to
  paste into his own signed-in browser console (dry-run first, real
  write only on explicit second command) — check with him whether he's
  run it yet before assuming it's still needed. §4 item 4 above prevents
  new instances of this, but doesn't retroactively fix these two.
- **Job #46850's `productNumber` conflict** (the one that was
  ping-ponging) is now frozen, not auto-re-flipping, but still needs a
  human to actually open the ⚠ Conflicts button and pick the correct
  final value — the real answer (probably `118045`, based on its three
  sibling product lines being `118043`/`118044`/`118046`, but don't just
  guess-write it yourself; confirm with Anthony or leave it for him).
- **`version-b`'s NCR photo compression** was already brought in line
  with `index.html` last session — no longer outstanding, just noting it
  here so a future session doesn't re-flag it as a gap.

## 6. Standing hard rules (recap — full detail lives in memory, auto-loaded)

- Data safety + quota check on every backend-touching change, including
  new periodic/background calls, not just writes — this app has a real,
  documented history of a Cloudflare quota incident from exactly this
  kind of oversight.
- Always clean up test/demo data you create against the real backend
  before considering a task done.
- After a `git push` that deploys something, explicitly tell Anthony it's
  live — don't just report the push succeeded.
- Pair any non-trivial technical explanation with a short, plain-English
  version too.
- When you spot a minor related issue while working, fix it now instead
  of just flagging it as optional follow-up work.

## 7. Untracked files sitting in the repo root

`BACKEND_GUIDE.md`, `QA Data Backend Guide.html`, `Packing reference
photo/`, `cloudflare paid receipt/`, `photo references for certain non
common process features/`, `version-b/desktop.ini` are untracked but
present locally — leave them alone unless Anthony asks about them
specifically; they look like his own reference material, not stray build
artifacts.

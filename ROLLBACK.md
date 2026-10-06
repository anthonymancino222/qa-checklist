# If the app ever stops working (read this at home, in a hurry)

**Step 1 — get everyone working again right now (no coding, 10 seconds):**
Tell staff to open the **stable version**:

    https://anthonymancino222.github.io/qa-checklist/stable/

It is the last version that passed every automatic check and was confirmed working. It uses the *same
data and the same sign-in*, so nothing is lost. (If the main app can't start, it also shows a red bar at
the top with a one-tap link to this page.)

**Step 2 — fix the main app:**
Tell Claude: **"roll back"** (or "the app is broken, undo the last change"). Claude reverts the last change
as a new commit and publishes it. Nothing is erased.

## How we prevent this in the first place
- `tests/smoke.js` loads the real app several times (empty device, device with saved contacts, device with
  saved records) and exercises the Long Gluer submit, NCR / Sales Approval, CAR, Records, and every screen.
- A git **pre-push hook** (`.githooks/pre-push`) runs it on every push. If anything fails, the push is
  blocked, so a broken version can never be published from this computer.
- The last line of the main script sets `window.__QA_BOOT_OK`. If the app didn't finish starting, the test
  fails and, on a device, the red "open stable version" bar appears.
- Features that depend on something outside the app (like the Google script) ship switched OFF and are
  switched on only after the other side is confirmed deployed.

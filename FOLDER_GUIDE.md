# What is where (QA Checklist Approval folder)

Everything for the QA app lives in this one folder.

## Published on the web (GitHub Pages) — safe to be public
| Item | What it is |
|---|---|
| `index.html` | **The app.** The only file staff open. |
| `stable/index.html` | Copy of the last version that passed every check and was confirmed working. Fallback if the main app breaks. |
| `tests/smoke.js` | Automatic safety test. Runs before every publish. |
| `tools/` | `promote-stable.sh` (mark a version as stable), `rollback.sh` (undo the last change). |
| `ROLLBACK.md` | What to do if the app ever breaks. |
| `.githooks/pre-push` | Blocks publishing if the safety test fails. |

## Stays on this computer only (listed in `.gitignore`, never published)
| Folder | What it is |
|---|---|
| `google-script/RCA_AppScript_v3.gs` | The email script that runs on Google. **Edit it here**, then deploy it (paste into Apps Script, or push with clasp once signed in). |
| `google-script/backups/` | Dated copies of the script from before each change. |
| `google-script/one-time-scripts/` | Console scripts used once (contacts seed, old-Sheet migration). |
| `cloudflare-backend/` | The database Worker code. |
| `OLD/` | Retired material (including the old standalone CAR/RCA form, SOP documents and old submitted forms: `OLD/RCCA Form (legacy)/`). |

## Why the Google script is not published
GitHub Pages publishes every committed file at a public web address. The script contains an export key and manager
email lists, so it is kept out of the repository. The Google copy itself is the live one; this folder holds the source and backups.

## Where the data lives
One database (Cloudflare D1) holds jobs, NCRs, CARs and the contacts list. Google is used only to send email.

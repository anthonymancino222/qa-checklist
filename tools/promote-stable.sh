#!/bin/sh
# Marks the CURRENT index.html as the "last stable" version (served at /stable/). Run only after the
# smoke test passed AND the live site was checked. Staff fall back to /stable/ if the main app breaks.
cd "$(git rev-parse --show-toplevel)" || exit 1
node tests/smoke.js > .smoke-last.txt 2>&1 || { echo "Smoke test failed - not promoting."; exit 1; }
mkdir -p stable && cp index.html stable/index.html
git add stable/index.html && git commit -m "Promote current version to stable (smoke test passed, verified live)" && git push

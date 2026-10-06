#!/bin/sh
# Emergency undo: reverts the most recent commit (as a NEW commit, nothing is erased) and publishes it.
cd "$(git rev-parse --show-toplevel)" || exit 1
git revert --no-edit HEAD && git push

#!/bin/bash
# SessionStart hook for Claude Code cloud sessions (single-repo sessions only:
# a session opened across several repositories does not load repo hooks).
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

# Dependencies, so `npm test` and `npm run build` work immediately. Skipped when
# node_modules is already newer than the lockfile (cached environments).
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm install --no-audit --no-fund --loglevel=error
fi

# Name any host the environment's network policy blocks, with the fix.
bash scripts/egress-preflight.sh
exit 0

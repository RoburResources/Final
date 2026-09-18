#!/bin/bash
# Egress preflight for Claude Code cloud sessions.
#
# Checks every external host this project needs and separates "blocked by the
# environment's network policy" from "host is down". A policy block cannot be
# fixed from inside a session (the proxy refuses CONNECT with 403), so the
# script prints the exact environment change instead of failing silently.
# Always exits 0: a blocked host is a report, not a crash.

HOSTS="${EGRESS_HOSTS:-elevenlabs.io api.elevenlabs.io devoted-firsthand-queryoptimizer.replit.app addison-executive-production.up.railway.app code.claude.com}"

blocked=()
down=()
ok=()
for h in $HOSTS; do
  err=$(curl -sS -o /dev/null -m 8 --head "https://$h/" 2>&1 >/dev/null)
  rc=$?
  if [ $rc -eq 0 ]; then
    ok+=("$h")
  elif printf '%s' "$err" | grep -q 'CONNECT tunnel failed, response 403'; then
    blocked+=("$h")
  else
    down+=("$h (${err:-curl exit $rc})")
  fi
done

[ ${#ok[@]} -gt 0 ] && echo "egress ok: ${ok[*]}"
[ ${#down[@]} -gt 0 ] && printf 'egress unreachable (host side, not policy):\n  %s\n' "${down[@]}"

if [ ${#blocked[@]} -gt 0 ]; then
  cat <<MSG
EGRESS BLOCKED by this cloud environment's network policy (not by the hosts):
$(printf '  - %s\n' "${blocked[@]}")
This cannot be changed from inside a session. Fix (about one minute, applies to
sessions started afterwards): claude.ai/code -> environment selector (cloud icon)
-> hover the environment in use -> settings icon -> Network access -> "Full"
(or "Custom", list the hosts above one per line, and tick "Also include default
list of common package managers") -> Save changes. Then start a new session.
MSG
fi
exit 0

#!/usr/bin/env bash
# Print one ready-to-paste message per attendee seat, with its private desktop link.
# Each link controls one desktop: send each message to ONE attendee only.
# Usage: scripts/workshop/links.sh [stage=event]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
OUT="$(workshop_dir "${1:-event}")"
[ -f "$OUT/status.json" ] || { echo "No workshop stage '${1:-event}' in $WORKSHOP_HOME" >&2; exit 1; }
python3 - "$OUT" <<'PY'
import json, os, sys, glob
out = sys.argv[1]
status = json.load(open(os.path.join(out, "status.json")))
ready = 0
for path in sorted(glob.glob(os.path.join(out, "attendee*", "control.json"))):
    seat = os.path.basename(os.path.dirname(path)); number = int(seat.replace("attendee", ""))
    link = json.load(open(path)).get("viewer")
    if not link:
        print(f"── Seat {number:02d}: NOT READY — scripts/workshop/seat.sh {seat} prepare {os.path.basename(out)}\n"); continue
    ready += 1
    print(f"── Seat {number:02d} ({seat}) — copy everything below this line ──")
    print(f"Here's your private OpenWork workshop desktop (seat {number:02d}): {link}")
    print("It's yours alone, so please don't forward it. Open it in Chrome; full screen is best. If it ever looks frozen, reload the page.\n")
print(f"{ready}/{status.get('seatCount')} seats have links · expires {status.get('expiresAt')}")
PY

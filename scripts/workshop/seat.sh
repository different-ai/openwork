#!/usr/bin/env bash
# Act on one attendee's desktop without touching anyone else.
# Usage: scripts/workshop/seat.sh <attendeeNN> <status|task|stop|unlock|reset|prepare|link> [stage=event]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
SEAT="${1:?seat, e.g. attendee07}"; CMD="${2:?command}"; STAGE="${3:-event}"
case "$SEAT" in attendee[0-9][0-9]) ;; *) echo "Seat must look like attendee07." >&2; exit 1 ;; esac
DIR="$(workshop_dir "$STAGE")/$SEAT"
[ -f "$DIR/control.json" ] || { echo "No seat $SEAT in stage $STAGE." >&2; exit 1; }
if [ "$CMD" = link ]; then python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("viewer","(no link yet)"))' "$DIR/control.json"; exit 0; fi
workshop_env 0
node worlds/workshop-pair-check.ts "$DIR" "$CMD" 2>&1 | grep -v 'Version mismatch'

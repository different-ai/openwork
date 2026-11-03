#!/usr/bin/env bash
# Start a workshop: one private Den + N attendee desktops.
# Usage: scripts/workshop/start.sh <seats> [lifetime-minutes=360] [stage=event] [budget-usd=200]
# Start 60-120 minutes before the session (workplace OAuth approvals last ~8 hours).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
SEATS="${1:?usage: start.sh <seats 1-99> [lifetime-minutes] [stage] [budget-usd]}"
LIFETIME="${2:-360}"; STAGE="${3:-event}"; BUDGET="${4:-200}"
case "$STAGE" in ""|-*|*[!A-Za-z0-9-]*) echo "Stage must be letters, digits and dashes." >&2; exit 1 ;; esac
OUT="$(workshop_dir "$STAGE")"
if [ -e "$OUT/status.json" ]; then echo "Stage '$STAGE' already exists in $OUT. Use a new stage name, or stop it first." >&2; exit 1; fi
mkdir -p "$WORKSHOP_HOME" && chmod 700 "$WORKSHOP_HOME" && mkdir -m 700 -p "$OUT"
workshop_env 1
export OPENWORK_EVAL_REF="$WORKSHOP_REF"
snapshot_args=(); [ -n "$WORKSHOP_SNAPSHOT" ] && snapshot_args=(--snapshot "$WORKSHOP_SNAPSHOT")
echo "Starting $SEATS seats (stage $STAGE, lifetime $LIFETIME min) at $(date '+%H:%M')…"
pnpm world up workshop-pair --place daytona --os linux --stage "$STAGE" --detach --timeout 3000000 -- \
  --output-dir "$OUT" --seats "$SEATS" --lifetime "$LIFETIME" --concurrency 10 \
  --timezone "$WORKSHOP_TIMEZONE" --budget-usd "$BUDGET" ${snapshot_args[@]+"${snapshot_args[@]}"} || true
[ -f "$OUT/status.json" ] || { echo "The launch stopped before creating anything; see the error above." >&2; exit 1; }
python3 - "$OUT/status.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(f"\nREADY: {d.get('readySeats')}/{d.get('seatCount')} seats in {d.get('readySeconds')}s · expires {d.get('expiresAt')}")
for key, seat in d.get("seats", {}).items():
    if not seat.get("ready"):
        print(f"  NOT READY {key}: {(seat.get('failure') or 'still starting')[:160]}")
if d.get("failure"): print("SHARED FAILURE:", d["failure"][:300])
PY
echo "Hand-out messages: scripts/workshop/links.sh $STAGE"

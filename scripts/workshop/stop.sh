#!/usr/bin/env bash
# Tear down one workshop stage (its Den and every desktop it created).
# Usage: scripts/workshop/stop.sh [stage=event]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
STAGE="${1:-event}"
workshop_env 0
pnpm world down workshop-pair --stage "$STAGE"
python3 - "$(workshop_dir "$STAGE")/status.json" <<'PY' || true
import json, sys
print("Stopped run", json.load(open(sys.argv[1])).get("runId"))
PY

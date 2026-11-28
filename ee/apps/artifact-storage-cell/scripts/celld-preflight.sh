#!/usr/bin/env bash
# Proves the Worker as a fleet would run it, before a fleet gets it: bundles and deploys it to a throwaway bucket
# prefix with a random token, serves it from one real celld node, checks the HTTP contract (scripts/celld-smoke.mjs),
# then restarts the node with an empty disk and reads the same rows back from the bucket.
#
#   CELLD_BUCKET=s3://bucket/ci/<unique> scripts/celld-preflight.sh
#
# Give it a prefix nothing else uses, and remove the prefix afterwards. Object-store credentials and settings come
# from the environment, as for celld-deploy.sh. The fleet's own token is not needed and not used.
set -euo pipefail
umask 077

project=$(cd "$(dirname "$0")/.." && pwd)
binary=${CELLD_BIN:-celld}
bucket=${CELLD_BUCKET:?set CELLD_BUCKET to a throwaway bucket prefix, such as s3://bucket/ci/<unique>}
work=$(mktemp -d "${TMPDIR:-/tmp}/openwork-artifact-preflight.XXXXXX")
pid=''
stop() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    pid=''
  fi
}
cleanup() {
  code=$?
  stop
  # celld's own events, without its periodic lines; long hex strings (the random token is one) are cut out.
  if [[ "$code" -ne 0 && -f "$work/node.log" ]]; then
    grep -v -E 'log_ship_loop|node_lease_attempt|celld::memory' "$work/node.log" | tail -40 | sed -E 's/[0-9a-f]{40,}/<hex>/g' | cut -c1-400 >&2 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ARTIFACT_STORAGE_TOKEN=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
export ARTIFACT_STORAGE_TOKEN
env -u ARTIFACT_STORAGE_TOKEN_FILE CELLD_BIN="$binary" CELLD_BUCKET="$bucket" bash "$project/scripts/celld-deploy.sh"

port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })')
export ARTIFACT_STORAGE_URL="http://127.0.0.1:$port"
start() {
  CELLD_DURABILITY=bucket CELLD_TTL_MS=60000 CELLD_WATCH="$work/watch" "$binary" --bucket "$bucket" --listen "127.0.0.1:$port" >> "$work/node.log" 2>&1 &
  pid=$!
  for ((attempt = 0; attempt < 180; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then echo 'the celld node stopped before it was healthy' >&2; return 1; fi
    if curl -fs --max-time 1 "$ARTIFACT_STORAGE_URL/health" >/dev/null; then return 0; fi
    sleep 0.5
  done
  echo 'the celld node did not become healthy' >&2
  return 1
}

start
node "$project/scripts/celld-smoke.mjs" write
stop
rm -rf "$work/watch"
start
node "$project/scripts/celld-smoke.mjs" read
echo 'PASS: the deployed Worker serves the contract, and a fresh node read the acknowledged rows back from the bucket'

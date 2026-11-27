#!/usr/bin/env bash
set -euo pipefail
umask 077

project=$(cd "$(dirname "$0")/.." && pwd)
den="$project/../den-api"
binary=${CELLD_BIN:-celld}
export CELLD_ESBUILD=${CELLD_ESBUILD:-"$project/node_modules/.bin/esbuild"}
work=$(mktemp -d "${TMPDIR:-/tmp}/openwork-artifact-celld.XXXXXX")
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
  if [[ "$code" -ne 0 && -f "$work/celld.log" ]]; then tail -60 "$work/celld.log" >&2; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$project/wrangler.jsonc" "$work/"
cp -R "$project/src" "$work/"
ln -s "$project/node_modules" "$work/node_modules"
export OPENWORK_ARTIFACT_STORAGE_CELLD_TOKEN=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
printf 'ARTIFACT_STORAGE_TOKEN=%s\n' "$OPENWORK_ARTIFACT_STORAGE_CELLD_TOKEN" > "$work/.dev.vars"
port=$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close() })')
export OPENWORK_ARTIFACT_STORAGE_CELLD_URL="http://127.0.0.1:$port"

start() {
  "$binary" dev "$work" --host 127.0.0.1 --port "$port" --no-watch --logs >> "$work/celld.log" 2>&1 &
  pid=$!
  for ((attempt = 0; attempt < 200; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then return 1; fi
    if curl -fs --max-time 1 "$OPENWORK_ARTIFACT_STORAGE_CELLD_URL/health" >/dev/null; then return 0; fi
    sleep 0.2
  done
  echo 'celld dev did not become healthy' >&2
  return 1
}

restart_probe() {
  node --conditions=development --import tsx --input-type=module - "$1" <<'JS'
import assert from "node:assert/strict"
import { createCelldStorageBackend } from "./src/mcp-app-storage/celld-backend.ts"

const backend = createCelldStorageBackend({
  url: process.env.OPENWORK_ARTIFACT_STORAGE_CELLD_URL,
  token: process.env.OPENWORK_ARTIFACT_STORAGE_CELLD_TOKEN,
  schema: { version: 1, statements: ["CREATE TABLE IF NOT EXISTS probe (message TEXT NOT NULL)"] },
})
const ref = { organizationId: `org_${"0".repeat(26)}`, appId: `cob_${"0".repeat(26)}` }
const message = "durable across restart"
if (process.argv[2] === "write") {
  assert.deepEqual((await backend.write(ref, [{ sql: "INSERT INTO probe VALUES (?)", params: [message] }])).changes, [1])
} else {
  assert.deepEqual(await backend.query(ref, { sql: "SELECT message FROM probe" }), { rows: [{ message }] })
  console.log("PASS: celld dev preserved the acknowledged row across restart without --clean")
}
JS
}

cd "$den"
start
node --conditions=development --import tsx --test test/mcp-app-storage-backends.test.ts
restart_probe write
stop
start
restart_probe read

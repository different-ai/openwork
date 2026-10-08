#!/usr/bin/env bash
# Runs the Warden CLI on a fork PR inside a sandbox (contributor-warden.yml).
#
#   warden container   the PR's files and git objects (read-only), the Warden
#                      CLI (read-only), a dummy API key, no host filesystem,
#                      no Linux capabilities, non-root, read-only root, and a
#                      network that reaches only the proxy. Even if text in
#                      the diff steers the model into reading any file, there
#                      is no key to read and no way to send anything out.
#   proxy container    holds the real key and forwards only allowed model
#                      calls (warden-model-proxy.mjs).
#
# Required env: PR_DIR GIT_COMMON_DIR WARDEN_CLI_DIR PI_DIR OUT_DIR CONFIG
#   RANGE OPENAI_API_KEY PROXY_SCRIPT ALLOWED_MODELS IMAGE
# Optional: UPSTREAM (test double), SANDBOX_PROBE=1 (prints what the sandbox
#   can see instead of running Warden), SANDBOX_NAME.
set -euo pipefail

for name in PR_DIR GIT_COMMON_DIR WARDEN_CLI_DIR PI_DIR OUT_DIR CONFIG RANGE OPENAI_API_KEY PROXY_SCRIPT ALLOWED_MODELS IMAGE; do
  if [ -z "${!name:-}" ]; then echo "::error::$name is required"; exit 1; fi
done

name="${SANDBOX_NAME:-warden-sandbox}"
network="$name-net"
proxy="$name-proxy"

cleanup() {
  docker logs "$proxy" 2>&1 | sed 's/^/[proxy] /' || true
  docker rm -f "$proxy" > /dev/null 2>&1 || true
  docker network rm "$network" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Pi reads provider settings from models.json: send every OpenAI call to the
# proxy with a placeholder key.
node -e '
  const fs = require("node:fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.providers ??= {};
  config.providers.openai = { ...(config.providers.openai ?? {}), baseUrl: process.argv[2], apiKey: "sandboxed" };
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
' "$PI_DIR/models.json" "http://$proxy:8080/v1"

mkdir -p "$OUT_DIR" "$OUT_DIR/logs" "$PR_DIR/.warden/logs"
chmod 0777 "$OUT_DIR" "$OUT_DIR/logs"

# --internal: no route to the internet or the host.
docker network create --internal "$network" > /dev/null

# The key goes in by name (-e OPENAI_API_KEY), so it never appears on a
# command line. The proxy joins the sandbox network and keeps its own egress.
docker run -d --name "$proxy" \
  --read-only --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 \
  --memory 256m --pids-limit 64 \
  -e OPENAI_API_KEY -e ALLOWED_MODELS -e MAX_REQUESTS="${MAX_REQUESTS:-3000}" ${UPSTREAM:+-e UPSTREAM} \
  -v "$PROXY_SCRIPT:/proxy.mjs:ro" \
  "$IMAGE" node /proxy.mjs > /dev/null
docker network connect "$network" "$proxy"
if [ -n "${UPSTREAM_NETWORK:-}" ]; then docker network connect "$UPSTREAM_NETWORK" "$proxy"; fi

for _ in $(seq 1 30); do
  docker logs "$proxy" 2>&1 | grep -q "proxy ready" && break
  sleep 1
done

# The worktree's .git file points at GIT_COMMON_DIR by absolute path, so it is
# mounted at the same path. Every mount is read-only except the output.
sandbox=(
  docker run --rm --network "$network"
  --read-only --tmpfs /tmp:rw,size=512m --cap-drop ALL --security-opt no-new-privileges
  --user "$(id -u):$(id -g)" --memory 6g --pids-limit 512
  -e HOME=/tmp -e PI_CODING_AGENT_DIR=/opt/pi -e WARDEN_OPENAI_API_KEY=sandboxed -e OPENAI_API_KEY=sandboxed
  -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*'
  -v "$PR_DIR:/work/pr:ro"
  -v "$OUT_DIR/logs:/work/pr/.warden/logs"
  -v "$GIT_COMMON_DIR:$GIT_COMMON_DIR:ro"
  -v "$WARDEN_CLI_DIR:/opt/warden:ro"
  -v "$PI_DIR:/opt/pi:ro"
  -v "$OUT_DIR:/out"
  -w /work/pr
  "$IMAGE"
)

# Check the sandbox from the inside, the way Warden's Read tool would see
# it, before Warden runs. Any violation stops the run (the check then reports
# an incomplete review, which holds the PR).
"${sandbox[@]}" node -e '
  const fs = require("node:fs");
  const problems = [];
  const keys = fs.readFileSync("/proc/self/environ", "utf8").split("\0").filter((line) => /api_key/i.test(line));
  if (keys.some((line) => !line.endsWith("=sandboxed"))) problems.push("a real API key is visible");
  // Only .git is mounted from the trusted checkout; its siblings, the
  // runner temp dir and the runner home must not be visible.
  const hostPaths = [require("node:path").dirname(process.argv[1]) + "/.github", "/home/runner/work/_temp", "/home/runner/.ssh", "/home/runner/.config"];
  const visible = hostPaths.filter((path) => fs.existsSync(path));
  if (visible.length) problems.push("host files are visible: " + visible.join(", "));
  try { fs.writeFileSync("/work/pr/.sandbox-write-test", "x"); problems.push("PR files are writable"); } catch {}
  const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
  Promise.all([
    Promise.race([fetch("https://api.openai.com").then(() => "reachable", () => "blocked"), timeout(5000)]),
    Promise.race([fetch("http://" + process.argv[2] + ":8080/v1/models").then((r) => r.status, () => "unreachable"), timeout(5000)]),
  ]).then(([internet, proxy]) => {
    if (internet === "reachable") problems.push("the internet is reachable");
    if (proxy !== 404) problems.push("the proxy is not reachable or not filtering (" + proxy + ")");
    console.log(`sandbox check: keys=${keys.map((line) => line.split("=")[0]).join(",")} internet=${internet} proxy=${proxy}`);
    if (problems.length) { console.log("::error::Sandbox check failed: " + problems.join("; ")); process.exit(1); }
  });
' "$GIT_COMMON_DIR" "$proxy"

if [ "${SANDBOX_PROBE:-}" = "1" ]; then exit 0; fi

"${sandbox[@]}" node /opt/warden/node_modules/@sentry/warden/bin/warden.js "$RANGE" -C /work/pr \
  --config-path "$CONFIG" --runtime pi --fail-on off --log -o /out/warden.jsonl

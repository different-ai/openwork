#!/usr/bin/env bash

set -euo pipefail

readonly entitlements="apps/desktop/build/entitlements.mac.plist"
readonly survival_seconds=10

shopt -s nullglob
apps=(apps/desktop/dist-electron/mac*/OpenWork.app)
if [[ ${#apps[@]} -ne 1 ]]; then
  echo "Expected exactly one packaged macOS app, found ${#apps[@]} under apps/desktop/dist-electron." >&2
  exit 1
fi

readonly app_path="${apps[0]}"
readonly executable="$app_path/Contents/MacOS/OpenWork"
if [[ ! -x "$executable" ]]; then
  echo "Packaged app executable is missing or not executable: $executable" >&2
  exit 1
fi

echo "Ad-hoc signing $app_path with $entitlements"
codesign --force --deep --sign - --entitlements "$entitlements" "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"

readonly user_data="$(mktemp -d "${TMPDIR:-/tmp}/openwork-launch-gate.XXXXXX")"
readonly stdout_log="$user_data/stdout.log"
readonly stderr_log="$user_data/stderr.log"
app_pid=""

cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  rm -rf "$user_data"
}
trap cleanup EXIT

echo "Launching packaged app and requiring it to survive for ${survival_seconds}s"
readonly launch_started="$(date '+%Y-%m-%d %H:%M:%S')"
OPENWORK_ELECTRON_USERDATA="$user_data/profile" \
OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN=1 \
OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION=1 \
ELECTRON_EXTRA_LAUNCH_ARGS="--headless --disable-gpu" \
  "$executable" >"$stdout_log" 2>"$stderr_log" &
app_pid=$!

sleep "$survival_seconds"
if kill -0 "$app_pid" 2>/dev/null; then
  echo "PASS: packaged app survived launch for ${survival_seconds}s (pid $app_pid)."
  exit 0
fi

set +e
wait "$app_pid"
status=$?
set -e
app_pid=""

signal_message=""
if [[ $status -gt 128 ]]; then
  signal_number=$((status - 128))
  signal_name="$(kill -l "$signal_number" 2>/dev/null || echo UNKNOWN)"
  signal_message=", signal $signal_number SIG${signal_name#SIG}"
fi

echo "FAIL: packaged app exited before ${survival_seconds}s (exit $status${signal_message})." >&2
if [[ $status -eq 137 ]]; then
  echo "Exit 137 / SIGKILL is consistent with macOS AMFI rejecting a restricted entitlement." >&2
fi

echo "--- packaged app stdout ---" >&2
cat "$stdout_log" >&2 || true
echo "--- packaged app stderr ---" >&2
cat "$stderr_log" >&2 || true
echo "--- signed app entitlements ---" >&2
codesign --display --entitlements :- "$app_path" >&2 || true
echo "--- recent AMFI system log entries ---" >&2
/usr/bin/log show --start "$launch_started" --style compact \
  --predicate '(process == "amfid" OR subsystem == "com.apple.AMFI" OR eventMessage CONTAINS[c] "AMFI") AND (eventMessage CONTAINS[c] "OpenWork.app" OR eventMessage CONTAINS[c] "Restricted entitlements" OR eventMessage CONTAINS[c] "provisioning profile")' \
  >&2 || true

exit 1

#!/usr/bin/env bash
set -euo pipefail
umask 077
export DISPLAY=${DISPLAY:-:99}
persona=${1:?Usage: chromium.sh employee|admin [URL]}
shift
args=()
case "$persona" in
  employee) ;;
  admin) args+=(--remote-debugging-port=9224 --remote-debugging-address=127.0.0.1) ;;
  *) exit 2 ;;
esac
browser=$(command -v chromium || command -v google-chrome || command -v google-chrome-stable)
mkdir -p "$HOME/demo/state/$persona"
exec "$browser" --no-sandbox --disable-dev-shm-usage --no-first-run \
  --user-data-dir="$HOME/demo/state/$persona" "${args[@]}" -- "$@"

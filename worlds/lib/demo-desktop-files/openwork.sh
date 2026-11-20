#!/usr/bin/env bash
set -euo pipefail
umask 077
export DISPLAY=${DISPLAY:-:99}
state="$HOME/demo/state/openwork"
export XDG_CONFIG_HOME="$state/config" XDG_DATA_HOME="$state/data"
export XDG_CACHE_HOME="$state/cache" XDG_STATE_HOME="$state/state"
export XDG_DATA_DIRS="$HOME/.local/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export OPENWORK_ELECTRON_USERDATA="$state/electron"
export OPENWORK_AUTOMATION_RUNNER=off
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$OPENWORK_ELECTRON_USERDATA"
# Internal sign-in uses the same employee browser and returns via openwork://.
cp "$HOME/.local/share/applications/demo-mimeapps.list" "$XDG_CONFIG_HOME/mimeapps.list"
cd "$HOME"
exec /opt/openwork-demo/openwork-cloud --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1 "$@"

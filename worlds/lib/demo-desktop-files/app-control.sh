#!/usr/bin/env bash
set -euo pipefail
umask 077
state="$HOME/demo/state"
mkdir -p "$state"
exec 9>"$state/app.lock"
flock -x 9
cdp() { curl --noproxy '*' --max-time 2 -fsS http://127.0.0.1:9223/json/list | jq -e 'any(.[]; .type == "page" and (.url | startswith("file://")))' >/dev/null; }
if [[ ${1:-} == restart ]]; then
  pid=$(cat "$state/app.pid" 2>/dev/null || true)
  if [[ $pid =~ ^[0-9]+$ && $(readlink "/proc/$pid/exe" || true) == "$(readlink -f /opt/openwork-demo/openwork-cloud)" ]]; then
    kill -TERM "$pid"
    for _ in $(seq 1 30); do
      [[ -e /proc/$pid/exe ]] || break
      sleep 1
    done
    [[ ! -e /proc/$pid/exe ]] || { echo 'OpenWork did not exit.' >&2; exit 1; }
  fi
fi
if ! cdp 2>/dev/null; then
  # Escape the Daytona exec session, and do not let Electron inherit the lock.
  python3 - "$HOME/demo/openwork.sh" "$state" <<'PY'
import pathlib, subprocess, sys
state = pathlib.Path(sys.argv[2])
with (state / "app.log").open("wb") as log:
    app = subprocess.Popen([sys.argv[1]], stdin=subprocess.DEVNULL, stdout=log,
                           stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
(state / "app.pid").write_text(str(app.pid))
PY
fi
for _ in $(seq 1 75); do
  if cdp 2>/dev/null; then exit 0; fi
  sleep 1
done
echo 'Packaged OpenWork did not expose a renderer on guest CDP.' >&2
exit 1

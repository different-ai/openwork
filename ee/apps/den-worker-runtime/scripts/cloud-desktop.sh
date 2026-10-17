#!/bin/sh
set -eu
state="$1/cloud-desktop"
display="$2"
case "$display" in :[0-9]|:[0-9][0-9]|:[0-9][0-9][0-9]) ;; *) echo "Invalid cloud display" >&2; exit 1 ;; esac
command -v chromium >/dev/null
command -v Xvfb >/dev/null
# OCI-to-VM conversion does not preserve default ACLs. Reapply the desktop
# image's shared-folder policy before launching apps or accepting uploads.
if [ -f /usr/local/share/openwork-desktop/configure-files.sh ]; then
  bash /usr/local/share/openwork-desktop/configure-files.sh
fi
mkdir -p "$state"
chmod 0700 "$state"
chown -R openwork-browser:openwork-browser "$state"
export DISPLAY="$display" XAUTHORITY="$state/.Xauthority"
as_browser() {
  # The desktop must not inherit the worker's host, model or activity tokens.
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/openwork-browser \
    USER=openwork-browser LOGNAME=openwork-browser LANG=C.UTF-8 \
    DISPLAY="$display" XAUTHORITY="$XAUTHORITY" LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe runuser -u openwork-browser -- "$@"
}
umask 077
if [ ! -s "$XAUTHORITY" ]; then
  touch "$XAUTHORITY"
  chmod 0600 "$XAUTHORITY"
  xauth -f "$XAUTHORITY" add "$display" . "$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  chown openwork-browser:openwork-browser "$XAUTHORITY"
fi
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  as_browser setsid -f Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" >"$state/display.log" 2>&1 < /dev/null
fi
attempt=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo "Cloud display did not start" >&2; exit 1; }
  sleep 0.1
done
if ! xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
  as_browser setsid -f openbox >"$state/window-manager.log" 2>&1 < /dev/null
fi
# A taskbar and Applications menu are installed by the Workbot desktop image.
# Older snapshots still open their browser without claiming extra apps exist.
if command -v tint2 >/dev/null && ! pgrep -u openwork-browser -x tint2 >/dev/null; then
  as_browser setsid -f tint2 >"$state/taskbar.log" 2>&1 < /dev/null
fi
if ! curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; then
  # The browser runs as an unprivileged user with Chromium's sandbox enabled.
  as_browser setsid -f chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --user-data-dir="$state/profile" --window-size=1280,800 --force-device-scale-factor=1 --no-first-run \
    --no-default-browser-check about:blank >"$state/browser.log" 2>&1 < /dev/null
fi
attempt=0
until curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo "Cloud browser did not start" >&2; exit 1; }
  sleep 0.2
done
if [ "${WORKBOT_DESKTOP_VNC:-0}" = 1 ]; then
  command -v x11vnc >/dev/null
  window=$(xdotool search --onlyvisible --class chromium | head -n 1)
  [ -n "$window" ] || { echo "The browser window is unavailable" >&2; exit 1; }
  for port in 5900 5901 5902 5903; do
    if ! python3 -c "import socket; socket.create_connection(('127.0.0.1', $port), 0.2).close()" >/dev/null 2>&1; then
      case "$port" in 5901|5903) set -- -id "$window" ;; *) set -- ;; esac
      case "$port" in 5902|5903) set -- "$@" -viewonly ;; esac
      as_browser setsid -f x11vnc -display "$display" -auth "$XAUTHORITY" -localhost -rfbport "$port" \
        -nopw -forever -shared -noxdamage -quiet "$@" >"$state/vnc-$port.log" 2>&1 < /dev/null
    fi
  done
fi

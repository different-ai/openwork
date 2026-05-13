#!/usr/bin/env bash
set -euo pipefail

# Start a virtual display + VNC + noVNC so Electron can render
# and you can see/steer it from a browser.
#
# Access: http://localhost:6080 (noVNC web client)

DISPLAY_NUM=99
RESOLUTION="${DISPLAY_RESOLUTION:-1920x1080x24}"

echo "==> Starting Xvfb on :${DISPLAY_NUM} (${RESOLUTION})..."
Xvfb ":${DISPLAY_NUM}" -screen 0 "${RESOLUTION}" -ac &
sleep 1

echo "==> Starting fluxbox window manager..."
DISPLAY=":${DISPLAY_NUM}" fluxbox &
sleep 1

echo "==> Starting x11vnc on port 5900..."
x11vnc -display ":${DISPLAY_NUM}" -forever -nopw -shared -rfbport 5900 &
sleep 1

echo "==> Starting noVNC on port 6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &

echo ""
echo "Virtual display ready."
echo "  noVNC: http://localhost:6080"
echo "  VNC:   localhost:5900"
echo ""

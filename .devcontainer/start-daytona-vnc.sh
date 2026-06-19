#!/usr/bin/env bash
set -euo pipefail

# Start Daytona-compatible desktop services for Electron tests.
# Assumes the daytonaio/sandbox base image packages are present.

DISPLAY_NUM="${DISPLAY_NUM:-99}"
DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${DISPLAY_RESOLUTION:-1920x1080x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"

export DISPLAY

mkdir -p /tmp/.X11-unix

if ! pgrep -f "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
  echo "==> Starting Xvfb on ${DISPLAY} (${RESOLUTION})..."
  Xvfb "${DISPLAY}" -screen 0 "${RESOLUTION}" -ac > /tmp/xvfb.log 2>&1 &
  sleep 1
fi

if ! pgrep -f "xfce4-session" >/dev/null 2>&1; then
  echo "==> Starting XFCE on ${DISPLAY}..."
  DISPLAY="${DISPLAY}" startxfce4 > /tmp/xfce.log 2>&1 &
  sleep 2
fi

if ! pgrep -f "x11vnc .*${VNC_PORT}" >/dev/null 2>&1; then
  echo "==> Starting x11vnc on :${VNC_PORT}..."
  x11vnc -display "${DISPLAY}" -forever -nopw -shared -rfbport "${VNC_PORT}" > /tmp/x11vnc.log 2>&1 &
  sleep 1
fi

if ! pgrep -f "websockify .*${NOVNC_PORT}" >/dev/null 2>&1; then
  echo "==> Starting noVNC on :${NOVNC_PORT}..."
  websockify --web /usr/share/novnc "${NOVNC_PORT}" "localhost:${VNC_PORT}" > /tmp/novnc.log 2>&1 &
fi

echo "Desktop ready. DISPLAY=${DISPLAY}, noVNC=http://localhost:${NOVNC_PORT}"

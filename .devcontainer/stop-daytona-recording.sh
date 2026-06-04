#!/usr/bin/env bash
set -euo pipefail

# Stop a running Daytona display recording. Sends SIGINT to ffmpeg so it
# finalizes the mp4 cleanly.
#
# Usage:
#   # Stop from inside the sandbox:
#   bash .devcontainer/stop-daytona-recording.sh
#
#   # Stop from the host:
#   daytona exec $SANDBOX -- 'bash .devcontainer/stop-daytona-recording.sh'

WAIT="${1:-5}"

mapfile -t pids < <(pgrep -f 'ffmpeg.*x11grab' 2>/dev/null || true)
if [ "${#pids[@]}" -eq 0 ]; then
  echo "No active recording found."
  exit 0
fi

for pid in "${pids[@]}"; do
  kill -INT "$pid" 2>/dev/null || true
done
echo "Sent SIGINT to ffmpeg (pids: ${pids[*]}). Waiting ${WAIT}s for finalization..."
sleep "$WAIT"

for pid in "${pids[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "WARNING: ffmpeg still running after ${WAIT}s; sending SIGTERM to $pid."
    kill "$pid" 2>/dev/null || true
  fi
done

echo "Recording stopped."

latest_recording=""
if [ -d /daytona-artifacts/recordings ]; then
  shopt -s nullglob
  for candidate in /daytona-artifacts/recordings/*.mp4; do
    if [ -z "$latest_recording" ] || [ "$candidate" -nt "$latest_recording" ]; then
      latest_recording="$candidate"
    fi
  done
  shopt -u nullglob
fi

if [ -n "$latest_recording" ]; then
  if [ ! -s "$latest_recording" ]; then
    echo "WARNING: latest recording is empty: $latest_recording" >&2
    exit 1
  fi

  echo "Latest recording: $latest_recording"
  ls -lh "$latest_recording"

  if command -v ffprobe >/dev/null 2>&1; then
    duration="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$latest_recording" 2>/dev/null || true)"
    if [ -n "$duration" ]; then
      echo "Duration seconds: $duration"
    else
      echo "WARNING: could not read recording duration with ffprobe" >&2
    fi
  fi
fi

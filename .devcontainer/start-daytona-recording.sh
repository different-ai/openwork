#!/usr/bin/env bash
set -euo pipefail

# Record the Daytona Electron display to an mp4 artifact. Stop with SIGINT so
# ffmpeg finalizes the file cleanly.

OUTPUT="/daytona-artifacts/recordings/daytona-recording.mp4"
SIZE="1920x1080"
FPS="15"
LOG_PATH="/tmp/daytona-recording.log"
DETACH=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --detach)
      DETACH=1
      ;;
    --output)
      shift
      OUTPUT="${1:?missing output path}"
      ;;
    --size)
      shift
      SIZE="${1:?missing recording size}"
      ;;
    --fps)
      shift
      FPS="${1:?missing recording fps}"
      ;;
    --log)
      shift
      LOG_PATH="${1:?missing log path}"
      ;;
    --help|-h)
      printf '%s\n' \
        "Usage: start-daytona-recording.sh [--detach] [--output PATH] [--size WxH] [--fps N]" \
        "" \
        "Records DISPLAY, defaulting to :99, and writes an mp4 file."
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      echo "Unexpected argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg is required for Daytona display recording." >&2
  exit 1
fi

if [ "$DETACH" -eq 1 ]; then
  SCRIPT_PATH="${BASH_SOURCE[0]}"
  nohup bash "$SCRIPT_PATH" --output "$OUTPUT" --size "$SIZE" --fps "$FPS" >"$LOG_PATH" 2>&1 &
  echo "Recording started: $OUTPUT"
  echo "Recording log: $LOG_PATH"
  exit 0
fi

FINAL_OUTPUT="$OUTPUT"
RECORD_OUTPUT="$OUTPUT"
if [[ "$OUTPUT" = /daytona-artifacts/* ]]; then
  RECORD_OUTPUT="/tmp/daytona-recording-$(basename "$OUTPUT")"
fi

mkdir -p "$(dirname "$RECORD_OUTPUT")"

FFMPEG_ARGS=(
  -y
  -f x11grab
  -video_size "$SIZE"
  -framerate "$FPS"
  -i "${DISPLAY:-:99}"
  -codec:v libx264
  -preset veryfast
  -pix_fmt yuv420p
  "$RECORD_OUTPUT"
)

set +e
ffmpeg "${FFMPEG_ARGS[@]}"
status="$?"
set -e

if [ "$RECORD_OUTPUT" != "$FINAL_OUTPUT" ]; then
  mkdir -p "$(dirname "$FINAL_OUTPUT")"
  cp "$RECORD_OUTPUT" "$FINAL_OUTPUT"
fi

exit "$status"

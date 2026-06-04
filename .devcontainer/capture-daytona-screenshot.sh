#!/usr/bin/env bash
set -euo pipefail

# Capture a single Daytona Electron display frame as a PNG artifact. Screenshots
# are for quick AI/human validation; videos are still the durable PR evidence.

OUTPUT="/daytona-artifacts/screenshots/daytona-screenshot-$(date +%Y%m%d-%H%M%S).png"
SIZE="1920x1080"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      shift
      OUTPUT="${1:?missing output path}"
      ;;
    --size)
      shift
      SIZE="${1:?missing screenshot size}"
      ;;
    --help|-h)
      printf '%s\n' \
        "Usage: capture-daytona-screenshot.sh [--output PATH] [--size WxH]" \
        "" \
        "Captures DISPLAY, defaulting to :99, and writes a PNG file."
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
  echo "ERROR: ffmpeg is required for Daytona screenshots." >&2
  exit 1
fi

if [[ ! "$SIZE" =~ ^[0-9]+x[0-9]+$ ]]; then
  echo "ERROR: screenshot size must use WxH format, for example 1920x1080" >&2
  exit 1
fi

FINAL_OUTPUT="$OUTPUT"
CAPTURE_OUTPUT="$OUTPUT"
if [[ "$OUTPUT" = /daytona-artifacts/* ]]; then
  CAPTURE_OUTPUT="/tmp/daytona-screenshot-$(basename "$OUTPUT")"
fi

mkdir -p "$(dirname "$CAPTURE_OUTPUT")"
ffmpeg -y -f x11grab -video_size "$SIZE" -i "${DISPLAY:-:99}" -frames:v 1 "$CAPTURE_OUTPUT" >/tmp/daytona-screenshot.log 2>&1

if [ "$CAPTURE_OUTPUT" != "$FINAL_OUTPUT" ]; then
  mkdir -p "$(dirname "$FINAL_OUTPUT")"
  cp "$CAPTURE_OUTPUT" "$FINAL_OUTPUT"
fi

echo "Screenshot saved: $FINAL_OUTPUT"

#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 ]] || { echo 'Usage: type-file.sh <file or ->' >&2; exit 2; }
export DISPLAY=${DISPLAY:-:99}
# Remove trailing CR/LF so the prompt is never submitted. Keep internal newlines.
input=$1
[[ $input != - ]] || input=/dev/stdin
python3 -c 'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read().rstrip(b"\r\n"))' < "$input" | xdotool type --clearmodifiers --file -

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Use an installed Chromium to avoid downloading a second browser.
# Linux/Windows users: set PUPPETEER_EXECUTABLE_PATH to their Chrome binary.
if [[ -z "${PUPPETEER_EXECUTABLE_PATH:-}" && -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
for name in architecture-data-flow architecture-detailed desktop-machine-access; do
  for format in svg png; do
    pnpm dlx @mermaid-js/mermaid-cli@11.12.0 \
      --input "$name.mmd" --output "$name.$format" \
      --configFile mermaid-config.json --backgroundColor white \
      --width 2200 --height 1800 --scale 1.5
  done
done

#!/usr/bin/env bash
set -euo pipefail
test "$(id -un)" = daytona && test "$HOME" = /home/daytona
test "$(uname -m)" = x86_64
packages=(libreoffice-impress libreoffice-calc fonts-liberation xdotool wmctrl jq)
command -v ffmpeg >/dev/null || packages+=(ffmpeg)
sudo apt-get update
if ! command -v chromium && ! command -v google-chrome && ! command -v google-chrome-stable; then
  packages+=(chromium)
fi
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*

#!/usr/bin/env bash
set -euo pipefail

case "$OAUTH_HANDOFF" in
  true|false) ;;
  *) printf '%s\n' '::error::oauth-handoff must be true or false.' >&2; exit 1 ;;
esac

sudo apt-get update -qq
sudo apt-get install -y xvfb x11-utils libgtk-3-0 libnss3 libasound2t64 libgbm1 ca-certificates curl gnupg
chrome="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$chrome" ]; then
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    https://dl.google.com/linux/linux_signing_key.pub -o "$RUNNER_TEMP/google-linux-signing-key.pub"
  gpg --batch --yes --dearmor --output "$RUNNER_TEMP/google-chrome.gpg" "$RUNNER_TEMP/google-linux-signing-key.pub"
  sudo install -m 0644 "$RUNNER_TEMP/google-chrome.gpg" /usr/share/keyrings/openwork-google-chrome.gpg
  printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/openwork-google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
    | sudo tee /etc/apt/sources.list.d/openwork-google-chrome.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y google-chrome-stable
fi
chrome="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
if [ -z "$chrome" ]; then
  printf '%s\n' '::error::Proof requires Google Chrome or Chromium on PATH. Repair the runner browser installation and rerun this job.' >&2
  exit 1
fi
"$chrome" --version
printf 'CHROME_BIN=%s\n' "$chrome" >> "$GITHUB_ENV"

if [ "$OAUTH_HANDOFF" = true ]; then
  sudo apt-get install -y xdg-utils
  browser=/usr/local/bin/openwork-proof-browser
  sudo install -m 0755 "$ACTION_PATH/browser.sh" "$browser"
  printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=OpenWork proof browser' \
    "Exec=$browser %U" 'Terminal=false' 'MimeType=x-scheme-handler/http;x-scheme-handler/https;' \
    | sudo tee /usr/share/applications/openwork-proof-browser.desktop >/dev/null
  sudo mkdir -p /etc/xdg
  printf '%s\n' '[Default Applications]' \
    'x-scheme-handler/http=openwork-proof-browser.desktop' \
    'x-scheme-handler/https=openwork-proof-browser.desktop' \
    | sudo tee /etc/xdg/mimeapps.list >/dev/null
  printf 'BROWSER=%s\n' "$browser" >> "$GITHUB_ENV"
fi

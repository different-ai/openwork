#!/bin/sh
# Adds the OpenWork integration to an installed, unbranded Collabora engine.
# Usage: install-openwork-theme.sh <branding.js> <branding.css>
# Preserves the engine's notices, About screen, and original branding source.
set -eu
command -v dpkg-query >/dev/null
for package in code-brand collabora-online-brand; do
  case "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null)" in
    installed) echo "Use an open-source, unbranded engine base; $package is proprietary." >&2; exit 1 ;;
  esac
done
# Content-address our assets: the engine otherwise caches branding under its own version.
theme_version="$(cat "$1" "$2" | sha256sum | cut -c1-12)"
mv "$1" "/usr/share/coolwsd/browser/dist/openwork-$theme_version.js"
mv "$2" "/usr/share/coolwsd/browser/dist/openwork-$theme_version.css"
sed -i -e "s|<!--%BRANDING_JS%-->|<!--%BRANDING_JS%--><script src=\"%SERVICE_ROOT%/browser/%VERSION%/openwork-$theme_version.js\"></script>|" \
    -e "s|<!--%BRANDING_CSS%-->|<!--%BRANDING_CSS%--><link rel=\"stylesheet\" href=\"%SERVICE_ROOT%/browser/%VERSION%/openwork-$theme_version.css\" />|" \
    /usr/share/coolwsd/browser/dist/cool.html
test -s "/usr/share/coolwsd/browser/dist/openwork-$theme_version.js"

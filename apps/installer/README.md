# OpenWork Installer

OpenWork desktop installer for custom deployments. Release builds are generic
signed files that do not embed organization config. Config is resolved only from
local development env overrides, per-client build constants, or an install link
the user pastes into the installer UI (also accepted via `--install-link`). When
an end user runs it, the installer:

1. Writes `desktop-bootstrap.json` to the OS-correct config location (the same path
   the desktop app and `openwork-bootstrap` CLI resolve), pointing the desktop app at
   the client's deployment. Existing extra fields (handoff, claim links) are preserved.
2. Asks the deployment's Den API (`GET /v1/app-version`) which desktop app version it
   supports (`latestAppVersion` — pinned per Den API build, see
   `ee/apps/den-api/src/generated/app-version.ts`).
3. Downloads that exact version from the public GitHub releases and installs it
   (macOS: mounts the dmg and copies the .app into `~/Applications`; Windows: runs the
   NSIS installer silently; Linux: installs the AppImage under `~/.local/share/openwork`
   with a desktop entry).

The UI is a small native webview window (webview-bun); if the platform webview library
is unavailable, the same UI opens in the default browser.

## Paste-gated generic artifacts

There is no artifact stamping, sidecar config, or filename tagging. macOS ships as
a DMG containing the generic `OpenWork Installer.app`; Windows ships as the bare
generic `OpenWork-Installer-win-x64.exe`. A generic UI build gates on the paste
screen until the user provides their OpenWork install link.

## Local development

```bash
pnpm --dir apps/installer test

# Headless dry run (no download/install; verifies config write + version + asset):
OPENWORK_INSTALLER_CLIENT_NAME="Acme" \
OPENWORK_INSTALLER_WEB_URL="https://openwork.acme.com" \
OPENWORK_INSTALLER_API_URL="https://openwork-api.acme.com" \
pnpm --dir apps/installer exec bun run src/index.ts --headless --dry-run

# UI mode (uses env overrides, build config, or pasted install link):
pnpm --dir apps/installer dev

# Single binary, then macOS DMG packaging:
pnpm --dir apps/installer compile
pnpm --dir apps/installer package:mac-dmg
```

`src/generated/build-config.ts` is a committed placeholder for legacy/dev builds.
Empty placeholder values make headless mode require `--install-link`; UI mode prompts
for the install link instead of pointing users at the wrong deployment.

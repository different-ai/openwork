# OpenWork Installer

OpenWork desktop installer for custom deployments. Release builds are generic;
deployment config is resolved from an install link stamp, sidecar file, filename tag,
or local development env overrides. When an end user runs it, the installer:

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

## Install-link stamping

The Den API serves one generic installer artifact and stamps it at download time:
macOS zips receive `openwork-installer.json`, Windows installers receive a filename
tag, and Linux receives a small shell setup script. An unstamped UI build asks the
user to paste their OpenWork install link.

## Local development

```bash
cd apps/installer
bun install
bun test

# Headless dry run (no download/install; verifies config write + version + asset):
OPENWORK_INSTALLER_CLIENT_NAME="Acme" \
OPENWORK_INSTALLER_WEB_URL="https://openwork.acme.com" \
OPENWORK_INSTALLER_API_URL="https://openwork-api.acme.com" \
bun run src/index.ts --headless --dry-run

# UI mode (uses install-link stamp, sidecar, filename tag, build config, or env overrides):
bun run dev

# Single binary:
bun run compile
```

`src/generated/build-config.ts` is a committed placeholder for legacy/dev builds.
Empty placeholder values make headless mode require `--install-link`; UI mode prompts
for the install link instead of pointing users at the wrong deployment.

# OpenWork Installer

Per-client desktop installer for custom OpenWork deployments. Each build embeds one
client's deployment config (client name, web URL, API URL). When an end user runs it,
the installer:

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

## Building per client

Run the **Build Client Installer** workflow (`.github/workflows/build-client-installer.yml`)
with the client's name, web URL, and API URL. It compiles single-file binaries for
macOS (arm64/x64, signed + notarized `.app` in a zip), Windows (x64, SignPath-signed
when enabled), and Linux (x64/arm64 tarballs), and uploads them as **workflow
artifacts** — deliberately not public release assets, so client names and deployment
URLs stay private.

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

# UI mode (uses build config from src/generated/build-config.ts or the env overrides):
bun run dev

# Single binary:
bun run compile
```

`src/generated/build-config.ts` is a committed placeholder; the workflow overwrites it
before compiling. Empty placeholder values make the binary refuse to run, so an
unconfigured build can never point users at the wrong deployment.

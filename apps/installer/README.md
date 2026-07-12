# OpenWork Installer

OpenWork desktop installer for custom deployments. Release builds are generic;
deployment config is resolved from an install link stamp, sidecar file, filename tag,
or local development env overrides. When an end user runs it, the installer:

1. Uses the exact standard app version declared by the organization JSON. If a
   matching DMG/EXE/AppImage is beside this installer, it uses those local bytes
   without network access. Standalone/pasted-link installs fall back to the Den
   version endpoint and public release hosting.
2. Installs the standard app (macOS: mounts the DMG and copies the `.app` into
   `~/Applications`; Windows: runs the NSIS installer silently; Linux: installs
   the AppImage under `~/.local/share/openwork` with a desktop entry).
3. After installation succeeds, atomically writes `desktop-bootstrap.json` to
   the OS-correct config location, pointing the desktop app at the client's
   deployment. Existing prepared/claim-link fields are preserved. Failed
   installs and dry runs leave the previous configuration unchanged.

The UI is a small native webview window (webview-bun); if the platform webview library
is unavailable, the same UI opens in the default browser.

## Install-link stamping

The Den API combines the unchanged generic installer artifact, unchanged
standard app artifact, and `openwork-installer.json` into one organization ZIP.
Both macOS and Windows read the JSON beside the exact installer the user
launches. The macOS resolver follows App Translocation back to that extracted
bundle. An unstamped UI build asks the user to paste their OpenWork install
link.

The sidecar includes the Den web/API origins, exact app version, managed app
name, wordmark URL, and square icon URL. The installer writes these to the
canonical `desktop-bootstrap.json`; it never searches Downloads or Desktop.

## Local development

```bash
cd apps/installer
bun install
bun test

# Headless dry run (no install or config change; verifies version + asset):
OPENWORK_INSTALLER_CLIENT_NAME="Acme" \
OPENWORK_INSTALLER_WEB_URL="https://openwork.acme.com" \
OPENWORK_INSTALLER_API_URL="https://openwork-api.acme.com" \
bun run src/index.ts --headless --dry-run

# UI mode (uses install-link stamp, sidecar, filename tag, build config, or env overrides):
bun run dev

# Single binary:
bun run compile

# Build a distributable organization ZIP from exact signed release artifacts:
pnpm enterprise-installer:build -- \
  --config ./openwork-installer.json \
  --platform mac-arm64 \
  --output ./dist
```

The root `enterprise-installer:build` command also supports
`--artifacts-dir <path>` for zero-egress packaging and `--dry-run` for
non-mutating validation. See `docs/org-install-links.md` for the enterprise and
MDM deployment patterns.

`src/generated/build-config.ts` is a committed placeholder for legacy/dev builds.
Empty placeholder values make headless mode require `--install-link`; UI mode prompts
for the install link instead of pointing users at the wrong deployment.

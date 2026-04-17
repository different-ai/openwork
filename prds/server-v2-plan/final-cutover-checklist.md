# Server V2 Final Cutover Checklist

## Status

In progress. This checklist is the honest Phase 10 cutover and release ledger for the current worktree state.

## Default Path Checks

- Desktop startup default: `Legacy`
- App rollout default: legacy path unless `OPENWORK_UI_USE_SERVER_V2=1`
- Runtime ownership default: Server V2 supervises OpenCode and router
- Route mount: root-mounted (`/system/*`, `/workspaces/*`), no legacy `/v2`

## Completed In Current Worktree

- Composite local dev graph exists and is documented:
  - `pnpm dev:server-v2`
  - `pnpm dev:server-v2:server`
- OpenAPI and SDK watch loops are hardened against replace-style writes and generator side effects.
- Server V2 resolves a real package version instead of reporting `0.0.0`.
- Bun compile build exists for Server V2.
- Embedded runtime packaging exists via `apps/server-v2/script/build.ts --embed-runtime`.
- Release runtime extraction uses a persistent versioned runtime directory with lock, atomic replace, lease tracking, and cleanup.
- Desktop can bundle and start Server V2 when `OPENWORK_UI_USE_SERVER_V2=1` is enabled.
- App can route through Server V2 when `OPENWORK_UI_USE_SERVER_V2=1` is enabled.
- Windows signing workflow exists at `.github/workflows/windows-signed-artifacts.yml` for the standalone Server V2 binary, signed sidecars, and desktop Windows artifacts.

## Remaining Release Gates

- Delete legacy `apps/server` codepaths once no active caller needs them.
- Delete or archive obsolete orchestrator control-plane code once no active caller needs it.
- Commit or otherwise land the regenerated Server V2 contract so `pnpm contract:check` passes on a clean tree.
- Validate macOS signing + notarization with real signed artifacts.
- Validate Windows SmartScreen / Defender / AV behavior with real Windows artifacts.
- Capture Chrome MCP success evidence once the Docker stack session flow is fixed.

## Current Validation Status In This Environment

- `pnpm sdk:generate` runs successfully.
- `pnpm contract:check` still fails in this in-progress worktree because generated Phase 10 contract changes are not committed yet; it is acting as a drift detector against `HEAD`, not as a no-op generator check.
- Server V2 package tests and typecheck pass.
- App Server V2 boundary tests and app typecheck pass.
- Desktop Rust tests pass.
- Plain and embedded Server V2 Bun builds both pass.
- Embedded standalone runtime smoke passed: the compiled Server V2 binary launched from outside the bundle directory extracted and started OpenCode from the managed runtime directory using `source: release`.
- Docker dev stack now starts on the Server V2 path after moving the stack off orchestrator startup and serializing shared `pnpm install` work across containers.
- Docker API-level smoke succeeded for `GET /system/health`, `GET /system/opencode/health`, and `GET /workspaces` against the running dev stack.
- Docker product-flow API smoke now succeeds for `POST /workspaces/:id/sessions` after fixing Server V2 compatibility config materialization to emit the OpenCode-compatible `permission.external_directory` object-map format.
- Chrome MCP validation is not runnable from this environment because the current tool session does not expose Chrome DevTools MCP actions.
- macOS signing/notarization was not completed here because no signing identity or notary credentials are available in this session.
- Windows signing workflow was implemented, but end-to-end signing and SmartScreen / AV validation were not completed here because no Windows runner or Windows signing certificate is available in this session.

## Automated Validation Commands

Run from repo root unless noted.

```bash
pnpm sdk:generate
pnpm contract:check
pnpm --filter openwork-server-v2 test
pnpm --filter openwork-server-v2 typecheck
pnpm --filter @openwork/app test:server-v2-boundary
pnpm --filter @openwork/app typecheck
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
pnpm --filter openwork-server-v2 build:bin
pnpm --filter openwork-server-v2 build:bin:embedded --bundle-dir ../desktop/src-tauri/sidecars
```

## macOS Manual Validation

Prerequisites:

- Apple signing identity available in keychain
- Notary API key and issuer configured
- Real release-style sidecar bundle prepared

Suggested validation flow:

```bash
pnpm -C apps/desktop prepare:sidecar
pnpm --filter openwork-server-v2 build:bin:embedded --bundle-dir ../desktop/src-tauri/sidecars
codesign --deep --force -vvvv --sign "<APPLE_IDENTITY>" --entitlements apps/desktop/src-tauri/entitlements.plist apps/server-v2/dist/bin/openwork-server-v2
codesign -vvv --verify apps/server-v2/dist/bin/openwork-server-v2
xcrun notarytool submit apps/server-v2/dist/bin/openwork-server-v2 --key <KEY_ID> --key-id <KEY_ID> --issuer <ISSUER_ID> --wait
spctl --assess --type execute --verbose apps/server-v2/dist/bin/openwork-server-v2
OPENWORK_SERVER_V2_WORKDIR="$(mktemp -d)" apps/server-v2/dist/bin/openwork-server-v2 --port 32123
```

Confirm:

- the binary verifies after signing
- notarization succeeds
- first-run extraction succeeds from the embedded payload
- extracted sidecars launch without trust prompts

## Windows Manual Validation

Prerequisites:

- Windows runner or workstation
- Authenticode certificate in PFX form
- `signtool.exe`

Suggested validation flow:

```powershell
pnpm install --frozen-lockfile
pnpm -C apps/desktop prepare:sidecar
pnpm --filter openwork-server-v2 build:bin:embedded --bundle-dir ../desktop/src-tauri/sidecars --target bun-windows-x64
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /f codesign.pfx /p <PASSWORD> apps\server-v2\dist\bin\openwork-server-v2-bun-windows-x64.exe
signtool verify /pa /v apps\server-v2\dist\bin\openwork-server-v2-bun-windows-x64.exe
```

SmartScreen / AV validation:

```powershell
$env:OPENWORK_SERVER_V2_WORKDIR = Join-Path $env:TEMP "openwork-server-v2-smoke"
New-Item -ItemType Directory -Force -Path $env:OPENWORK_SERVER_V2_WORKDIR | Out-Null
apps\server-v2\dist\bin\openwork-server-v2-bun-windows-x64.exe --port 32123
Invoke-WebRequest http://127.0.0.1:32123/system/opencode/health
Invoke-WebRequest http://127.0.0.1:32123/system/runtime/summary
```

Record:

- whether SmartScreen warns on first launch
- whether Defender delays or quarantines extracted sidecars
- first-run vs second-run startup latency
- whether signed extracted sidecars materially reduce warnings

## End-to-End Product Validation

Preferred flow:

```bash
packaging/docker/dev-up.sh
```

Then validate a real UI flow with Chrome MCP:

- open the printed web URL
- navigate to the session surface
- send a message
- confirm the response renders
- save screenshot evidence

If Chrome MCP is unavailable in the current environment, record that explicitly and include the exact command above plus the expected manual reviewer steps.

Current state from this worktree:

- `packaging/docker/dev-up.sh` now reaches healthy `server`, `web`, and `share` containers on the Server V2 path.
- Docker API smoke including session creation now succeeds:

```bash
source tmp/.dev-env-<id>
curl -H "Authorization: Bearer $OPENWORK_TOKEN" http://127.0.0.1:<OPENWORK_PORT>/workspaces
curl -X POST -H "Authorization: Bearer $OPENWORK_TOKEN" -H "Content-Type: application/json" --data '{"title":"Docker E2E"}' http://127.0.0.1:<OPENWORK_PORT>/workspaces/<WORKSPACE_ID>/sessions
```

- Remaining manual reviewer work:

```bash
packaging/docker/dev-up.sh
source tmp/.dev-env-<id>
curl -H "Authorization: Bearer $OPENWORK_TOKEN" http://127.0.0.1:<OPENWORK_PORT>/workspaces
curl -X POST -H "Authorization: Bearer $OPENWORK_TOKEN" -H "Content-Type: application/json" --data '{"title":"Docker E2E"}' http://127.0.0.1:<OPENWORK_PORT>/workspaces/<WORKSPACE_ID>/sessions
```

and then complete the Chrome MCP UI flow in the running stack.

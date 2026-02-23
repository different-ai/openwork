# OpenWork Orchestrator

Host orchestrator for opencode + OpenWork server + opencode-router. This is a CLI-first way to run host mode without the desktop UI.

Published on npm as `openwork-orchestrator` and installs the `openwork` command.

## Quick start

```bash
npm install -g openwork-orchestrator
openwork start --workspace /path/to/workspace --approval auto
```

When run in a TTY, `openwork` shows an interactive status dashboard with service health, ports, and
connection details. Use `openwork serve` or `--no-tui` for log-only mode.

```bash
openwork serve --workspace /path/to/workspace
```

`openwork` ships as a compiled binary, so Bun is not required at runtime.

`openwork` downloads and caches the `openwork-server`, `opencode-router`, and `opencode` sidecars on
first run using a SHA-256 manifest. Use `--sidecar-dir` or `OPENWORK_SIDECAR_DIR` to control the
cache location, and `--sidecar-base-url` / `--sidecar-manifest` to point at a custom host.

Use `--sidecar-source` to control where `openwork-server` and `opencode-router` are resolved
(`auto` | `bundled` | `downloaded` | `external`), and `--opencode-source` to control
`opencode` resolution. Set `OPENWORK_SIDECAR_SOURCE` / `OPENWORK_OPENCODE_SOURCE` to
apply the same policies via env vars.

By default the manifest is fetched from
`https://github.com/different-ai/openwork/releases/download/openwork-orchestrator-v<version>/openwork-orchestrator-sidecars.json`.

OpenCode Router is optional. If it exits, `openwork` continues running unless you pass
`--opencode-router-required` or set `OPENWORK_OPENCODE_ROUTER_REQUIRED=1`.

For development overrides only, set `OPENWORK_ALLOW_EXTERNAL=1` or pass `--allow-external` to use
locally installed `openwork-server` or `opencode-router` binaries.

Add `--verbose` (or `OPENWORK_VERBOSE=1`) to print extra diagnostics about resolved binaries.

OpenCode hot reload is enabled by default when launched via `openwork`.
Tune it with:

- `--opencode-hot-reload` / `--no-opencode-hot-reload`
- `--opencode-hot-reload-debounce-ms <ms>`
- `--opencode-hot-reload-cooldown-ms <ms>`

Equivalent env vars:

- `OPENWORK_OPENCODE_HOT_RELOAD` (router mode)
- `OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS`
- `OPENWORK_OPENCODE_HOT_RELOAD` (start/serve mode)
- `OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS`
- `OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS`

Or from source:

```bash
pnpm --filter openwork-orchestrator dev -- \
  start --workspace /path/to/workspace --approval auto --allow-external
```

The command prints pairing details (OpenWork server URL + token, OpenCode URL + auth) so remote OpenWork clients can connect.

Use `--detach` to keep services running and exit the dashboard. The detach summary includes the
OpenWork URL, tokens, and the `opencode attach` command.

## Sandbox mode (Docker / Apple container)

`openwork` can run the sidecars inside a Linux container boundary while still mounting your workspace
from the host.

```bash
# Auto-pick sandbox backend (prefers Apple container on supported Macs)
openwork start --sandbox auto --workspace /path/to/workspace --approval auto

# Explicit backends
openwork start --sandbox docker --workspace /path/to/workspace --approval auto
openwork start --sandbox container --workspace /path/to/workspace --approval auto
```

Notes:

- `--sandbox auto` prefers Apple `container` on supported Macs (arm64), otherwise Docker.
- Docker backend requires `docker` on your PATH.
- Apple container backend requires the `container` CLI (https://github.com/apple/container).
- In sandbox mode, sidecars are resolved for a Linux target (and `--sidecar-source` / `--opencode-source`
  are effectively `downloaded`).
- Custom `--*-bin` overrides are not supported in sandbox mode yet.
- Use `--sandbox-image` to pick an image with the toolchain you want available to OpenCode.
- Use `--sandbox-persist-dir` to control the host directory mounted at `/persist` inside the container.

### Extra mounts (allowlisted)

You can add explicit, validated mounts into `/workspace/extra/*`:

```bash
openwork start --sandbox auto --sandbox-mount "/path/on/host:datasets:ro" --workspace /path/to/workspace
```

Additional mounts are blocked unless you create an allowlist at:

- `~/.config/openwork/sandbox-mount-allowlist.json`

Override with `OPENWORK_SANDBOX_MOUNT_ALLOWLIST`.

## Logging

`openwork` emits a unified log stream from OpenCode, OpenWork server, and opencode-router. Use JSON format for
structured, OpenTelemetry-friendly logs and a stable run id for correlation.

```bash
OPENWORK_LOG_FORMAT=json openwork start --workspace /path/to/workspace
```

Use `--run-id` or `OPENWORK_RUN_ID` to supply your own correlation id.

OpenWork server logs every request with method, path, status, and duration. Disable this when running
`openwork-server` directly by setting `OPENWORK_LOG_REQUESTS=0` or passing `--no-log-requests`.

## Router daemon (multi-workspace)

The router keeps a single OpenCode process alive and switches workspaces JIT using the `directory` parameter.

```bash
openwork daemon start
openwork workspace add /path/to/workspace-a
openwork workspace add /path/to/workspace-b
openwork workspace list --json
openwork workspace path <id>
openwork instance dispose <id>
```

Use `OPENWORK_DATA_DIR` or `--data-dir` to isolate router state in tests.

## Pairing notes

- Use the **OpenWork connect URL** and **client token** to connect a remote OpenWork client.
- The OpenWork server advertises the **OpenCode connect URL** plus optional basic auth credentials to the client.

## Approvals (manual mode)

```bash
openwork approvals list \
  --openwork-url http://<host>:8787 \
  --host-token <token>

openwork approvals reply <id> --allow \
  --openwork-url http://<host>:8787 \
  --host-token <token>
```

## Health checks

```bash
openwork status \
  --openwork-url http://<host>:8787 \
  --opencode-url http://<host>:4096
```

## Smoke checks

```bash
openwork start --workspace /path/to/workspace --check --check-events
```

This starts the services, verifies health + SSE events, then exits cleanly.

## Local development

Point to source CLIs for fast iteration:

```bash
openwork start \
  --workspace /path/to/workspace \
  --allow-external \
  --openwork-server-bin packages/server/src/cli.ts \
  --opencode-router-bin ../opencode-router/dist/cli.js
```

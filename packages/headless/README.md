# Openwrk

Headless host orchestrator for OpenCode + OpenWork server + Owpenbot. This is a CLI-first way to run host mode without the desktop UI.

## Quick start

```bash
npm install -g openwrk
openwrk start --workspace /path/to/workspace --approval auto
```

`openwrk` ships as a compiled binary, so Bun is not required at runtime.

`openwrk` bundles and validates exact versions of `openwork-server` + `owpenbot` using a
SHA-256 manifest. It will refuse to start if the bundled binaries are missing or tampered with.

Owpenbot is optional. If it exits, `openwrk` continues running unless you pass
`--owpenbot-required` or set `OPENWRK_OWPENBOT_REQUIRED=1`.

For development overrides only, set `OPENWRK_ALLOW_EXTERNAL=1` or pass `--allow-external` to use
locally installed `openwork-server` or `owpenbot` binaries.

Or from source:

```bash
pnpm --filter openwrk dev -- \
  start --workspace /path/to/workspace --approval auto --allow-external
```

The command prints pairing details (OpenWork server URL + token, OpenCode URL + auth) so remote OpenWork clients can connect.

## Router daemon (multi-workspace)

The router keeps a single OpenCode process alive and switches workspaces JIT using the `directory` parameter.

```bash
openwrk daemon start
openwrk workspace add /path/to/workspace-a
openwrk workspace add /path/to/workspace-b
openwrk workspace list --json
openwrk workspace path <id>
openwrk instance dispose <id>
```

Use `OPENWRK_DATA_DIR` or `--data-dir` to isolate router state in tests.

## Pairing notes

- Use the **OpenWork connect URL** and **client token** to connect a remote OpenWork client.
- The OpenWork server advertises the **OpenCode connect URL** plus optional basic auth credentials to the client.

## Approvals (manual mode)

```bash
openwrk approvals list \
  --openwork-url http://<host>:8787 \
  --host-token <token>

openwrk approvals reply <id> --allow \
  --openwork-url http://<host>:8787 \
  --host-token <token>
```

## Health checks

```bash
openwrk status \
  --openwork-url http://<host>:8787 \
  --opencode-url http://<host>:4096
```

## Smoke checks

```bash
openwrk start --workspace /path/to/workspace --check --check-events
```

This starts the services, verifies health + SSE events, then exits cleanly.

## Local development

Point to source CLIs for fast iteration:

```bash
openwrk start \
  --workspace /path/to/workspace \
  --allow-external \
  --openwork-server-bin packages/server/src/cli.ts \
  --owpenbot-bin ../owpenbot/dist/cli.js
```

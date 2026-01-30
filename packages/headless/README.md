# Openwrk

Headless host orchestrator for OpenCode + OpenWork server + Owpenbot. This is a CLI-first way to run host mode without the desktop UI.

## Quick start

```bash
npm install -g openwrk
openwrk start --workspace /path/to/workspace --approval auto
```

`openwrk` ships as a compiled binary, so Bun is not required at runtime.

`openwrk` installs the OpenWork server dependency automatically. No extra install needed.

Or from source:

```bash
pnpm --filter openwrk dev -- \
  start --workspace /path/to/workspace --approval auto
```

The command prints pairing details (OpenWork server URL + token, OpenCode URL + auth) so remote OpenWork clients can connect.

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
  --openwork-server-bin packages/server/src/cli.ts \
  --owpenbot-bin packages/owpenbot/src/cli.ts
```

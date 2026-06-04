---
name: daytona-electron-den
description: Validate Electron against a Daytona Den server. Use for two-sandbox cloud auth, marketplace, org policy, worker proxy, provider sync, or desktop handoff flows.
---

# Daytona Electron Against Den

Use this skill for full-stack cloud behavior: one Daytona sandbox runs Den, and a
separate Daytona sandbox runs the real Electron app pointed at that Den server.

## Start The Server Sandbox

Use the server skill first:

```bash
bash .devcontainer/test-server-on-daytona.sh <branch-or-commit>
```

Record the printed values:

- `SERVER_SANDBOX`
- `DEN_WEB_URL`
- `DEN_API_URL`
- `DEN_WORKER_PROXY_URL`

Validate server health:

```bash
curl -sf "$DEN_WEB_URL/api/den/health"
curl -sf "$DEN_API_URL/health"
```

## Start Electron Against Den

```bash
bash .devcontainer/test-on-daytona.sh <branch-or-commit> \
  --den-base-url "$DEN_WEB_URL" \
  --den-api-base-url "$DEN_API_URL" \
  --artifacts-volume
```

Add `--require-signin` when the expected behavior must be signed-out until cloud
auth completes. Add `--record-video --recording-name <name>` when PR evidence is
needed.

## Validate Bootstrap

Before testing cloud behavior, prove Electron is using the Daytona Den server:

```js
JSON.stringify({ hash: location.hash, text: document.body.innerText.slice(0, 1000) })
```

Then inspect the desktop bootstrap file:

```bash
daytona exec "$SANDBOX" -- 'cat /workspace/.openwork-daytona/desktop-bootstrap.json'
```

Expected: `baseUrl` is `DEN_WEB_URL` and `apiBaseUrl` is `DEN_API_URL`, not
production.

## Desktop Handoff Pattern

For seeded/demo auth, create the handoff URL from the Den API, then paste it into
Electron's Cloud Account sign-in code field. Do not rely on browser navigation
alone as proof that desktop auth completed.

Validate all of these:

- Electron Cloud Account shows signed-in user/org state.
- Den API logs show handoff exchange or `/v1/me/orgs`.
- Electron UI can refresh cloud providers/workers/marketplace without production URLs.

## Marketplace, Policy, Provider Sync

For each cloud feature, use the `daytona-flow-validator` loop:

1. Assert server seed or API state.
2. Act in Electron UI.
3. Assert Electron visible state.
4. Assert Den logs/API state if relevant.
5. Capture screenshot or recording evidence.

Minimum assertions:

- Marketplace: package appears, install/remove changes local extension state.
- Org policy: restriction appears in Electron and persists after reload.
- Provider sync: Den-managed provider appears as imported/credential-ready, model can be selected, and task metadata uses the Den provider id.
- Worker proxy: worker/proxy failures affect only worker UI and recover after proxy restart.

## Evidence

Report both server and Electron proof:

- Den Web/API health checks.
- Relevant `/tmp/den-*.log` snippets.
- Electron CDP assertions and screenshots.
- Recording URL if requested.

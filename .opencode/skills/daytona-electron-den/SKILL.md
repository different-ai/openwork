---
name: daytona-electron-den
description: Electron and Den, desktop plus cloud, two-sandbox e2e, cloud auth, marketplace, org policy, worker proxy, provider sync, desktop handoff. Validate Electron against a Daytona Den server with unified proof.
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

Fully automated variant (no paste UI): as a signed-in web user call
`POST /api/den/v1/auth/desktop-handoff` (body `{}`) to get a `grant`
(single-use, 5-minute TTL), then dispatch the deep link directly in the
Electron renderer via CDP — the auth provider consumes it:

```js
window.dispatchEvent(new CustomEvent("openwork:deep-link", {
  detail: { urls: ["openwork://den-auth?grant=" + grant +
    "&denBaseUrl=" + encodeURIComponent(DEN_WEB_URL)] },
}));
```

Build `denBaseUrl` yourself from the public Den Web URL — the server-resolved
one in the handoff response can be an internal host. Afterwards the app shows
"Choose your organization" → "Continue with organization".

Validate all of these:

- Electron Cloud Account shows signed-in user/org state.
- Den API logs show handoff exchange or `/v1/me/orgs`.
- Electron UI can refresh cloud providers/workers/marketplace without production URLs.

Renderer navigation cheat-sheet (hash routes work when buttons are flaky):

- Org marketplace extensions live at
  `#/workspace/<ws>/settings/cloud-marketplaces` (the standalone view; the
  "Marketplace" tab inside Extensions (Legacy) renders the embedded variant
  which HIDES cloud org plugin rows by design). Expect org plugins as
  "Active · runs in cloud".
- Insert composer prompts with `editor.focus()` +
  `document.execCommand("insertText", false, text)` on
  `[contenteditable="true"][data-lexical-editor="true"]`. Do not dispatch
  synthetic paste events — Lexical converts them into a "Pasted · N lines"
  attachment chip. Then click **Run task** (exact text match) and wait for the
  "Ready for new tasks" status before capturing results.

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

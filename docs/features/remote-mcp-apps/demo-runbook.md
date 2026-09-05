# Native MCP Apps local demo

This runbook proves the native MCP Apps path with a deterministic local fixture.
It does not depend on a hosted gallery, production rollout flags, customer
connectors, or personal credentials.

The required fixture is Project Atlas from
`evals/specs/remote-mcp-apps.e2e.test.ts`. It runs as a local Streamable HTTP MCP
server, exposes `ui://project-atlas/view.html`, and has a same-server
`search_projects` operation. The tape starts real local Den API and Web
processes, a real Electron Desktop/local-server process, MySQL, Redis, and a
synthetic model server.

## Prerequisites

- Node.js 24 and pnpm 11.4.0 (the versions declared by the repository)
- Bun, Docker, and an available local MySQL port (`3306`)
- no real model/provider credentials in the shell

From a clean checkout of the exact branch under test:

```bash
pnpm install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm dev:den:mysql
```

## Run the exact-head demo tape

```bash
OPENWORK_EVAL_E2E_TESTS=1 pnpm evals:e2e remote-mcp-apps
```

A valid required proof ends with one passing test, zero failed tests, zero
skips, and `"verdict":"passed"`. Keep the JSON report path printed by the
runner with the local verification record.

The tape performs this demo sequence:

1. Starts an isolated Den organization, synthetic member, local Project Atlas
   MCP server, and Desktop profile.
2. Adds Project Atlas as an organization Connect MCP server and waits for it to
   become ready.
3. Confirms the model-visible surface contains only the central
   `search_capabilities` and `execute_capability` tools.
4. Confirms stale per-connection compatibility exposes only that same bounded
   pair, no resources/templates/App metadata, and no direct provider tools.
5. Confirms the private App host receives only the originating server's
   app-visible tools and exact `ui://project-atlas/view.html` resource.
6. Searches and executes `search_projects` through the originating server's
   App-host capability pair and observes the synthetic Atlas migration result.
7. Prompts the synthetic model to return the bound tool result, renders the App
   in Desktop, reloads it, and confirms it renders again.
8. Restarts Desktop with the same isolated profile, revisits the session, and
   confirms the App recovers.

Native MCP Apps are enabled for every deployment and organization; no
deployment or organization gate needs to be flipped for this demo.

## Focused security and compatibility checks

```bash
cd apps/server
bun --conditions=development test \
  src/connect-mcp-server-catalog.test.ts \
  src/mcp-app-host.test.ts \
  src/mcp-app-sandbox.test.ts \
  src/cloud-mcp-reconcile.e2e.test.ts

cd ../app
bun test \
  tests/den-mcp-url.test.ts \
  tests/mcp-app-frame.test.ts \
  tests/session-mcp-maintenance.test.ts \
  tests/cloud-mcp-maintenance-gate.test.ts

cd ../../ee/apps/den-api
bun test \
  test/remote-mcp-app-rollout.test.ts \
  test/external-connection-proxy.test.ts \
  test/admin-organization-capabilities.test.ts \
  test/organization-capabilities.test.ts
```

These checks cover exact trusted-origin matching, cross-origin rejection,
origin-bound App-host credentials, App-host credential privacy, sandbox/CSP
enforcement, same-server binding, rollout defaults, older responses without an
App-host credential, bounded stale-client compatibility, and preservation of
ordinary Connect when Apps are disabled.

## Expected failure categories

- A skipped tape is incomplete proof. Check the consent environment variable,
  local placement, and MySQL availability.
- `missing local server credentials` is a Desktop startup/readiness problem.
- A resource error names the exact URI, MIME, size, or CSP validation failure.
- An origin error indicates that the Den/App-host endpoint pair is not an exact
  trusted-origin match.
- A tool denial indicates wrong-server routing, app visibility, workspace
  policy, provider authorization, or required mutation confirmation.
- A client that does not advertise the private App-host capability keeps the
  bounded search/execute surface; that is expected, not a resource-loading
  failure.

The hosted SOL gallery may be checked separately as an external observation,
but its reachability is not OpenWork compatibility proof and it is not part of
this required demo.

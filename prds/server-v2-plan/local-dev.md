# Server V2 Local Dev Workflow

## Status: Draft
## Date: 2026-04-09

## Purpose

This document defines how Server V2, the generated SDK, and the app should stay in sync during local development without manual rebuilds or process restarts after every change.

This doc assumes Server V2 is a separate new server package, not a mounted sub-application inside the old server.

While Server V2 is still under validation, the current product should continue to work by default on the legacy path. For local testing of the new path, opt in explicitly with:

```bash
OPENWORK_UI_USE_SERVER_V2=1 pnpm dev:server-v2
```

That same logical flag should control both app routing and desktop startup behavior.

Detailed generator selection and script shape live in `prds/server-v2-plan/sdk-generation.md`.

## Goal

The ideal local loop is:

```text
edit a new-server route or schema
-> server reloads
-> OpenAPI spec regenerates
-> SDK regenerates
-> app sees the updated types and client methods
-> continue coding without restarting everything
```

## Principle

We should treat local development as three separate but connected loops:

- server runtime loop
- contract generation loop
- app dev loop

There is also one runtime-asset loop that matters specifically for Server V2:

- local sidecar acquisition loop

Each loop watches its own inputs and reacts only to the changes it actually cares about.

## Runtime Asset Loop

For Server V2 local development, runtime ownership should match production, but asset sourcing can be lighter-weight.

Recommended model:

- `apps/server-v2` runs directly with Bun in dev/watch mode
- `opencode-router` is built from the local workspace source in `apps/opencode-router`
- `opencode` is downloaded from a pinned release artifact, not committed into the repo and not resolved from `PATH`
- both binaries are staged into a gitignored local runtime-assets directory
- Server V2 launches those staged binaries by absolute path

### Pinned version source

The pinned OpenCode version for local dev should come from the root `constants.json` file.

That means the local-dev flow should:

- read `opencodeVersion` from `constants.json`
- normalize the version for the upstream release download if needed
- fetch exactly that version when the local cache is missing

### Recommended local-dev behavior

1. On first local Server V2 run, check the local runtime-assets cache for the pinned `opencode` binary.
2. If the pinned binary is missing, download the matching release artifact for the current platform.
3. Build `apps/opencode-router` locally and stage the resulting binary in the same gitignored runtime-assets area.
4. Start Server V2 in Bun watch mode.
5. Have Server V2 spawn the staged binaries by absolute path.

### Important rules

- do not require developers to install `opencode` globally for Server V2 dev
- do not use `PATH` lookup as the default dev mechanism
- do not check the `opencode` binary into git
- prefer caching the downloaded pinned artifact locally so repeated dev restarts are fast

## Watch Graph

```text
apps/server-v2/src/**
-> server watch reloads server runtime
-> OpenAPI watch regenerates apps/server-v2/openapi/openapi.json
-> SDK watch regenerates packages/openwork-server-sdk/generated/**
-> app dev server sees workspace package changes
-> app recompiles with updated types and methods
```

## Watchers

### 1. Server runtime watcher

Purpose:

- reload the backend when server code changes

Inputs:

- `apps/server-v2/src/**`

Should ignore:

- `apps/server-v2/openapi/**`
- `packages/openwork-server-sdk/**`

Reason:

- generated contract artifacts should not cause unnecessary backend restarts

### 2. OpenAPI watcher

Purpose:

- regenerate the new-server contract when routes or schemas change

Inputs:

- `apps/server-v2/src/**`

Output:

- `apps/server-v2/openapi/openapi.json`

Notes:

- this should use `hono-openapi`
- it should be narrowly scoped to new-server sources
- it should debounce rapid file changes to avoid overlapping runs

### 3. SDK watcher

Purpose:

- regenerate the TypeScript SDK when the OpenAPI spec changes

Input:

- `apps/server-v2/openapi/openapi.json`

Output:

- `packages/openwork-server-sdk/generated/**`

Notes:

- it should only react when the spec actually changes
- it should not trigger server reloads
- it should be fast enough to run continuously in dev

### 4. App dev watcher

Purpose:

- recompile the app when app code or SDK package code changes

Inputs:

- `apps/app/**`
- `packages/openwork-server-sdk/**`

Notes:

- the app should consume the SDK package through a workspace dependency
- the app should own the thin `createSdk({ serverId })` adapter that resolves local server config
- in dev, the SDK package should preferably expose TypeScript source directly rather than requiring a full `dist/` build on every change

## Preferred SDK Package Dev Shape

To keep iteration fast, `packages/openwork-server-sdk` should ideally work like this in development:

- generated files land in `generated/**`
- handwritten SDK files like `src/index.ts` and SSE helpers live beside them
- the app imports the package source through the workspace
- the app keeps `createSdk({ serverId })` in app code rather than in the reusable SDK package
- Vite and TypeScript pick up changes automatically

That avoids a slow extra cycle like:

```text
regenerate SDK
-> rebuild package dist
-> app sees dist change
```

If a build step is still needed for packaging or publishing, it should exist, but dev should prefer source consumption whenever possible.

## Runtime Client Creation

The app-facing entrypoint stays:

```ts
const sdk = createSdk({ serverId })
```

or directly:

```ts
await createSdk({ serverId }).sessions.listMessages({ workspaceId, sessionId })
```

`createSdk({ serverId })` should remain lightweight and app-owned.

In the ideal product model, most user-facing app traffic should still target the local OpenWork server as the canonical adapter and registry. Direct alternate `serverId` targeting is mainly for migration, testing, and explicit server-management flows.

It should only:

- resolve `serverId` to the latest known `baseUrl`, `token`, and capability info when direct target selection is needed
- prepare a generated SDK instance plus any app-local migration routing
- return the typed SDK object

It should not:

- perform network discovery by default
- make a capability request on every call
- do expensive initialization work

This keeps per-call SDK creation cheap enough that we do not need to cache or reuse it aggressively.

## What Changes Trigger What

### Change: new-server route handler or schema

- server reloads
- OpenAPI spec regenerates
- SDK regenerates
- app sees updated methods and types

### Change: server internals only, no contract change

- server reloads
- OpenAPI may regenerate
- SDK may regenerate to identical output
- app usually does not need any meaningful change

### Change: generated SDK mapping or SSE helper

- SDK package changes
- app recompiles
- server does not need to restart unless server code also changed

### Change: app feature code only

- app recompiles
- server and SDK do not need to restart

## SSE in Local Dev

There will likely be only one or two SSE endpoints.

Recommended approach:

- document the SSE endpoints in the new server contract
- keep event payloads typed from generated or shared contract types
- expose small handwritten SSE helpers from `packages/openwork-server-sdk`
- let the app consume those helpers through the same `createSdk({ serverId })` entrypoint

That means SSE changes still fit the same watch graph:

- server-side event contract change -> spec generation -> SDK or helper update -> app sees new types
- helper implementation change -> app recompiles immediately

## Avoiding Restart Loops

The main risk in this setup is watchers causing each other to loop.

We should prevent that by keeping responsibilities clean:

- server watcher ignores generated spec and SDK files
- OpenAPI watcher only watches new-server source
- SDK watcher only watches the spec file
- app watcher only consumes the SDK package output, not the server source tree directly

If needed, generation steps should write files only when contents actually change.

## CI Mirror of the Dev Flow

Local dev should be convenient, but CI should still enforce correctness.

CI should run the same core graph without watch mode:

```text
generate openapi spec
-> generate sdk
-> fail if git diff is non-empty
```

That ensures local convenience never replaces contract discipline.

## Suggested Scripts

Exact tooling is still open, but the shape should look like this:

```text
apps/server-v2
- dev                 # backend watch mode
- openapi:generate    # one-shot spec generation
- openapi:watch       # watch new-server sources and regenerate spec

packages/openwork-server-sdk
- generate            # one-shot SDK generation
- watch               # watch spec and regenerate sdk

repo root
- dev:server-v2       # run server watch + openapi watch + sdk watch + app dev together
- dev:server-v2:server # run only the backend/spec/sdk watch graph when the app is not needed
```

Current implementation note:

- `pnpm dev:server-v2` is the default composite command and includes the app dev server.
- `pnpm dev:server-v2:server` exists for backend-only work.
- The SDK watcher watches the OpenAPI directory entry instead of a single file handle so spec rewrites do not silently stop regeneration after replace-style writes.
- OpenAPI generation runs against an isolated temporary Server V2 working directory so contract generation does not touch or depend on a developer's live imported workspace state.

## Developer Experience Target

From a developer's point of view, the happy path should be:

1. run one dev command
2. edit new-server routes, schemas, or app code freely
3. let watchers keep server runtime, spec, SDK, and app types synchronized
4. avoid manual kill/restart/build loops except when tooling itself changes

That is the standard we should design toward.

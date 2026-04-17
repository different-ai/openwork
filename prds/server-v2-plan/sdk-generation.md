# Server V2 SDK Generation

## Status: Draft
## Date: 2026-04-09

## Purpose

This document defines the preferred toolchain for generating the Server V2 TypeScript SDK and how that generation should fit into local development and CI.

This doc assumes Server V2 is a separate new server package, not a sub-application mounted inside the old server.

## Current Recommendation

Preferred stack:

- OpenAPI spec generation: `hono-openapi`
- TypeScript SDK generation: `@hey-api/openapi-ts`
- Reusable client package: `packages/openwork-server-sdk`
- App entrypoint: app-owned `createSdk({ serverId })`
- SSE support: small handwritten helpers exposed from the SDK package, then wrapped by the app adapter

## Why `@hey-api/openapi-ts`

It is the leading SDK generator candidate because it fits the current plan well:

- it generates TypeScript code from OpenAPI
- it supports SDK-oriented output, not just raw schema types
- it aligns better with a method-based client surface than a purely path-based fetch client
- it works well in a monorepo package setup

Compared with `openapi-typescript` + `openapi-fetch`:

- `openapi-fetch` is lightweight and good, but it encourages a path-shaped client surface
- `@hey-api/openapi-ts` is a better fit for the method-based SDK style we want underneath the app-side adapter

## Important Caveat

`@hey-api/openapi-ts` is still in active development and recommends pinning an exact version.

We should treat that as a requirement:

- pin an exact version in `package.json`
- upgrade intentionally
- regenerate the SDK in a dedicated PR when changing versions

## Toolchain Roles

### 1. `hono-openapi`

Role:

- derive the OpenAPI spec from the new server Hono app and its schemas

Output:

- `apps/server-v2/openapi/openapi.json`

### 2. `@hey-api/openapi-ts`

Role:

- generate the TypeScript SDK package from `apps/server-v2/openapi/openapi.json`

Output:

- `packages/openwork-server-sdk/generated/**`

### 3. Handwritten SDK package files

Role:

- expose server-agnostic helpers over the generated client
- expose small typed SSE helpers

Files:

- `packages/openwork-server-sdk/src/index.ts`
- `packages/openwork-server-sdk/src/streams/**`

### 4. App-side adapter

Role:

- export the app-facing `createSdk({ serverId })`
- resolve `serverId` to current runtime config
- inject base URL and auth/token
- select between the current and new server behavior during migration

Files:

- `apps/app/.../createSdk.ts`

## Proposed Package Layout

```text
apps/server-v2/
├── src/**
└── openapi/
    └── openapi.json

packages/openwork-server-sdk/
├── package.json
├── openapi-ts.config.ts
├── generated/**
├── src/
│   ├── streams/
│   └── index.ts
└── scripts/
    └── watch.mjs

apps/app/
└── ... app-side `createSdk({ serverId })` adapter
```

## App-Facing Shape

The overall app-facing shape should be:

```ts
await createSdk({ serverId }).sessions.listMessages({ workspaceId, sessionId })
```

That means:

- generated methods remain the main surface for normal endpoints
- `createSdk({ serverId })` is an app-owned thin runtime adapter
- the reusable SDK package stays server-agnostic
- SSE helpers live in the SDK package and are wrapped by the app adapter as needed

## Generation Flow

One-shot flow:

```text
apps/server-v2/src/**
-> hono-openapi
-> apps/server-v2/openapi/openapi.json
-> @hey-api/openapi-ts
-> packages/openwork-server-sdk/generated/**
```

## Mixed Old/New Routing During Migration

The generated SDK package should represent the new server contract only.

During migration, typed fallback behavior for legacy server routes should live in app-owned adapter code rather than in the generated SDK package itself.

Recommended split:

- `packages/openwork-server-sdk`: generated Server V2 client plus small handwritten SSE helpers for Server V2
- `apps/app/.../createSdk.ts`: rollout checks, capability gating, and per-operation routing
- `apps/app/.../legacy/`: small handwritten compatibility shims for old-server calls that have not been ported yet

Rules:

- do not try to generate one SDK that merges old and new server contracts together
- keep legacy compatibility shims thin and delete them as soon as a feature slice is fully on the new server
- if a legacy route must be used temporarily, normalize its result in the app adapter before returning it to the rest of the UI
- the app-facing call site should still look like `createSdk({ serverId })...` so migration logic stays out of feature code

## Scripts Shape

The exact implementation can vary, but the command model should look like this.

### `apps/server-v2/package.json`

```json
{
  "scripts": {
    "openapi:generate": "node ./scripts/generate-openapi.mjs",
    "openapi:watch": "node ./scripts/watch-openapi.mjs"
  }
}
```

Notes:

- these scripts should load the new server Hono app and emit `openapi/openapi.json`
- they should use `hono-openapi`
- `openapi:watch` should only watch `src/**`

### `packages/openwork-server-sdk/package.json`

```json
{
  "scripts": {
    "generate": "openapi-ts -c openapi-ts.config.ts",
    "watch": "node ./scripts/watch.mjs",
    "typecheck": "tsc --noEmit"
  }
}
```

Notes:

- `generate` should run `@hey-api/openapi-ts` against `apps/server-v2/openapi/openapi.json`
- `watch` can be a small file watcher that reruns `generate` when `openapi/openapi.json` changes
- `typecheck` ensures the generated output and handwritten SDK helpers still compile together

### Root `package.json`

```json
{
  "scripts": {
    "dev:server-v2": "pnpm run dev:server-v2:watchers",
    "dev:server-v2:watchers": "node ./scripts/dev-server-v2.mjs",
    "sdk:generate": "pnpm --filter openwork-server-v2 openapi:generate && pnpm --filter @openwork/server-sdk generate"
  }
}
```

Intent:

- `dev:server-v2` starts the combined dev graph
- `sdk:generate` is the one-shot contract regeneration command for local use and CI

## Suggested Watch Implementation

We should not depend on every tool having perfect built-in watch support.

Instead, prefer small repo-local watcher scripts where needed.

Examples:

- `apps/server-v2/scripts/watch-openapi.mjs`
  - watch `src/**`
  - rerun OpenAPI generation
- `packages/openwork-server-sdk/scripts/watch.mjs`
  - watch `../../apps/server-v2/openapi/openapi.json`
  - rerun `openapi-ts`
- `scripts/dev-server-v2.mjs`
  - run backend dev watch
  - run OpenAPI watch
  - run SDK watch
  - run app dev, which includes the app-side adapter

This gives us full control over debounce behavior, ignores, and restart-loop prevention.

## Runtime Choice

The server runtime remains Bun-based.

The code generation toolchain does not need to match the runtime exactly.

That means:

- `apps/server-v2` can continue running with Bun in dev and production
- code generation can run via `pnpm` and Node-based tooling where needed

This is acceptable because code generation is a build-time/dev-time concern, not a runtime server concern.

## CI Commands

The CI contract check should reduce to one command or one short chain.

Preferred shape:

```bash
pnpm --filter openwork-server-v2 openapi:generate && pnpm --filter @openwork/server-sdk generate && git diff --exit-code
```

That gives us:

- one contract regeneration path
- identical logic between local and CI flows
- immediate detection of stale generated files

## SSE and Generation Boundary

The one or two SSE endpoints should still appear in the new server contract, but they should not block the rest of the SDK generation plan.

Recommended split:

- normal request/response endpoints: generated with `@hey-api/openapi-ts`
- SSE helpers: handwritten in `packages/openwork-server-sdk/src/streams/**`
- typed event payloads: generated or shared contract types only, never imported directly from server source

This keeps the custom surface small.

## Decision Summary

We should plan around:

- `hono-openapi` for OpenAPI generation
- `@hey-api/openapi-ts` for SDK generation
- app-owned `createSdk({ serverId })` as the app-facing entrypoint
- small handwritten SSE helpers for the limited streaming surface

This is the most balanced path between strong typing, monorepo ergonomics, explicit contracts, and low ongoing maintenance.

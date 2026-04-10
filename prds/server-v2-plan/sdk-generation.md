# Server V2 SDK Generation

## Status: Draft
## Date: 2026-04-09

## Purpose

This document defines the preferred toolchain for generating the Server V2 TypeScript SDK and how that generation should fit into local development and CI.

## Chosen Direction

Preferred stack:

- OpenAPI spec generation: `hono-openapi`
- TypeScript SDK generation: `@hey-api/openapi-ts`
- App entrypoint: `createSdk({ serverId })`
- SSE support: small handwritten helpers exposed from the same SDK package

## Why `@hey-api/openapi-ts`

It is the leading SDK generator candidate because it fits the current plan well:

- it generates TypeScript code from OpenAPI
- it supports SDK-oriented output, not just raw schema types
- it aligns better with a method-based client surface than a purely path-based fetch client
- it works well in a monorepo package setup

Compared with `openapi-typescript` + `openapi-fetch`:

- `openapi-fetch` is lightweight and good, but it encourages a path-shaped client surface
- `@hey-api/openapi-ts` is a better fit for the method-based SDK style we want under `createSdk({ serverId })`

## Important Caveat

`@hey-api/openapi-ts` is still in active development and recommends pinning an exact version.

We should treat that as a requirement:

- pin an exact version in `package.json`
- upgrade intentionally
- regenerate the SDK in a dedicated PR when changing versions

## Toolchain Roles

### 1. `hono-openapi`

Role:

- derive the OpenAPI spec from the Hono V2 app and its schemas

Output:

- `apps/server/openapi/v2.json`

### 2. `@hey-api/openapi-ts`

Role:

- generate the TypeScript SDK package from `apps/server/openapi/v2.json`

Output:

- `packages/openwork-server-sdk/src/generated/**`

### 3. Handwritten package files

Role:

- export the app-facing `createSdk({ serverId })`
- resolve `serverId` to current runtime config
- inject base URL and auth/token
- expose small typed SSE helpers

Files:

- `packages/openwork-server-sdk/src/index.ts`
- `packages/openwork-server-sdk/src/create-sdk.ts`
- `packages/openwork-server-sdk/src/streams/**`

## Proposed Package Layout

```text
apps/server/
├── src/v2/**
└── openapi/
    └── v2.json

packages/openwork-server-sdk/
├── package.json
├── openapi-ts.config.ts
├── src/
│   ├── generated/**
│   ├── create-sdk.ts
│   ├── streams/
│   └── index.ts
└── scripts/
    └── watch.mjs
```

## App-Facing Shape

The package should expose a single app-facing entrypoint:

```ts
await createSdk({ serverId }).sessions.listMessages({ workspaceId, sessionId })
```

That means:

- generated methods remain the main surface for normal endpoints
- `createSdk({ serverId })` is the thin runtime adapter
- SSE helpers live behind the same package boundary

## Generation Flow

One-shot flow:

```text
apps/server/src/v2/**
-> hono-openapi
-> apps/server/openapi/v2.json
-> @hey-api/openapi-ts
-> packages/openwork-server-sdk/src/generated/**
```

## Scripts Shape

The exact implementation can vary, but the command model should look like this.

### `apps/server/package.json`

```json
{
  "scripts": {
    "openapi:generate": "node ./script/generate-openapi-v2.mjs",
    "openapi:watch": "node ./script/watch-openapi-v2.mjs"
  }
}
```

Notes:

- these scripts should load the V2 Hono app and emit `openapi/v2.json`
- they should use `hono-openapi`
- `openapi:watch` should only watch `src/v2/**`

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

- `generate` should run `@hey-api/openapi-ts` against `apps/server/openapi/v2.json`
- `watch` can be a small file watcher that reruns `generate` when `v2.json` changes
- `typecheck` ensures the generated output and handwritten adapter still compile together

### Root `package.json`

```json
{
  "scripts": {
    "dev:server-v2": "pnpm run dev:server-v2:watchers",
    "dev:server-v2:watchers": "node ./scripts/dev-server-v2.mjs",
    "sdk:generate": "pnpm --filter openwork-server openapi:generate && pnpm --filter @openwork/server-sdk generate"
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

- `apps/server/script/watch-openapi-v2.mjs`
  - watch `src/v2/**`
  - rerun OpenAPI generation
- `packages/openwork-server-sdk/scripts/watch.mjs`
  - watch `../../apps/server/openapi/v2.json`
  - rerun `openapi-ts`
- `scripts/dev-server-v2.mjs`
  - run backend dev watch
  - run OpenAPI watch
  - run SDK watch
  - optionally run app dev

This gives us full control over debounce behavior, ignores, and restart-loop prevention.

## Runtime Choice

The server runtime remains Bun-based.

The code generation toolchain does not need to match the runtime exactly.

That means:

- `apps/server` can continue running with Bun in dev and production
- code generation can run via `pnpm` and Node-based tooling where needed

This is acceptable because code generation is a build-time/dev-time concern, not a runtime server concern.

## CI Commands

The CI contract check should reduce to one command or one short chain.

Preferred shape:

```bash
pnpm --filter openwork-server openapi:generate && pnpm --filter @openwork/server-sdk generate && git diff --exit-code
```

That gives us:

- one contract regeneration path
- identical logic between local and CI flows
- immediate detection of stale generated files

## SSE and Generation Boundary

The one or two SSE endpoints should still appear in the V2 contract, but they should not block the rest of the SDK generation plan.

Recommended split:

- normal request/response endpoints: generated with `@hey-api/openapi-ts`
- SSE helpers: handwritten in `packages/openwork-server-sdk/src/streams/**`
- typed event payloads: shared from server-owned schema definitions or generated types where practical

This keeps the custom surface small.

## Decision Summary

We should plan around:

- `hono-openapi` for OpenAPI generation
- `@hey-api/openapi-ts` for SDK generation
- `createSdk({ serverId })` as the app-facing entrypoint
- small handwritten SSE helpers for the limited streaming surface

This is the most balanced path between strong typing, monorepo ergonomics, explicit contracts, and low ongoing maintenance.

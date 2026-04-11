# Server V2 Architecture

## Status: Draft
## Date: 2026-04-09

## Purpose

This document expands `prds/server-v2-plan/plan.md` with a more concrete technical design for Server V2.

The goal is to let a new Hono-based server grow inside the current `apps/server` implementation, expose a typed contract, and support incremental client migration across multiple server targets.

## Core Model

Server V2 starts as a new application mounted inside the current server process.

```text
current server process
├── legacy boot and legacy routes
├── shared auth/runtime bridges
└── mounted Hono app for V2
    └── /v2/*
```

This means:

- one process at first
- one deployable unit at first
- two route families during migration
- new logic isolated in new files

## Design Principles

- V2 code lives in new files only.
- The V2 API contract is explicit and typed.
- Clients depend on generated contracts and a small app-side SDK adapter, not server internals.
- Multi-server routing is explicit at the client boundary.
- The desktop app is a thin interface layer, not a second workspace runtime.
- Workspace behavior belongs to the server, even when the server is hosted locally by the desktop app.
- Migration happens by vertical slice, not by broad framework churn.
- Legacy code should be deleted as soon as each migrated slice is complete.

## Ownership Boundary

The architecture should enforce a simple rule:

- the app presents and collects intent
- the server performs workspace work

### Desktop app owns

- local UI state
- navigation and presentation state
- drafts, filters, and transient client-side interaction state
- the list of known servers
- the list of known workspaces that belong to each server
- starting or connecting to server processes

### Server owns

- workspace reads
- workspace writes
- AI/session/task behavior
- project/runtime inspection
- skill, plugin, MCP, and config mutation
- OpenCode integration and sidecar/runtime coordination
- any other workspace-scoped capability that is more than transient UI state

This boundary applies even in desktop-hosted mode. Running on the same machine does not make the UI the right owner of workspace behavior.

## Server Layout

Proposed layout inside `apps/server/src`:

```text
apps/server/src/
├── server.ts
├── legacy/
│   └── ...
└── v2/
    ├── app.ts
    ├── context/
    │   ├── env.ts
    │   ├── auth.ts
    │   └── runtime.ts
    ├── middleware/
    │   ├── request-id.ts
    │   ├── auth.ts
    │   ├── errors.ts
    │   └── logging.ts
    ├── routes/
    │   ├── health.ts
    │   ├── sessions.ts
    │   ├── workspaces.ts
    │   └── ...
    ├── services/
    │   ├── sessions-service.ts
    │   ├── workspaces-service.ts
    │   └── ...
    ├── schemas/
    │   ├── sessions.ts
    │   ├── workspaces.ts
    │   └── ...
    ├── adapters/
    │   ├── opencode.ts
    │   ├── database.ts
    │   └── ...
    └── openapi/
        └── register.ts
```

### Ownership

- `app.ts` builds the Hono app and mounts route groups.
- `routes/` owns HTTP concerns: method, path, validation, response shape.
- `services/` owns domain workflows.
- `schemas/` owns request/response definitions.
- `adapters/` owns integration with OpenCode, storage, and existing runtime pieces.
- `middleware/` owns cross-cutting HTTP concerns.
- `context/` owns per-request wiring and shared typed context.

## Mounting Strategy

The legacy entrypoint mounts Server V2 at a dedicated prefix.

Temporary shape:

```ts
// illustrative only
legacyServer.mount("/v2", createV2App())
```

Rules:

- V2 paths must stay under a stable namespace during migration.
- V1 and V2 must be callable side by side.
- New features should prefer V2 once the route exists.
- Legacy handlers should only be touched to wire mount points or temporary bridges.

## Typed Contract Flow

Server V2 is the source of truth for its contract.

```text
Hono route + schema definitions
-> generated OpenAPI spec
-> generated TypeScript SDK
-> app-side createSdk(serverId) adapter
-> app features
```

### Why this flow

- The server owns the contract.
- The SDK stays in sync through generation.
- App code gets strong typing without importing server implementation.
- A tiny app-side adapter remains free to handle runtime-specific decisions without replacing the generated SDK.
- The app can stay thin because the contract surface represents real workspace capabilities, not just transport helpers.

## OpenAPI and SDK Generation

Detailed generator and script choices live in `prds/server-v2-plan/sdk-generation.md`.

Proposed structure:

```text
apps/server/openapi/v2.json
packages/openwork-server-sdk/src/generated/**
packages/openwork-server-sdk/src/index.ts
```

### Contract rules

- The OpenAPI spec is generated, not handwritten.
- `hono-openapi` is the leading candidate for generating the V2 OpenAPI spec because it is Hono-native and fits the route-first model we want.
- The generated SDK is TypeScript-first.
- The SDK should expose stable exports from `src/index.ts`.
- The app should avoid importing raw generated files directly.
- The app-facing entrypoint should look like `createSdk({ serverId })`.
- `createSdk({ serverId })` should resolve `serverId` into base URL, token, and capabilities locally, then prepare the generated client.
- `createSdk({ serverId })` should stay lightweight enough that it can be called per use without meaningful overhead.
- The SDK surface should grow until app-owned workspace behavior shrinks to near zero.

`hono-openapi` should be treated as the spec-generation layer only:

- it generates the OpenAPI contract from Hono routes and schemas
- a separate SDK generator still produces the TypeScript client package
- SSE ergonomics still likely require small handwritten helpers

### App-facing SDK shape

Preferred usage for standard endpoints:

```ts
await createSdk({ serverId }).sessions.listMessages({ workspaceId, sessionId })
```

This keeps:

- server selection explicit through `serverId`
- resource hierarchy explicit through params like `workspaceId` and `sessionId`
- the client surface mostly generated rather than manually re-modeled

### SSE contract note

OpenAPI can document SSE endpoints, but most generated SDKs do not produce an ergonomic typed streaming API automatically.

Because of that:

- normal JSON endpoints should come directly from the generated SDK
- the likely one or two SSE endpoints may need small handwritten stream helpers
- those helpers should still be exported from the same SDK package
- event payload types should still come from server-owned TypeScript schemas

### CI rules

CI should regenerate both the OpenAPI spec and the SDK and fail if a diff appears.

That gives us:

- no silent contract drift
- reproducible SDK output
- reliable local and CI behavior

## Local Development Loop

The local developer experience should make contract changes visible immediately.

Detailed local watch and rebuild behavior lives in `prds/server-v2-plan/local-dev.md`.

Desired loop:

```text
edit V2 route or schema
-> regenerate openapi/v2.json
-> regenerate TypeScript SDK
-> app sees updated types and methods
-> continue coding without manual sync work
```

Recommended watch pipeline:

- `apps/server`: watch `src/v2/**`, regenerate `openapi/v2.json` through `hono-openapi`
- `packages/openwork-server-sdk`: watch `openapi/v2.json`, regenerate `src/generated/**`
- `packages/openwork-server-sdk`: export a stable `createSdk({ serverId })` entrypoint over the generated client
- `packages/openwork-server-sdk`: optional watch build if the package publishes built output
- `apps/app`: consumes the workspace package directly

This should keep endpoint changes and client types effectively live in monorepo development.

The server runtime watcher should ignore generated OpenAPI and SDK files so contract regeneration does not cause unnecessary backend restart loops.

## Client Architecture

The client side should use a thin adapter over the generated SDK rather than a large custom wrapper hierarchy.

```text
generated SDK
-> createSdk({ serverId }) adapter
-> app features
```

### Generated SDK responsibilities

- typed request and response shapes
- typed route methods
- low-level transport helpers
- representing server-owned workspace capabilities in a reusable client surface

### Thin adapter responsibilities

- resolve `serverId` into current server config
- inject auth/token headers
- choose V1 or V2 during migration
- prepare a lightweight client instance
- add capability checks when needed

The adapter should not rebuild a second large API model on top of the generated SDK unless there is a strong reason.

It also should not become a place where workspace behavior is reimplemented in the app.

## Multi-Server Target Model

The app may talk to different server destinations at the same time, so target selection must be explicit.

The important distinction is:

- a server target identifies which server to talk to
- a workspace ID identifies which workspace on that server to operate on

Those are related, but they are not the same thing.

The app should maintain a list of workspaces. Each workspace record should know which configured server it belongs to, and what that workspace's ID is on that server.

That model is intentionally minimal. The app needs enough local state to know:

- which servers exist
- which workspaces belong to which server
- which workspace is selected in the UI

It should not need to locally own the underlying workspace behavior itself.

That allows:

- multiple workspaces on one server
- multiple configured servers in one app session
- one SDK creation point per server target, with workspace IDs passed into individual operations

Examples:

- local desktop-hosted OpenWork server
- remote worker-backed OpenWork server
- hosted OpenWork Cloud server

Proposed shared shape:

```ts
export type ServerTargetKind = "local" | "remote" | "cloud"

export type ServerTarget = {
  kind: ServerTargetKind
  baseUrl: string
  token?: string
  capabilities?: {
    v2?: boolean
  }
}
```

Preferred app-facing creation:

```ts
const sdk = createSdk({ serverId })
```

Then operations should take the workspace ID explicitly:

```ts
await sdk.sessions.list({ workspaceId })
await sdk.sessions.get({ workspaceId, sessionId })
await sdk.sessions.listMessages({ workspaceId, sessionId })
```

Illustrative app-side model:

```ts
type WorkspaceRecord = {
  id: string
  serverTargetId: string
  remoteWorkspaceId: string
}
```

In that model:

- `serverTargetId` tells the app which server configuration to use
- `remoteWorkspaceId` is the workspace identifier to send to that server

This avoids hidden globals and makes mixed-target flows possible while keeping server selection separate from workspace identity.

## Migration Routing Model

During migration, the adapter may choose between V1 and V2 per operation.

Example decision inputs:

- does the target advertise V2 capability?
- is the feature enabled for V2?
- has this specific endpoint been ported?
- do we need a temporary fallback?

Illustrative flow:

```text
feature resolves workspace -> server target
-> feature calls createSdk({ serverId }).sessions.list({ workspaceId })
-> adapter inspects target + capability + rollout settings
-> adapter calls V1 or V2 implementation
-> feature receives typed result
```

This keeps migration logic out of the UI.

The more of the product surface we move behind the server, the less special-case behavior the app needs to keep locally.

## Streaming Strategy

The app should consume OpenCode-related streaming only through the OpenWork server.

That means:

- the desktop app never connects directly to underlying OpenCode SSE endpoints
- Server V2 exposes its own SSE endpoints where needed
- Server V2 can proxy, translate, or normalize underlying OpenCode stream events

Because there will likely be only one or two SSE endpoints, we do not need a large custom streaming framework.

Recommended shape:

- document the SSE routes in the V2 contract
- keep event payloads typed from server-owned TypeScript schemas
- expose small handwritten streaming helpers from `packages/openwork-server-sdk`
- keep those helpers under the same `createSdk({ serverId })` entrypoint

Illustrative usage:

```ts
const stream = await createSdk({ serverId }).sessions.streamMessages({
  workspaceId,
  sessionId,
})

for await (const event of stream) {
  // typed SSE event
}
```

This gives us one unified client surface while accepting that OpenAPI generation alone is usually not enough for ergonomic typed SSE consumption.

## Domain Slice Migration

The preferred migration unit is a vertical slice.

Example order:

1. health and diagnostics
2. low-risk read endpoints
3. session reads
4. workspace reads
5. mutations
6. higher-risk workflow endpoints

Rules:

- migrate one slice fully enough to validate the pattern
- switch that slice's adapter routing to V2
- remove app-owned workspace logic for that slice when the server version is ready
- remove legacy code when the slice no longer needs V1

Example categories to move behind the server over time:

1. workspace file reads and writes
2. workspace config mutation
3. skill/plugin/MCP mutation
4. project/runtime inspection
5. session/task execution behavior

## Error and Compatibility Model

V2 should improve consistency instead of repeating legacy inconsistencies.

Targets:

- consistent error envelopes
- predictable auth failures
- stable response schemas
- request IDs for tracing
- typed success and error bodies where practical

During migration, the adapter may need to normalize V1 and V2 responses into one app-facing shape.

## Testing Strategy

We need confidence at three levels.

### 1. Contract tests

- route validation works
- response schemas match expectations
- generated SDK matches current spec

### 2. Server integration tests

- V2 routes hit real service/adapters
- auth and runtime context behave correctly
- legacy and V2 can coexist in one process

### 3. App integration tests

- the SDK adapter calls the correct target
- V1/V2 switching works
- desktop flows continue to work while slices are migrated

## Exit Criteria for the Old Server

We can remove the legacy server code when:

- all app consumers use V2-backed SDK calls
- no routes still require V1 handlers
- compatibility shims are no longer needed
- the current server entrypoint only exists as the V2 entrypoint, or is replaced entirely

At that point, V2 stops being a migration concept and becomes the server.

The same spirit applies to the client boundary:

- the app still owns local UI state
- but workspace capabilities should no longer be split between app and server
- the server should be the clear owner of workspace behavior

## Open Decisions

- final V2 prefix: `/v2`, `/api/v2`, or another stable path
- exact OpenAPI generation toolchain
- exact SDK generation toolchain
- whether capability detection is static, dynamic, or both
- which endpoint group becomes the first proof-of-path migration

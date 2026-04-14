# Server V2 Architecture

## Status: Draft
## Date: 2026-04-09

## Purpose

This document expands `prds/server-v2-plan/plan.md` with a more concrete technical design for Server V2.

The goal is to define a whole new Hono-based server package, expose a typed contract, and support incremental client migration onto that server.

## Core Model

Server V2 starts as a separate new server package and process.

```text
apps/server-v2/
├── server process
├── OpenAPI contract
└── server-owned runtime/workspace behavior
```

This means:

- a clean replacement server boundary
- a separate deployable/process during the transition
- new logic isolated in new files
- no need to preserve legacy server structure while designing the new architecture

## Target End State

The long-term target is a single main server API surface.

Desired shape:

```text
desktop app or CLI
-> starts or connects to one OpenWork server process
-> OpenWork server owns workspace/runtime/product behavior
-> OpenWork server supervises the local runtime pieces it needs
```

This means:

- the orchestrator should stop being a separate product control plane
- orchestrator runtime/workspace APIs should be folded into the main server
- bootstrap and supervision behavior should move into the main server wherever practical

## Design Principles

- Server V2 code lives in new files only.
- The new server API contract is explicit and typed.
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
- cached/derived visible server and workspace state returned by the server
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

The same principle applies to the orchestrator boundary:

- product/runtime control surfaces should move into the server
- bootstrap and supervision should also move into the server wherever practical
- the desktop shell should ideally launch one server process, not a separate runtime manager

## Server Layout

Proposed package layout inside `apps/server-v2`:

```text
apps/server-v2/
├── src/
│   ├── app.ts
│   ├── cli.ts
│   ├── bootstrap/
│   ├── database/
│   ├── context/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── schemas/
│   └── adapters/
├── openapi/
└── scripts/
```

### Ownership

- `app.ts` builds the Hono app and mounts route groups.
- `bootstrap/` owns server startup plus any runtime supervision that gets folded into the server.
- `database/` owns sqlite state, migrations, and persistence boundaries.
- `routes/` owns HTTP concerns: method, path, validation, response shape.
- `services/` owns domain workflows.
- `schemas/` owns request/response definitions.
- `adapters/` owns integration with OpenCode, storage, and runtime pieces.
- `middleware/` owns cross-cutting HTTP concerns.
- `context/` owns per-request wiring and shared typed context.

## Runtime Supervision Inside The New Server

The new server should not just proxy product logic. It should also supervise the local runtime pieces it depends on.

That includes:

- OpenCode
- `opencode-router`
- any other local child runtime needed for the product surface

### Router supervision model

Current baseline being replaced:

- orchestrator decides whether router is enabled
- orchestrator resolves the router binary
- orchestrator spawns and supervises the router

Target model:

- server bootstrap decides whether router is enabled
- server bootstrap resolves the router binary
- server bootstrap spawns and supervises the router
- server API exposes router status/control behavior to the UI

Recommended shape:

- one `opencode-router` child per local OpenWork server
- server-owned router config materialization from sqlite or server-managed config state
- server-owned health checks, restart behavior, and status reporting

This keeps router lifecycle under the same ownership boundary as the rest of the runtime.

### Why one router per server

- identities and bindings are naturally server-level
- supervision is simpler
- workspace scoping can still be enforced by server logic
- the UI does not need to understand a second runtime graph

## Startup Strategy

The desktop app should eventually launch the new server directly.

Target shape:

```text
desktop app
-> launches apps/server-v2
-> talks only to the new server process
```

Rules:

- the new server should not be designed as a mounted sub-application of the old server
- startup/bootstrap should move into the new server package over time
- orchestrator control-plane routes should be replaced by main-server routes rather than preserved as a second API model

## Typed Contract Flow

The new server is the source of truth for its contract.

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
apps/server-v2/openapi/openapi.json
packages/openwork-server-sdk/generated/**
packages/openwork-server-sdk/src/index.ts
apps/app/.../createSdk({ serverId }) adapter
```

### Contract rules

- The OpenAPI spec is generated, not handwritten.
- `hono-openapi` is the leading candidate for generating the new server OpenAPI spec because it is Hono-native and fits the route-first model we want.
- The generated SDK is TypeScript-first.
- The SDK should expose stable exports from `src/index.ts`.
- The app should avoid importing raw generated files directly.
- The generated SDK package should stay server-agnostic and reusable.
- The app-facing entrypoint should look like `createSdk({ serverId })`.
- `createSdk({ serverId })` should live in app code, resolve `serverId` into base URL, token, and capabilities locally, then prepare the generated client.
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
- event payload types should come from generated or shared contract output, not from server source files

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
edit new-server route or schema
-> regenerate openapi/openapi.json
-> regenerate TypeScript SDK
-> app sees updated types and methods
-> continue coding without manual sync work
```

Recommended watch pipeline:

- `apps/server-v2`: watch `src/**`, regenerate `openapi/openapi.json` through `hono-openapi`
- `packages/openwork-server-sdk`: watch `openapi/openapi.json`, regenerate the reusable generated client package
- `apps/app`: watch the app-side `createSdk({ serverId })` adapter alongside normal app code
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
- during migration, route features to the current or new server when needed
- prepare a lightweight client instance
- add capability checks when needed

The adapter should not rebuild a second large API model on top of the generated SDK unless there is a strong reason.

It also should not become a place where workspace behavior is reimplemented in the app.

## Multi-Server Target Model

The system may know about different server destinations at the same time, so target selection must be explicit.

The important distinction is:

- a server target identifies which server to talk to
- a workspace ID identifies which workspace on that server to operate on

Those are related, but they are not the same thing.

The local OpenWork server should maintain the durable registry of servers and workspaces. The app should render or cache what the server returns.

That model is intentionally minimal. The app only needs enough local state to know:

- which servers exist
- which workspaces belong to which server
- which workspace is selected in the UI

It should not need to locally own the underlying workspace behavior itself.

That allows:

- multiple workspaces on one server
- multiple configured servers in one app session
- one SDK creation point per server target, with workspace IDs passed into individual operations when direct server targeting is needed

Examples:

- local desktop-hosted OpenWork server
- remote worker-backed OpenWork server
- hosted OpenWork Cloud server

Proposed shared shape:

```ts
export type ServerTargetKind = "local" | "remote"

export type ServerHostingKind = "desktop" | "self_hosted" | "cloud"

export type ServerTarget = {
  kind: ServerTargetKind
  hostingKind: ServerHostingKind
  baseUrl: string
  token?: string
  capabilities?: {
    v2?: boolean
  }
}
```

Preferred app-facing creation during migration or server-management flows:

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
}
```

In that model:

- `serverTargetId` tells the app which server configuration to use
- `id` is the stable OpenWork workspace identifier the UI uses

This avoids hidden globals and makes mixed-target flows possible while keeping server selection separate from workspace identity.

In the ideal steady state, normal app traffic should still flow through the local OpenWork server using stable OpenWork workspace IDs, with remote OpenWork workspace IDs and OpenCode project IDs remaining server-owned mappings.

## Migration Routing Model

During migration, the adapter may choose between the current and new server per operation.

Example decision inputs:

- does the target advertise new-server capability?
- is the feature enabled for the new server?
- has this specific endpoint been ported?
- do we need a temporary fallback?

Illustrative flow:

```text
feature resolves workspace -> server target
-> feature calls createSdk({ serverId }).sessions.list({ workspaceId })
-> adapter inspects target + capability + rollout settings
-> adapter calls the current or new server implementation
-> feature receives typed result
```

This keeps migration logic out of the UI.

The more of the product surface we move behind the server, the less special-case behavior the app needs to keep locally.

## Streaming Strategy

The app should consume OpenCode-related streaming only through the OpenWork server.

That means:

- the desktop app never connects directly to underlying OpenCode SSE endpoints
- the new server exposes its own SSE endpoints where needed
- the new server can proxy, translate, or normalize underlying OpenCode stream events

Because there will likely be only one or two SSE endpoints, we do not need a large custom streaming framework.

Recommended shape:

- document the SSE routes in the new server contract
- keep event payloads typed from generated or shared contract types
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
- switch that slice's adapter routing to the new server
- remove app-owned workspace logic for that slice when the new server version is ready
- remove old-server code when the slice no longer needs it

Example categories to move behind the server over time:

1. workspace file reads and writes
2. workspace config mutation
3. skill/plugin/MCP mutation
4. project/runtime inspection
5. session/task execution behavior
6. orchestrator workspace/runtime control APIs
7. orchestrator-managed tool/config mutation behavior

## Orchestrator Integration Path

The recommended path is to collapse orchestrator responsibilities inward rather than preserve a separate orchestrator control plane forever.

### What should move into the server

- workspace activation and disposal semantics
- runtime control/status/upgrade product APIs
- daemon-style workspace/runtime control surfaces
- config/skill/plugin/MCP mutation product capabilities
- managed OpenCode integration behavior that clients should consume through one API
- child process launch and supervision where practical
- sidecar and binary resolution where practical
- local env/port/bootstrap setup where practical
- sandbox/container startup orchestration where practical

### Recommended migration shape

```text
today:
desktop -> orchestrator API -> server API

target:
desktop -> server API
desktop -> launches one server process
server -> starts and supervises local children when needed
```

This removes the separate orchestrator boundary rather than preserving it as a second permanent host layer.

## Error and Compatibility Model

The new server should improve consistency instead of repeating legacy inconsistencies.

Targets:

- consistent error envelopes
- predictable auth failures
- stable response schemas
- request IDs for tracing
- typed success and error bodies where practical

During migration, the adapter may need to normalize old-server and new-server responses into one app-facing shape.

## Testing Strategy

We need confidence at three levels.

### 1. Contract tests

- route validation works
- response schemas match expectations
- generated SDK matches current spec

### 2. Server integration tests

- new-server routes hit real service/adapters
- auth and runtime context behave correctly
- the new server works correctly as its own process and API surface

### 3. App integration tests

- the SDK adapter calls the correct target
- adapter-based old-server/new-server switching works during migration
- desktop flows continue to work while slices are migrated

## Exit Criteria for the Old Server

We can remove the old server when:

- all app consumers use new-server-backed SDK calls
- no routes still require the old server
- compatibility shims are no longer needed
- desktop startup launches only the new server

At that point, Server V2 stops being a migration concept and becomes the server.

The same spirit applies to the client boundary:

- the app still owns local UI state
- but workspace capabilities should no longer be split between app and server
- the server should be the clear owner of workspace behavior

The same spirit also applies to the orchestrator boundary:

- runtime/workspace product capability should no longer be split between orchestrator and server
- bootstrap and supervision should also collapse into the server wherever possible
- the main server should be the canonical and primary runtime control surface

## Open Decisions

- whether capability detection is static, dynamic, or both
- which endpoint group becomes the first proof-of-path migration
- whether the working name `openwork-server-v2` survives to ship time or is renamed before release

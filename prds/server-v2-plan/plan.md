# PRD: Server V2 Incremental Adoption Plan

## Status: Draft
## Date: 2026-04-09

## Problem

`apps/server` needs a full rewrite, but we cannot do a stop-the-world replacement. We need a path that lets a new server grow inside the current server, ship safely in stages, and eventually replace all existing server code with new files.

The new server surface will be a Hono app. In the short term, the current server can keep owning process boot, top-level wiring, and existing routes, while mounting the Hono app under a separate subpath. The desktop app then needs a controlled way to move from legacy paths to new paths one area at a time.

## Goals

- Build a new server implementation in new files without extending the lifetime of the legacy architecture.
- Run Server V2 inside the current `apps/server` process at first so we can migrate incrementally.
- Mount the new Hono app on a separate subpath so V1 and V2 can coexist.
- Keep full TypeScript type safety across server routes, generated clients, and the app-side SDK adapter.
- Make the desktop app a thin client that starts the server, maintains local UI state, and sends all workspace behavior through the server.
- Give the desktop app a clean migration layer so it can switch to new server paths bit by bit.
- End with all active server behavior living in the new code, after which the old server code can be deleted.

## Non-Goals

- Doing a single big-bang rewrite.
- Repointing all desktop traffic in one release.
- Keeping both architectures around indefinitely.
- Rewriting storage or domain behavior unless it is required for the new server path.
- Preserving Tauri-only or app-only workspace capabilities as a permanent parallel system.

## Working Approach

### 1. Keep one running server process at first

The current server remains the entrypoint initially. It continues to own startup, existing integrations, and current production behavior while mounting a new Hono app under a dedicated prefix.

Example shape:

```text
current server process
├── legacy routes
└── /v2/* -> Hono app
```

This gives us:

- one deployable server binary/process
- no immediate infrastructure split
- low-risk incremental routing changes
- a clean place for new code to grow without mixing it into legacy handlers

### 2. Put all new server work in a dedicated V2 tree

Create a clearly isolated area for the replacement server so the migration is obvious and deletion is easy later.

Proposed shape:

```text
apps/server/src/
├── server.ts              # existing boot path, temporary mount point
└── v2/
    ├── app.ts             # Hono app creation
    ├── routes/
    ├── middleware/
    ├── services/
    ├── schemas/
    └── adapters/
```

Rule: new server functionality goes into `v2/` files, not into legacy handlers, unless a tiny bridge is needed to mount or route traffic.

### 3. Migrate the desktop app through an explicit API layer

The desktop app should not scatter raw server paths throughout the UI. More importantly, it should stop owning workspace behavior directly.

The target model is:

- the desktop app spins up or connects to servers
- the desktop app maintains local UI state and a list of connected servers
- the desktop app maintains a list of workspaces that belong to those servers
- all real workspace operations go through the server

That means the desktop app should not be the long-term owner of:

- file reads
- file writes
- workspace mutation
- AI/session/task operations
- project/runtime inspection
- skill/plugin/config mutation
- other workspace-scoped business logic

Those should become server responsibilities, even in desktop-hosted mode.

To move incrementally, the app needs a small client-side API layer that can decide whether a feature calls V1 or V2.

That layer should:

- centralize server route construction
- expose named operations instead of raw URL strings
- allow per-feature or per-endpoint migration
- make fallback possible while V2 is incomplete

Example migration shape:

```text
desktop feature
-> app server client module
-> legacy path or v2 path
```

This lets the backend and frontend migrate independently but in a coordinated way.

## Ownership Boundary

The long-term ownership boundary should be explicit.

### Desktop app responsibilities

- launch or connect to one or more servers
- maintain local UI state
- maintain presentation state, navigation state, drafts, and preferences
- maintain a list of known servers and a list of workspaces that belong to those servers
- render server-backed data and send user intent to the server

### Server responsibilities

- own all workspace-scoped behavior
- own all file reads and writes
- own all AI, session, and task execution behavior
- own project discovery and runtime inspection
- own skill, plugin, MCP, and config mutation
- own local-runtime integration with OpenCode and related sidecars
- expose all of that through a stable API surface for the app

### Rule of thumb

If something is a real workspace capability rather than transient UI state, it should live behind the server.

The app is the interface. The server does the work.

## Orchestrator Collapse Target

The target architecture is not just "move app behavior behind the server".

It is also:

- stop treating the orchestrator as a separate long-term control plane
- fold orchestrator-owned product/runtime capabilities into the main server
- fold bootstrap and supervision responsibilities into the main server itself wherever possible

Desired end state:

```text
desktop app or CLI
-> starts or connects to one OpenWork server process
-> OpenWork server owns workspace/runtime/product behavior
-> OpenWork server supervises the local runtime pieces it needs
```

Not the desired end state:

```text
desktop app
-> orchestrator control plane
-> separate server control plane
```

What should move into the main server:

- workspace activation and runtime control APIs
- runtime status and health product surfaces
- upgrade/control semantics exposed to clients
- config/skill/plugin/MCP mutation flows
- OpenCode integration behavior that is really a workspace capability
- other orchestrator control-plane logic that clients should not need to understand separately
- process supervision for OpenCode/router/runtime pieces where practical
- sidecar/binary/runtime resolution where practical
- local bootstrap logic that only exists to support the OpenWork runtime

The desktop app should ideally only launch the main server process, not assemble and supervise a second runtime graph itself.

## Route Strategy

Start with a dedicated path prefix for the Hono app.

Candidate prefixes:

- `/v2`
- `/api/v2`
- `/server/v2`

Recommendation: choose one explicit prefix and keep it stable for the entire migration. The exact prefix is still an open decision, but the important part is that V2 is clearly namespaced and can be targeted intentionally by the desktop app.

## Contract and SDK Strategy

Server V2 should be the source of truth for its API contract.

Detailed generator and script choices live in `prds/server-v2-plan/sdk-generation.md`.

Planned approach:

- define V2 routes in TypeScript with Hono and typed schemas
- generate an OpenAPI spec from the Hono app, likely with `hono-openapi`
- generate a TypeScript SDK from that OpenAPI spec
- consume that SDK from a small app-side `createSdk({ serverId })` adapter instead of calling raw paths directly

This keeps the server contract synchronized through code generation instead of manual duplication.

### Recommended package shape

```text
apps/server/
├── src/v2/...
└── openapi/
    └── v2.json                  # generated

packages/openwork-server-sdk/
├── generated/                  # generated from OpenAPI
├── src/index.ts                # stable server-agnostic exports
└── package.json

apps/app/
└── ... app-side `createSdk({ serverId })` adapter
```

### Rules

- The Hono route definitions and schemas are the source of truth.
- The OpenAPI spec is a generated artifact.
- `hono-openapi` is the leading candidate for spec generation because it is built for Hono and aligns with the V2 stack.
- The SDK is generated from the spec and stays TypeScript-native.
- The generated SDK package should stay server-agnostic and reusable.
- App features should call a single app-side entrypoint such as `createSdk({ serverId })`.
- `createSdk({ serverId })` should live in app code, resolve server config locally, and prepare a typed client with the correct base URL and token.
- The app should not pass raw `baseUrl` and `token` around feature code.
- The app should not implement parallel workspace behavior when that behavior can be expressed as a server capability.
- For standard JSON endpoints, the generated SDK should be the primary client surface.
- For the one or two SSE endpoints, we may need small handwritten streaming helpers exposed from the same SDK package.
- `hono-openapi` covers contract generation, not the full client story; SDK generation and SSE helpers remain separate concerns.

### Why not import server code directly?

We want shared contracts, not shared runtime implementation.

- clients should share types and operations with the server
- clients should not import server internals, Hono handlers, or server runtime wiring
- the server must remain free to evolve internally without leaking implementation structure into the app

### App-facing SDK shape

Preferred app usage:

```ts
await createSdk({ serverId }).sessions.listMessages({ workspaceId, sessionId })
```

This gives us:

- generated endpoint methods and types
- explicit server selection through `serverId`
- explicit resource selection through `workspaceId`, `sessionId`, and similar params
- no need for a large handwritten fluent wrapper layer
- no coupling between app code and server source files

## Local Dev Contract Workflow

The generated SDK should work in local development, not only in CI.

Detailed watch-mode workflow lives in `prds/server-v2-plan/local-dev.md`.

Desired loop:

1. change a V2 Hono endpoint or schema
2. regenerate the OpenAPI spec locally
3. regenerate the TypeScript SDK locally
4. app code sees the updated types and client methods immediately

Recommended local setup:

- `apps/server` watches `src/v2/**` and regenerates `openapi/v2.json`
- `packages/openwork-server-sdk` watches `openapi/v2.json` and regenerates the reusable generated client package
- `packages/openwork-server-sdk` regenerates the reusable server-agnostic client package
- the app watches its own `createSdk({ serverId })` adapter alongside normal app code
- the app depends on `openwork-server-sdk` through the workspace so type updates are visible immediately
- if the SDK needs a build step, run that build in watch mode too

To avoid restart loops, the server runtime watcher should ignore generated spec and SDK files.

This should make endpoint changes flow into the app with minimal delay during development.

### CI enforcement

Local watch mode is a convenience. CI should still be the guardrail.

CI should:

- regenerate the OpenAPI spec
- regenerate the SDK
- fail if regeneration produces a git diff

That makes contract drift visible immediately and keeps the generated client trustworthy.

## Migration Strategy

### Phase 0: Prepare the seam

- Add a Hono app entrypoint under `apps/server/src/v2/`.
- Mount it under a dedicated subpath from the current server.
- Add a minimal health or test route to prove the mount works.
- Add OpenAPI generation for the V2 app, likely via `hono-openapi`.
- Add a generated TypeScript SDK package for V2.
- Add an app-side `createSdk({ serverId })` adapter before migrating individual features.
- Document which desktop-owned capabilities must move behind the server over time.

Success criteria:

- V1 server behavior is unchanged.
- V2 routes respond successfully under the new prefix.
- OpenAPI generation and SDK generation succeed locally.
- The desktop app has one place to resolve `serverId` into runtime config and call generated endpoints.

### Phase 1: Move low-risk read endpoints first

Start with read-only or low-risk endpoints so the migration path is proven before touching write flows.

- Implement new endpoints in Hono.
- Point a small, isolated desktop surface at the V2 path.
- Compare behavior against the existing implementation.

Success criteria:

- The desktop app can use at least one V2 endpoint in production-like flows.
- Fallback to V1 remains possible if needed.

### Phase 2: Move mutations and workflow endpoints

Once the structure is stable, move write paths and workflow endpoints in slices.

- Port one capability area at a time.
- Keep domain behavior consistent while the transport layer changes.
- Avoid broad dual-write logic unless absolutely necessary.

Success criteria:

- End-to-end feature flows work through V2 for selected areas.
- Legacy endpoints remain available only for unmigrated consumers.

### Phase 3: Collapse orchestrator control-plane responsibilities into the server

Once the server surface is credible, start moving orchestrator-owned product capabilities into the main server.

- move workspace/runtime control APIs into the server
- move orchestrator daemon API semantics into server-owned routes
- move config/skill/plugin/MCP mutation ownership into the server
- move bootstrap and supervision logic into the server so clients do not depend on a separate host runtime manager

Success criteria:

- clients do not need a separate orchestrator API model
- server routes become the canonical runtime/workspace control surface
- orchestrator disappears as a meaningful product layer

### Phase 4: Make V2 the default path

- Switch desktop API clients to prefer V2 by default.
- Keep a temporary fallback or kill switch while rollout completes.
- Monitor for gaps in auth, payload shape, and error handling.

Success criteria:

- New desktop traffic uses V2 by default.
- V1 is only serving straggler routes.

### Phase 5: Remove V1 and leftover orchestrator control-plane code

- Delete the remaining legacy handlers once all consumers are moved.
- Promote V2 structure to be the only server implementation.
- Remove temporary compatibility bridges.
- delete or absorb orchestrator code that only existed to provide a separate control plane or bootstrap layer

Success criteria:

- No active desktop or external path depends on legacy server code.
- All server behavior lives in the new files.
- orchestrator is no longer needed as a separate product/runtime layer.

## Desktop App Requirements

To migrate safely, the desktop app should introduce a server-facing boundary before moving features.

The desired end state is not just route migration. It is responsibility migration.

The desktop app should become a thin client.

Requirements:

- one module owns server resolution from `serverId`
- features call typed operations, not literal URL paths
- route selection can happen per endpoint or per feature area
- the target server is selected explicitly by `serverId`, not hidden global state
- it is easy to see which calls are still on V1 versus V2
- the app only owns transient UI state, not durable workspace behavior
- the app can list known servers and the workspaces available within each server
- workspace reads, writes, AI actions, and config mutations should route through the server

Nice-to-have follow-ups:

- a feature flag or config switch for targeted rollout
- a capability probe so the app can detect V2 support from the server
- simple request logging that shows whether traffic used V1 or V2

### Client SDK model

The app may talk to multiple server destinations, but the preferred API is still one SDK entrypoint.

Examples:

- local desktop-hosted server
- remote worker-backed server
- hosted OpenWork Cloud server

Because of that, SDK creation should take an explicit `serverId`.

The key separation is:

- the SDK resolves which server to call from `serverId`
- each operation receives the workspace ID to use on that server

That matters because one server can host many workspaces, and the app can be configured with many servers at once.

Example shape:

```ts
const sdk = createSdk({ serverId })

await sdk.sessions.list({ workspaceId })
await sdk.sessions.get({ workspaceId, sessionId })
await sdk.sessions.listMessages({ workspaceId, sessionId })
```

Illustrative app-side record:

```ts
type WorkspaceRecord = {
  id: string
  serverTargetId: string
  remoteWorkspaceId: string
}
```

This keeps target selection explicit and makes it possible to route one part of the app to one server while another part uses a different destination, while still supporting multiple workspaces on the same server.

The generated SDK should stay transport-level and typed. The thin handwritten adapter should own:

- server target selection
- auth headers and tokens
- V1 versus V2 decision-making during migration
- lightweight client preparation
- capability checks and fallbacks

It should not grow into a second workspace engine inside the app.

### SSE endpoint strategy

Most V2 endpoints should be standard request/response endpoints covered directly by the generated SDK.

For the likely one or two SSE endpoints:

- the OpenWork server should still be the only streaming surface the app talks to
- the SSE routes should still be documented in the V2 contract
- event payloads should still be typed from generated or shared contract types, not imported directly from server source
- we may need a small handwritten streaming helper because most OpenAPI generators do not produce an ergonomic typed SSE client automatically

Goal:

- normal endpoints: fully generated TypeScript SDK methods
- SSE endpoints: small typed streaming helpers exposed from the same package so app usage still feels unified

## Architectural Principles

- **New code in new files**: treat `v2/` as the replacement tree, not an extension of legacy code.
- **Compatibility first**: mount V2 inside the current server before attempting any infrastructure split.
- **One slice at a time**: move vertical feature slices instead of mixing many partial migrations.
- **Explicit routing**: desktop traffic should choose V1 or V2 intentionally, not accidentally.
- **Server-owned workspace behavior**: file access, AI/runtime behavior, project/config mutation, and other workspace capabilities belong to the server, not the UI.
- **Thin desktop app**: the app should mainly launch/connect servers, hold local presentation state, and render server-backed workflows.
- **Delete as you go**: once a feature is fully on V2, remove the corresponding legacy code instead of letting both versions linger.

## Risks

- The desktop app may have too many direct server path references, making migration noisy until a client boundary exists.
- The desktop app currently owns native and local behavior that should eventually move behind the server boundary.
- Shared auth/session/runtime behavior may be entangled with the legacy server boot path.
- Orchestrator responsibilities may be tightly coupled to host bootstrapping, making it harder to separate true bootstrap concerns from product control-plane concerns.
- V1 and V2 payloads may drift if both are maintained for too long.
- If the V2 prefix is treated as temporary, migration may stall and leave two permanent APIs.

## Open Questions

- Which path prefix should V2 use permanently during migration?
- Should the desktop app choose V1 vs V2 by feature flag, capability detection, hardcoded route map, or a mix?
- Which server surface is the best first slice to migrate as a proof point?
- Are there any external consumers besides the desktop app that must keep using V1 paths during the transition?
- At what point should the current server stop owning anything other than bootstrapping?
- What bootstrap responsibilities truly must remain outside the server process, if any, once orchestration is folded inward?

## Immediate Next Steps

1. Create `apps/server/src/v2/` with a minimal Hono app and mount point.
2. Choose the V2 route prefix.
3. Add OpenAPI generation for the V2 Hono app.
4. Create a TypeScript SDK package generated from the V2 OpenAPI spec.
5. Add `createSdk({ serverId })` so the app resolves server config without passing raw URLs and tokens around.
6. Define the one or two SSE endpoints and their typed event payloads.
7. Inventory desktop-owned workspace capabilities and prioritize which ones move behind the server first.
8. Identify the first orchestrator-owned control-plane capability to fold into the main server.
9. Identify the first low-risk endpoint group to migrate.
10. Port the first feature slice end to end and use it as the template for the rest.

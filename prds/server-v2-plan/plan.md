# PRD: Server V2 New Server Plan

## Status: Draft
## Date: 2026-04-09

## Problem

The current server architecture is not the one we want to keep.

We want to build a whole new server as its own server package and process, make that server the real owner of product/runtime/workspace behavior, and then switch the desktop app to start and consume that new server directly.

For planning purposes in this doc set, `openwork-server-v2` is the working name for that new package, binary, and runtime bundle. We can rename it later without changing the architecture direction.

## Goals

- Build a new server implementation in new files without extending the lifetime of the legacy architecture.
- Build the new server as a separate server, not as a mounted sub-application inside the old server.
- Keep full TypeScript type safety across server routes, generated clients, and the app-side SDK adapter.
- Make the desktop app a thin client that starts the server, maintains local UI state, and sends all workspace behavior through the server.
- Give the desktop app a clean migration layer so UI features can move to the new server bit by bit.
- End with the desktop app starting only the new server, with the old server removed.

## Non-Goals

- Doing a single big-bang rewrite.
- Repointing all desktop traffic in one release.
- Keeping both architectures around indefinitely.
- Rewriting storage or domain behavior unless it is required for the new server path.
- Preserving Tauri-only or app-only workspace capabilities as a permanent parallel system.

## Working Approach

### 1. Build a whole new server package

The new server should exist as its own package and process.

Example shape:

```text
apps/server-v2/
├── src/
│   └── cli.ts
├── openapi/
└── package.json
```

This gives us:

- a clean architecture from day one
- no need to preserve old server structure while designing the new one
- a direct path to making the desktop app launch the new server when ready
- a clear ownership boundary for new work

### 2. Put all new server work in the new server package

Create a clearly isolated package for the replacement server so the migration is obvious and deletion is easy later.

Proposed shape:

```text
apps/server-v2/
├── src/
│   ├── app.ts
│   ├── cli.ts
│   ├── routes/
│   ├── middleware/
│   ├── services/
│   ├── schemas/
│   └── adapters/
└── openapi/
```

Rule: new server functionality goes into the new server package, not into legacy server files.

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

To move incrementally, the app needs a small client-side API layer that can move features onto the new server without changing the rest of the UI shape all at once.

That layer should:

- centralize server route construction
- expose named operations instead of raw URL strings
- allow per-feature or per-endpoint migration
- make fallback possible while the new server is incomplete

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
- cache and render the visible list of servers and workspaces returned by the server
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

The new server should expose OpenWork-shaped routes directly.

Recommendation:

- use workspace-first OpenWork routes as the real public API shape
- use `/system/*` for server-level operational and runtime endpoints that are not scoped to a workspace
- do not design the route system around mounting under a legacy subpath
- treat versioning as a deployment or compatibility concern, not as the primary organizing principle of the new server

## Contract and SDK Strategy

The new server should be the source of truth for its API contract.

Detailed generator and script choices live in `prds/server-v2-plan/sdk-generation.md`.

Planned approach:

- define new-server routes in TypeScript with Hono and typed schemas
- generate an OpenAPI spec from the Hono app, likely with `hono-openapi`
- generate a TypeScript SDK from that OpenAPI spec
- consume that SDK from a small app-side `createSdk({ serverId })` adapter instead of calling raw paths directly

This keeps the server contract synchronized through code generation instead of manual duplication.

### Recommended package shape

```text
apps/server-v2/
├── src/...
└── openapi/
    └── openapi.json             # generated

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

1. change a new-server Hono endpoint or schema
2. regenerate the OpenAPI spec locally
3. regenerate the TypeScript SDK locally
4. app code sees the updated types and client methods immediately

Recommended local setup:

- `apps/server-v2` watches `src/**` and regenerates `openapi/openapi.json`
- `packages/openwork-server-sdk` watches `openapi/openapi.json` and regenerates the reusable generated client package
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

Detailed UI and desktop rollout strategy lives in `prds/server-v2-plan/ui-migration.md`.

### Phase 0: Create the new server package and contract loop

- Create the new server package under `apps/server-v2/`.
- Add a minimal Hono app entrypoint.
- Add a minimal health or test route to prove the server boots and serves requests.
- Add OpenAPI generation for the new server, likely via `hono-openapi`.
- Add a generated TypeScript SDK package for the new server.
- Add an app-side `createSdk({ serverId })` adapter before migrating individual features.
- Document which desktop-owned capabilities must move behind the server over time.
- Define the first-run import path for existing app/orchestrator state that should move into the new server DB.

Success criteria:

- The new server boots independently.
- OpenAPI generation and SDK generation succeed locally.
- The app can target the new server through one adapter layer.

### Phase 0.5: Absorb existing local product state into the server DB

Before feature slices can fully move, the new server needs a clear story for taking over the durable state the app and orchestrator own today.

- import or normalize workspace records from current desktop state such as `openwork-workspaces.json`
- import remote workspace mappings and selected connection metadata into the server registry
- import or reconstruct cloud auth/session metadata into the server-owned sqlite model
- import or normalize orchestrator state snapshots that still matter for reconnect or migration
- make the migration idempotent so the server can retry safely on startup

Success criteria:

- the server can reconstruct its canonical sqlite state from current local product state without manual hand edits
- post-migration app startup reads server-owned workspace and connection state instead of rebuilding it locally
- migration failures are visible and recoverable instead of silently leaving split ownership behind

### Phase 1: Move low-risk read endpoints first

Start with read-only or low-risk endpoints so the migration path is proven before touching write flows.

- Implement new endpoints in Hono.
- Point a small, isolated desktop surface at the new server.
- Compare behavior against the existing implementation.

Success criteria:

- The desktop app can use at least one new-server endpoint in production-like flows.
- The app-side adapter can route that surface to the new server cleanly.

### Phase 2: Move mutations and workflow endpoints

Once the structure is stable, move write paths and workflow endpoints into the new server in slices.

- Port one capability area at a time.
- Keep domain behavior consistent while the transport layer changes.
- Avoid broad dual-write logic unless absolutely necessary.

Success criteria:

- End-to-end feature flows work through the new server for selected areas.
- The new server becomes credible as the real future server.

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

### Phase 4: Make the new server the default desktop runtime

- Switch desktop startup to launch the new server.
- Switch desktop API clients to use the new server by default.
- Monitor for gaps in auth, payload shape, and error handling.

Success criteria:

- New desktop traffic uses the new server by default.
- The old server is no longer on the critical path for normal desktop usage.

### Phase 5: Remove the old server and leftover orchestrator code

- Delete the old server implementation once all consumers are moved.
- Promote the new server package to be the only server implementation that matters.
- delete or absorb orchestrator code that only existed to provide a separate control plane or bootstrap layer

Success criteria:

- No active desktop path depends on the old server.
- All server behavior lives in the new server package.
- orchestrator is no longer needed as a separate product/runtime layer.

## Desktop App Requirements

To migrate safely, the desktop app should introduce a server-facing boundary before moving features.

The desired end state is not just route migration. It is responsibility migration.

The desktop app should become a thin client.

Requirements:

- one module owns server resolution from `serverId`
- features call typed operations, not literal URL paths
- route selection can happen per endpoint or per feature area while migration lasts
- the target server is selected explicitly by `serverId`, not hidden global state
- it is easy to see which calls have been moved to the new server
- the app only owns transient UI state, not durable workspace behavior
- the app can list known servers and the workspaces available within each server
- workspace reads, writes, AI actions, and config mutations should route through the server

Nice-to-have follow-ups:

- a feature flag or config switch for targeted rollout
- a capability probe so the app can detect new-server support from the server
- simple request logging that shows whether traffic used the current or new server during migration

### Client SDK model

The app may talk to multiple server destinations, but the preferred API is still one SDK entrypoint.

Examples:

- local desktop-hosted server
- remote worker-backed server
- hosted OpenWork Cloud server

Because of that, SDK creation may still take an explicit `serverId` during migration and server-management flows.

The key separation is:

- the SDK resolves which server to call from `serverId` when needed
- each operation receives the workspace ID to use on that server

That matters because one server can host many workspaces, and the system can know about many servers at once.

Example shape:

```ts
const sdk = createSdk({ serverId })

await sdk.sessions.list({ workspaceId })
await sdk.sessions.get({ workspaceId, sessionId })
await sdk.sessions.listMessages({ workspaceId, sessionId })
```

Illustrative app-side record while migration is in progress:

```ts
type WorkspaceRecord = {
  id: string
  serverTargetId: string
}
```

In the ideal model, the local OpenWork server owns the durable mapping between:

- OpenWork workspace ID
- remote OpenWork workspace ID
- OpenCode project ID
- backend server identity

The app should usually operate on stable OpenWork workspace IDs returned by the local server, not on remote backend IDs directly.

The generated SDK should stay transport-level and typed. The thin handwritten adapter should own:

- server target selection
- auth headers and tokens
- temporary old-server versus new-server decision-making during migration
- lightweight client preparation
- capability checks and fallbacks

It should not grow into a second workspace engine inside the app.

In the ideal steady state, normal product traffic should target the local OpenWork server as the canonical adapter and registry, while direct alternate `serverId` targeting is reserved for explicit server-management or migration/testing scenarios.

### SSE endpoint strategy

Most new-server endpoints should be standard request/response endpoints covered directly by the generated SDK.

For the likely one or two SSE endpoints:

- the OpenWork server should still be the only streaming surface the app talks to
- the SSE routes should still be documented in the new server contract
- event payloads should still be typed from generated or shared contract types, not imported directly from server source
- we may need a small handwritten streaming helper because most OpenAPI generators do not produce an ergonomic typed SSE client automatically

Goal:

- normal endpoints: fully generated TypeScript SDK methods
- SSE endpoints: small typed streaming helpers exposed from the same package so app usage still feels unified

## Architectural Principles

- **New code in new files**: treat the new server package as the replacement tree, not as an extension of legacy code.
- **New server first**: design the replacement as its own server, not as a mounted extension of the old one.
- **One slice at a time**: move vertical feature slices instead of mixing many partial migrations.
- **Explicit routing**: desktop traffic should move to the new server intentionally, not accidentally.
- **Server-owned workspace behavior**: file access, AI/runtime behavior, project/config mutation, and other workspace capabilities belong to the server, not the UI.
- **Thin desktop app**: the app should mainly launch/connect servers, hold local presentation state, and render server-backed workflows.
- **Delete as you go**: once a feature is fully on the new server, remove the corresponding legacy code instead of letting both versions linger.

## Risks

- The desktop app may have too many direct server path references, making migration noisy until a client boundary exists.
- The desktop app currently owns native and local behavior that should eventually move behind the server boundary.
- Shared auth/session/runtime behavior may be entangled with the old server boot path.
- Orchestrator responsibilities may be tightly coupled to host bootstrapping, making it harder to separate true bootstrap concerns from product control-plane concerns.
- Old-server and new-server payloads may drift if both are maintained for too long.

## Open Questions

- Which server surface is the best first slice to migrate as a proof point?
- Are there any external consumers besides the desktop app that must keep using the old server during the transition?
- At what point should desktop startup switch to the new server by default?
- What bootstrap responsibilities truly must remain outside the server process, if any, once orchestration is folded inward?

## Immediate Next Steps

1. Create `apps/server-v2/` as the new server package.
2. Add OpenAPI generation for the new Hono app.
3. Create a TypeScript SDK package generated from the new server OpenAPI spec.
4. Define the new server startup path the desktop app will eventually launch.
5. Add `createSdk({ serverId })` so the app resolves server config without passing raw URLs and tokens around.
6. Define the one or two SSE endpoints and their typed event payloads.
7. Inventory desktop-owned workspace capabilities and prioritize which ones move behind the server first.
8. Identify the first orchestrator-owned control-plane capability to fold into the main server.
9. Identify the first low-risk endpoint group to migrate.
10. Port the first feature slice end to end and use it as the template for the rest.

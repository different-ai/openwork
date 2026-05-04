# Server V2 UI Migration

## Status: Draft
## Date: 2026-04-14

## Purpose

This document defines how the app and desktop shell should migrate from the current mixed legacy call patterns to the new Server V2 SDK and startup model.

Current Phase 10 note:

- The migration rollout flag remains the practical opt-in switch while Server V2 is still being validated.
- Current app routing and desktop startup should continue to use the legacy path by default.
- Server V2 should be enabled explicitly with `OPENWORK_UI_USE_SERVER_V2=1` (or the Vite-exposed equivalent in the frontend build).

It focuses on one practical requirement:

- we need to move without breaking the current app
- we need a clean way to opt into the new server path
- we need to avoid sprinkling backend-selection logic across random UI call sites

## Core Idea

Yes, the overall migration approach makes sense.

The right shape is:

- Server V2 has its own generated SDK
- the current UI remains the default path at first
- a single rollout env var enables the new Server V2 path
- that same rollout decision also controls desktop startup so Tauri launches the new server instead of the old runtime stack
- during migration, each networked capability has two implementations behind one app-facing function:
  - current legacy path by default
  - new Server V2 path when the rollout flag is enabled

The important refinement is how much refactoring we require up front.

We should not block migration on first rewriting the whole UI behind one perfect adapter layer.

Instead, we should support incremental per-call-site branching with one shared rollout helper.

## Migration Goals

- keep the current product working while Server V2 is still incomplete
- let developers boot the whole app against Server V2 with one flag
- make it easy to port one feature slice at a time
- keep UI call sites stable while the transport and runtime ownership change underneath
- make it easy to delete legacy paths once a feature area is fully migrated

## One Logical Rollout Flag

Use one logical rollout flag for the migration.

Recommended behavior:

- flag off or unset: current app behavior and current desktop runtime startup
- flag on: app routes eligible calls through the new Server V2 adapter path, and desktop startup launches Server V2 instead of the old local stack

Example conceptual flag:

```text
OPENWORK_UI_USE_SERVER_V2=1
```

Current implementation note:

- legacy/default behavior should continue when the flag is unset
- Server V2 should only become the active app + desktop path when this flag is explicitly enabled
- do not remove this flag until the old path is intentionally retired

Implementation note:

- the frontend build may still need a platform-specific env bridge such as a Vite-exposed variable
- that should still be treated as one logical rollout flag, not as two separate product switches

## Main Rule: Use One Shared Flag Helper

The migration can look like this in many places during rollout:

```ts
const isServerV2 = checkServerFlag()

if (isServerV2) {
  // new server path
} else {
  // old path
}
```

That is acceptable for this migration.

Instead:

- use one shared helper such as `checkServerFlag()` or `isServerV2Enabled()`
- avoid reading raw env state differently in many places
- branch at the existing call site when that is the lowest-risk migration path
- only introduce a deeper adapter when it clearly reduces repeated migration logic

This keeps the migration practical without forcing a whole-app client refactor before the server migration can begin.

## Recommended Helper Shape

Recommended minimal shape:

```text
apps/app/src/app/kernel/server-version/
├── flag.ts                # shared UI-side rollout helper
├── sdk.ts                 # Server V2 client creation helpers
└── index.ts

apps/desktop/src-tauri/src/
└── openwork_server/
    └── startup_mode.rs    # desktop startup branch for old vs Server V2
```

Example UI-side helper shape:

```ts
export function checkServerFlag() {
  return import.meta.env.VITE_OPENWORK_UI_USE_SERVER_V2 === "1"
}
```

Example usage at an existing call site:

```ts
const isServerV2 = checkServerFlag()

if (isServerV2) {
  return createSdk({ serverId }).workspaces.list()
}

return listWorkspacesLegacy()
```

Example desktop-side shape:

```rust
if check_server_v2_flag() {
    start_server_v2(...)
} else {
    start_legacy_runtime(...)
}
```

Notes:

- exact filenames can change, but the flag helper should live in one obvious shell or kernel location
- the helper should return a boolean and hide platform-specific env lookup details
- Tauri should follow the same logical flag, even if its implementation reads that value through a different runtime or build-time path
- `createSdk({ serverId })` should sit near the same shell or kernel area so the new-server branch is easy to reuse

## Desired Layering

Recommended split:

- `packages/openwork-server-sdk`
  - generated SDK for Server V2 only
- `apps/app/.../checkServerFlag.ts` or equivalent
  - one shared helper for rollout checks
- `apps/app/.../createSdk.ts`
  - app-owned runtime adapter for places that do use Server V2 calls
- `apps/app/.../legacy/`
  - thin handwritten legacy fetch/client helpers for flows not yet migrated
- `apps/desktop/src-tauri/**`
  - startup and runtime wiring that chooses whether to launch the old stack or the new server

The stable rule is:

- generated SDK for new server
- one shared rollout helper for migration checks
- thin legacy shims for old server
- reuse existing call sites where that is cheaper than introducing a new abstraction first

## What Counts As A Migration Target

The UI currently reaches behavior through several kinds of call sites.

We should treat all of these as migration targets:

- direct fetches to current OpenWork server endpoints
- direct calls to handwritten server client helpers
- Tauri commands that really represent server or runtime capabilities
- startup and reconnect flows that assemble local runtime pieces in the desktop shell
- local config/file mutations that exist only because the server does not own that capability yet

In other words, the migration is not just about replacing `fetch()` calls.

It also includes shrinking Tauri-owned runtime orchestration and local workspace mutation paths.

It is fine if some migrated places switch to SDK calls while others still branch between raw endpoints, local files, or Tauri commands during the rollout period.

## Dual-Path Pattern Per Capability

For each capability being migrated, use the lightest-weight branch that gets the job done safely.

Sometimes that will be a stable exported domain function.

Sometimes that will simply be an existing function or store action updated to branch on the shared rollout helper.

Example shape:

```ts
const isServerV2 = checkServerFlag()

export async function listWorkspaceSessions(args: ListWorkspaceSessionsArgs) {
  if (isServerV2) {
    return createSdk({ serverId }).sessions.list({ workspaceId: args.workspaceId })
  }

  return listWorkspaceSessionsLegacy(args)
}
```

Rules:

- prefer a shared helper instead of repeated raw env lookups
- if the code already has a natural function boundary, branch there
- the Server V2 branch should use the generated SDK where possible
- the legacy branch should remain thin and isolated
- the function should normalize outputs so the rest of the UI sees one stable shape

This gives us one place to remove the legacy path later, without requiring that every feature be fully re-layered first.

## Startup Migration Pattern

The rollout flag should affect both app request routing and desktop startup.

### Flag Off

- keep the current startup graph
- keep the current app network and Tauri paths
- keep legacy behavior as the safe default

### Flag On

- desktop starts Server V2 instead of assembling the old local runtime stack
- app connects to Server V2 using the normal port and token model
- eligible app capability adapters call Server V2 through its SDK
- legacy fallbacks remain only for capability areas not yet ported

This matters because we do not just want a new SDK.

We want the app to experience the new ownership model end to end.

## App Adapter Strategy

The app-facing shape should stay consistent with the rest of the plan:

```ts
await createSdk({ serverId }).sessions.listMessages({ workspaceId, sessionId })
```

Recommended responsibilities for `createSdk({ serverId })` during migration:

- prepare the Server V2 SDK client for code paths that are on the new server
- create the Server V2 SDK client when that path is enabled
- hide base URL and token handling from feature code

It should not:

- expose raw `baseUrl` or `token` handling to domain code
- force the whole app to migrate behind one adapter before we can ship any Server V2 path

Important clarification:

- `createSdk({ serverId })` is for the new-server branch
- it does not need to absorb every legacy code path immediately
- some areas can branch locally and only use `createSdk({ serverId })` inside the Server V2 branch

## Desktop / Tauri Strategy

The same rollout decision should control desktop-native startup.

Recommended behavior:

- when the flag is off, the desktop shell uses the current startup path
- when the flag is on, the desktop shell launches Server V2 and connects the app to it

That means the desktop migration should be treated as part of the same UI migration, not as a separate unrelated effort.

Practical effect:

- the UI should not talk to a legacy startup stack while pretending it is on the new server model
- if the flag says Server V2, startup should align with that choice as much as possible

## Where To Put The Branches

Recommended branching layers:

### 1. Shell-level rollout resolver

- parse the env var once
- expose a small `checkServerFlag()` or equivalent helper

### 2. Desktop startup boundary

- choose old runtime startup versus Server V2 startup

### 3. Existing feature call sites or domain helpers

- choose legacy versus Server V2 implementation for each migrated capability
- use the shared rollout helper rather than ad hoc env parsing

### 4. Legacy compatibility helpers

- preserve old transport details in a quarantined area until they can be deleted

Not recommended:

- reading env vars directly in many different ways
- large pre-migration refactors whose only purpose is to create a perfect adapter layer
- mixing transport selection with rendering logic when a nearby helper or action can own the branch instead

## Migration Order

Recommended order:

### Phase 1: Introduce the rollout boundary

- add the logical rollout flag
- add one shared rollout resolver
- add desktop startup branching for old versus new server launch

Success criteria:

- one switch can boot the app in legacy mode or Server V2 mode
- migrated call sites can switch behavior using one shared helper without duplicating env parsing logic

### Phase 2: Wrap existing calls before porting behavior

- inventory current direct fetches, client helpers, and Tauri commands that represent server behavior
- add branches only where needed for the next migration slice
- keep behavior unchanged at first unless the branch is explicitly being ported

Success criteria:

- the next feature slice can migrate without a large unrelated app refactor
- rollout logic is centralized in a shared helper even if branching still happens in many places

### Phase 3: Port read paths first

- move status, discovery, workspace list, session list, and similar read-heavy surfaces first
- use the generated Server V2 SDK for the new path
- keep legacy fallback until confidence is high

Success criteria:

- the app can render selected surfaces fully from Server V2 with the flag enabled

### Phase 4: Port write and workflow paths

- move mutations, workspace creation flows, config mutation, share/import/export flows, and runtime control flows in slices
- keep transport normalization as close to the migration branch as practical

Success criteria:

- whole workflows succeed in Server V2 mode without Tauri-only fallback paths for the migrated areas

### Phase 5: Flip the default

- once the new path is credible, make Server V2 the default
- keep a temporary escape hatch for the old path only if needed for rollback

### Phase 6: Delete legacy paths

- remove legacy helper modules
- remove old startup branching
- remove the rollout flag once it is no longer needed

## Normalization Rule

During migration, old and new backends may not return identical shapes at first.

The UI should not absorb those differences directly.

Instead:

- normalize old and new responses inside the adapter layer
- return one stable shape to the rest of the UI
- keep temporary compatibility code close to the transport boundary

This is especially important for:

- workspace summaries
- session list/detail payloads
- runtime status and health payloads
- settings and config mutation responses

## What Should Stay Local In The UI

The migration does not mean everything moves out of the app.

These should still stay UI-local:

- modal state
- routing and presentation state
- draft text and transient form state
- attachment preprocessing before upload
- client-only search, scrolling, and render performance logic
- clipboard and opener helpers

The migration target is server and runtime ownership, not the removal of normal UI state.

## Guardrails

- default to legacy behavior until a feature slice is proven
- use one shared rollout helper for all migration checks
- never require feature code to pass around raw server URLs and tokens
- do not dual-write unless there is no safer option
- keep the legacy path isolated and deletable
- prefer deleting a migrated legacy branch quickly instead of letting both paths fossilize
- do not treat Tauri-only filesystem mutation as a permanent parallel capability set

## Relationship To Other Docs

- `prds/server-v2-plan/plan.md`
  - overall server migration phases
- `prds/server-v2-plan/sdk-generation.md`
  - generated SDK plus legacy compatibility split
- `prds/server-v2-plan/app-audit.md`
  - UI-owned areas and migration targets inside the app
- `prds/server-v2-plan/tauri-audit.md`
  - desktop-native startup and runtime responsibilities that should shrink over time

## Decision Summary

The migration model should be:

- one logical env var controls whether the app is in legacy mode or Server V2 mode
- that same rollout decision affects both UI network routing and desktop startup
- the new server uses its own generated SDK
- each migrated area can branch locally using one shared rollout helper
- `createSdk({ serverId })` powers the Server V2 path without requiring a whole-app adapter refactor first

That is the safest way to migrate the UI incrementally without locking the app into a permanent dual-architecture mess.

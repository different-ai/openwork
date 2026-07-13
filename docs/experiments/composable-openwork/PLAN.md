# Staged redesign plan

This is the ambitious target for the experimental branch. Stages remain
independently revertible and are promoted only when their proof gate passes.

## Stage 0 — Evidence and guardrails

Deliverables:

- pinned package/composition/coupling baseline;
- product-owned architecture snapshot command;
- feature and proof inventory;
- stale-code ledger with confidence and deletion conditions;
- draft PR opened before runtime behavior changes.

Exit: the baseline commands pass and the PR explains scope, non-goals, and the
next reversible slice.

## Stage 1 — Cleanup reliability

Make the unused-file audit portable and deterministic. Repair stale scripts and
documentation separately from architecture work. Delete only high-confidence,
zero-consumer code after app build and core-flow proof.

Initial candidates are in [STALE-CODE-LEDGER.md](./STALE-CODE-LEDGER.md).

Exit: the audit runs on macOS and Linux; each deletion has reachability,
packaging, test, and rollback evidence.

## Stage 2 — Canonical extension contracts

Create a browser-safe `@openwork/extension-contracts` package that owns:

- a versioned, Zod-validated descriptor and manifest vocabulary;
- stable IDs, source/provenance, resources, contributions, enablement, and
  lifecycle metadata;
- normalized validation errors and compatibility fixtures;
- no React, filesystem, process, database, environment, Den, or vendor SDK
  dependencies.

Adapt the app and Den to the canonical schema before deleting either legacy
definition. Keep the package internal/experimental; do not imply a stable public
SDK.

Exit: app and Den fixtures round-trip through one schema, old persisted/remote
payloads remain readable, duplicate built-in metadata has a named removal path,
and a packed temporary consumer resolves the exported API.

## Stage 3 — Registration kernel and test kit

Create the smallest neutral registration primitive justified by at least two
real surface families. It owns identity/version/provenance validation,
duplicate rejection, deterministic ordering, requirement checks, freeze-after-
assembly, and diagnostics. It does not own application services or business
state.

Realm-specific contribution contracts remain beside their hosts. A test kit
proves duplicate, incompatible, missing dependency, ordering, unknown,
disabled, construction failure, and disposal behavior.

Exit: one real app contribution and one real server contribution use the same
base invariants without sharing runtime-specific interfaces.

## Stage 4 — Server extension actions vertical slice

Replace `OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS` and feature-specific dispatch
branches with explicit action contributions assembled in one server composition
module. Each feature exports descriptors and an executor factory that receives
only its required ports. Request parsing, Connect gating, authentication, error
codes, and response shapes remain unchanged.

First contributions: Google Workspace and OpenAI image generation. The legacy
entry functions become an adapter until both action suites and the OpenCode
preview consumer prove parity.

Exit: a fake action can be assembled without editing dispatch; duplicate/action
conflict and unknown/unavailable behavior are tested; existing server tests and
real route smoke pass.

## Stage 5 — Explicit app settings composition

Replace six import-time registration modules with exported contribution
factories and a searchable app composition root. Preserve the current settings
controller and UI while splitting its broad optional context into surface- or
feature-specific host ports incrementally.

Move one built-in manifest through the canonical loader and contribution path.
Keep existing IDs and deep links. No UI redesign belongs in this slice.

Exit: removing that contribution from the assembly list leaves the app bootable
with a clear unavailable state; adding a fake settings contribution touches one
assembly list; app typecheck/tests and the matching fraimz flow pass.

## Stage 6 — Manifest ownership convergence

Make app, local server, and Den projections consume the canonical descriptor.
Replace name/description identity matching with immutable IDs. Deduplicate
built-in definitions and extension translation logic only after compatibility
fixtures prove old remote payloads.

Exit: one source of truth for built-in metadata, one validation contract across
realms, no opaque contribution/resource blobs at the boundary, and no feature
inventory regression.

## Stage 7 — Engine event and error boundary

Define OpenWork-owned session/message/part/permission/question/todo/event DTOs,
a normalized event envelope, and stable errors. Implement an OpenCode adapter;
migrate one session consumer at a time. Keep process supervision separate from
the session data plane.

Exit: no raw engine event types in the migrated session path, disconnect/replay
and unknown-event behavior are characterized, and adapter conformance runs on
the pinned engine.

## Stage 8 — Server and client capability packages

Move inline server route families behind explicit registrar contributions with
narrow dependency ports. Generate or derive a typed client from owned schemas
instead of maintaining hand-written 1k+ line clients. Start with workspace/MCP
routes; leave auth and approval policy at host dispatch.

Exit: server composition contains assembly rather than feature behavior, route
and auth snapshots remain stable, and app/server smoke passes.

## Stage 9 — Desktop and host-runtime composition

Split the typed desktop command map into feature handler bundles while
preserving the shared IPC contract. Extract duplicated process/env/sidecar/path
behavior from desktop and orchestrator behind platform adapters with explicit
port, health, log, restart, and disposal ownership.

Exit: IPC snapshot unchanged, handler bundles reject duplicates, packaged
desktop contains required assets, and start/health/stop/restart smoke passes.

## Stage 10 — Den capability and cloud domains

Define a Den `CapabilitySource` contract around discovery and execution while
keeping tenant, admin/member, shared/per-member credential, SSRF, and audit
authority in Den. Migrate native providers and external MCP as two real
implementations. Then extract cloud domains one at a time behind schema,
persistence, route, and UI adapters.

Exit: adding a source requires one Den assembly registration, credential modes
remain distinct, and focused Den plus desktop consumer flows pass.

## Stage 11 — Presentation convergence and final prune

Consolidate duplicated Markdown/translation pipelines behind coherent packages,
not generic utility dumps. Run reachability, export, dependency, binary,
Electron, container, installer, and docs audits. Remove compatibility adapters
only when their counters and consumers are zero.

Exit: current feature inventory is intact; all supported builds and end-to-end
flows pass; every removed file/dependency is in the ledger; before/after metrics
and remaining exceptions are published in the PR.

## Branch completion gate

The experimental branch is considered end-to-end working only after:

- all new packages typecheck, test, build, and resolve from a packed consumer;
- app, server, desktop bridge, and affected Den checks pass;
- the canonical core fraimz flow produces `fraimz.html` with observable
  assertions;
- no new secret, generated proof artifact, local state, or credential is tracked;
- the PR stage report includes exact commands, results, before/after metrics,
  rollback points, and unresolved architectural questions.

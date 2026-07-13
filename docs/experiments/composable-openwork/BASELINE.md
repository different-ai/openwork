# Baseline

Measured from `different-ai/openwork@316b996ca45de0bc03f2c4880417f195eb71be7d`
on 2026-07-13 before experiment changes.

The product-owned snapshot is repeatable with:

```bash
pnpm architecture:snapshot
```

It reports the package graph, implementation/test size, composition hotspots,
registration mechanisms, selected vendor coupling, app layering violations, and
tracked stale candidates as JSON. Broader engine-coupling numbers below come
from the hub's dedicated OpenCode coupling snapshot and are kept separate.

## Repository shape

| Signal | Baseline |
| --- | ---: |
| Workspace packages | 24 |
| Internal workspace dependency edges | 25 |
| Production implementation files | 1,025 |
| Production implementation LOC | 265,409 |
| Test files | 248 |
| Test LOC | 40,517 |
| Implementation files over 500 LOC | 133 |
| Implementation files over 1,000 LOC | 55 |
| Implementation files over 2,000 LOC | 11 |
| Implementation files over 3,000 LOC | 4 |
| Fraimz flow files | 134 |
| Desktop IPC commands | 81 |

Largest composition and behavior hotspots:

| Owner | LOC at baseline |
| --- | ---: |
| `apps/orchestrator/src/cli.ts` | 7,276 |
| `ee/apps/den-api/src/routes/org/plugin-system/store.ts` | 5,584 |
| `apps/server/src/server.ts` | 3,255 |
| `apps/app/src/react-app/domains/settings/state/extensions-store.ts` | 3,006 |
| `apps/app/src/react-app/shell/settings-route.tsx` | 2,499 |
| `apps/app/src/react-app/shell/session-route.tsx` | 2,347 |
| `apps/desktop/electron/main.mjs` | 2,316 |

File size is not itself a reason to create a package. These numbers identify
where construction, policy, dispatch, and behavior need to be traced before a
seam is proposed.

## Coupling baseline

| Signal | Baseline |
| --- | ---: |
| Direct `@opencode-ai` import sites / files | 34 / 33 |
| Direct production OpenCode SDK import sites / files | 30 / 29 |
| Ad-hoc engine event variants interpreted | 25 |
| Raw engine wire endpoint sites | 69 |
| Engine database coupling sites | 39 |
| Engine injection sites | 65 |
| Engine binary/path convention sites | 40 |
| Engine-related environment keys | 61 |
| Candidate engine SDK methods used | 42 |
| Direct production files importing the MCP SDK | 14 |
| App `domains -> shell` static-import edges | 35 |
| Approximate app static-import cycles | 2 cycles / 6 files |

The extension-platform draft was pinned to `e93df751`. Since then direct vendor
imports stayed flat while raw wire sites grew from 52 to 69 and engine-related
environment keys grew from 56 to 61. Decoupling pressure increased.

## Existing seams worth preserving

- Server route descriptors retain method, path, auth mode, and handler in
  `apps/server/src/routes/registry.ts`.
- Desktop IPC has a useful producer/handler/invoker type tripwire in
  `packages/types/src/desktop-ipc.ts`, Electron, and the app bridge.
- Den route groups are registered explicitly from the Den application root.
- App settings and control actions already prove that runtime registration can
  work, but settings currently rely on import-time mutation.
- The enterprise MCP package proves required-port injection, stable errors,
  lifecycle deadlines, diagnostics isolation, adapter-owned tenant/persistence
  policy, and startup-selected strangler rollout.

## Corrections to the draft extension-platform plan

- The plan is `drafting`, not adopted architecture; its contract examples are
  sketches, not product specifications.
- A manifest schema does exist in Den and the app has a separate runtime parser.
  The actual defect is duplicate, incomplete contract ownership: Den treats
  resources/contributions as opaque JSON while the app owns a separate TS shape
  and manual parser.
- Built-in extension metadata is duplicated between the app and Den. Den also
  identifies some built-ins by mutable `name + description`, and its catalog is
  already missing the app's Voice entry.
- `@openwork/enterprise-mcp-client` is host-neutral but not protocol-neutral:
  its public API exposes MCP SDK OAuth, tool, and call-result types. New
  platform-facing contracts must use OpenWork-owned values.
- Its credential revision is described as compare-and-swap state but is not
  supplied to credential save. Declared contract semantics need conformance
  tests; documentation alone is not enforcement.
- Declared MCP request/error variants currently have no producer. The experiment
  therefore treats contract liveness and supported API surface as measurable
  cleanup concerns.

## Baseline proof

All commands ran through the isolated `registration-first/composable-openwork`
hub environment.

| Proof | Result |
| --- | --- |
| App TypeScript check (`pnpm typecheck`) | Passed |
| Enterprise MCP client test suite | 23 passed, 0 failed |
| Server extension gating + Google Workspace tests | 21 passed, 0 failed |
| App extension projection + settings-route tests | 6 passed, 0 failed |

The repository's existing unused-file wrapper found 335 raw Knip candidates but
failed before classification because it requires Bash associative arrays and
macOS ships Bash 3.2. Raw Knip output is not deletion evidence. Making this
audit portable is an early cleanup slice.

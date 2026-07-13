# Experiment results

Status: end-to-end working experiment; proposed architecture, not adopted platform

Feature implementation proof head: `f230d0f3221bcc5f3391a4ac38621c742866e972`

Snapshot hardening head: `7fe6e298`

Installed-package proof head: `7481287e`

Packaged embedded-server proof head: `9c62db87`

Completed: 2026-07-13

## Verdict

No regression was detected in the pinned feature inventories, focused and full
suites, packaging checks, and four observed product flows while selected seams
moved construction, discovery, validation, and lifecycle ownership into
explicit contracts and realm-local composition roots. This supports the central
hypothesis without claiming exhaustive parity for every feature. The result is
not a universal plugin runtime. It is a smaller and safer pattern:

1. OpenWork-owned, browser-safe data contracts cross realm boundaries.
2. A neutral registration kernel enforces identity, ordering, requirements,
   freeze-after-assembly, and diagnostics.
3. App, server, desktop, and Den own separate executable contribution types and
   assemble only the implementations trusted in that realm.
4. Vendor, persistence, process, authentication, approval, tenant, secret, and
   network policy stay in host adapters.
5. Compatibility paths remain explicit and tested until their consumers are
   gone.

This branch is suitable as a design and migration reference. It should not be
merged wholesale without splitting the proven slices into reviewable adoption
PRs, resolving the release-version caveat, and deciding which partial stages
the product wants to finish.

## What now has an obvious owner

| Boundary | Contract owner | Explicit composition point |
| --- | --- | --- |
| Extension descriptors and manifests | `@openwork/extension-contracts` | App and Den adapters validate the same versioned schema |
| Built-in extension identity and metadata | `@openwork/extension-catalog` | App catalog projection and Den marketplace projection |
| Contribution invariants | `@openwork/contribution-registry` | Realm-local registries; no global service locator or import-time registration |
| App settings surfaces | App-owned settings contribution factories | `settings-extension-composition.ts` |
| Server extension actions | Server-owned action contributions and required ports | `extensions/composition.ts` |
| Server route families | Server-owned route-family contributions | `routes/family-composition.ts` |
| Desktop commands | Desktop-owned IPC handler bundles | `electron/ipc-composition.mjs` |
| Den MCP capability discovery/execution | Den-owned `CapabilitySource` implementations | `mcp/capability-source-composition.ts` |
| Session reads, events, and stable errors | `@openwork/session-contracts` plus the OpenCode adapter | Server session routes and the app session client |
| Markdown parsing/highlighting policy | App rendering kernel | Browser and session-surface adapters |

The canonical session event endpoint is additive. The app prefers it and falls
back to the legacy engine stream only when an older server reports
`404`, `405`, or `501`. The contract normalizes session update and failure
events, carries the 18 compatibility event variants required by current
consumers, bounds unknown-event diagnostics, and cancels malformed streams. It
does not claim replay or resumability.

The final composed inventories contain 121 authenticated/public route
descriptors, 16 extension actions, 40 inbound desktop IPC channels, and 53
renderer bridge methods.

## Stage verdicts

| Stage | Verdict | Result |
| --- | --- | --- |
| 0. Evidence and guardrails | complete | Pinned baseline, repeatable architecture snapshot, proof inventory, stale ledger, and draft PR |
| 1. Cleanup reliability | complete | Portable Bash 3.2-compatible audit with entrypoint/convention classification and deletion gates |
| 2. Canonical extension contracts | complete | Versioned schemas, stable validation errors, compatibility fixtures, app/Den consumers, packed consumer proof |
| 3. Registration kernel | complete | Deterministic, duplicate-safe, requirement-aware, frozen registries used by multiple realm-specific surfaces |
| 4. Server extension actions | complete | Google Workspace and image generation register through action contracts with preserved gating and response shapes |
| 5. App settings composition | complete assembly slice | Six settings integrations changed from import-time mutation to explicit assembly while preserving IDs and deep links; per-feature host-port narrowing is deferred |
| 6. Manifest convergence | complete for built-ins | One built-in catalog feeds app and Den projections with immutable IDs; remaining third-party compatibility translations stay at adapters |
| 7. Engine event/error boundary | partial, working slice | Owned read DTOs, stable errors, canonical SSE, OpenCode adapter, app migration, and compatibility fallback; replay and remaining raw engine consumers are deferred |
| 8. Server/client capability packages | partial, working slice | Route families are registered explicitly and session calls use owned schemas; the broad hand-written app client is not yet generated or fully split |
| 9. Desktop/host runtime | partial, working slice | IPC handler bundles and packaged embedded-server lifecycle proof are complete; a universal process package was deliberately rejected pending sidecar characterization |
| 10. Den capability/cloud domains | partial, working slice | Native and external MCP sources implement one Den-owned contract; unrelated cloud domains were not extracted |
| 11. Presentation convergence/prune | complete for selected paths | Active Markdown pipelines share one kernel; six unreachable source islands and seven direct dependencies were removed with proof |

## Repository measurements

The final snapshot enumerates tracked plus non-ignored in-progress repository
inputs. A packaging run exposed that the original filesystem walk counted 311
copied implementation files and 30,513 copied lines inside ignored
`dist-electron` output. Commit `7fe6e298` fixes that defect with a regression
fixture covering ignored output, non-ignored untracked work, and deleted tracked
files. The numbers below are the corrected source measurements.

Growth reflects four contract packages, adapters, and characterization tests;
it is not presented as a smaller total repository. The cleanup claim is instead
the independently evidenced removal of unreachable source and dependencies.

| Signal | Baseline | Experiment | Change |
| --- | ---: | ---: | ---: |
| Workspace packages | 24 | 28 | +4 |
| Internal workspace dependency edges | 25 | 37 | +12 explicit edges |
| Production implementation files | 1,025 | 1,049 | +24 |
| Production implementation LOC | 265,409 | 266,743 | +1,334 |
| Test files | 248 | 271 | +23 |
| Test LOC | 40,517 | 44,583 | +4,066 |
| Files over 500 LOC | 133 | 132 | -1 |
| Files over 1,000 LOC | 55 | 55 | 0 |
| Files over 2,000 LOC | 11 | 10 | -1 |
| Files over 3,000 LOC | 4 | 4 | 0 |
| Fraimz flow files | 134 | 134 | 0 |
| Direct production OpenCode SDK import sites | 30 | 25 | -5 |
| App domain-to-shell static edges | 35 | 34 | -1 |

The branch diff through the implementation proof head is 148 files,
12,968 insertions, and 7,498 deletions. Six unreachable source islands removed
2,740 source lines:

| Removed owner | Source lines |
| --- | ---: |
| Unmounted global SDK/sync providers | 617 |
| Broken Den developer launchers | 140 |
| Orphan Markdown/CodeBlock pair | 213 |
| Orphan session action provider/store | 955 |
| Detached settings config view | 619 |
| Superseded desktop engine launchers | 196 |

Seven unused app dependency declarations were also removed. Lock regeneration
removed 217 packages from the installed graph. Active code was consolidated
separately: the two reachable Markdown renderers now delegate parsing, link
policy, and render sequencing to one tested kernel with browser-owned sanitizer
and highlighter ports.

## Final proof matrix

All product commands ran through the isolated hub environment. Generated build,
package, runtime-state, and Fraimz artifacts remain ignored.

| Realm | Proof | Result |
| --- | --- | --- |
| Contract packages | Tests | 39 passed: extension contracts 15, registry 12, catalog 3, session contracts 9 |
| Contract packages | Typecheck/build/exports | All four passed typecheck and build; packed consumer checks resolved public exports |
| App | Full tests | 196 passed, 0 failed; 527 assertions across 42 files |
| App | Typecheck and production builds | Typecheck, desktop renderer build, and web build passed; 4,106 modules transformed |
| Server | Full tests | 324 passed, 2 skipped; 1,197 assertions across 326 tests and 57 files |
| Server | Typecheck/build | Passed |
| Desktop | Tests and bridge | 56 passed, 1 skipped; Electron typecheck passed; 53 renderer bridge methods verified |
| Desktop | Directory package | macOS arm64 Electron bundle produced with renderer, embedded server, OpenCode sidecar, and native computer-use helper |
| Server distribution | Cross-platform compile/package | Six Bun targets compiled; seven npm tarballs verified, including wrapper, metadata, workflow, health, auth, and SQLite runtime checks |
| Den | Affected tests | 25 passed, 0 failed; 88 assertions across 4 files |
| Den | Typecheck/build | Passed, including composition-package prerequisites |
| Orchestrator | Typecheck/build | Passed |
| Audit | Portability fixture | Passed under macOS Bash 3.2.57 and Linux/musl Bash 5.3.9 (aarch64) |
| Architecture | Snapshot | 28 workspaces, 37 internal edges, 1,049 implementation files, 266,743 implementation LOC, 134 Fraimz flows |
| Architecture | Snapshot regression | Ignored package output excluded; non-ignored untracked inputs counted; deleted tracked inputs tolerated |

### Exact final commands

Commands below were run from the hub root by replacing `<command>` in:

```bash
./bin/openwork-hub run registration-first composable-openwork -- <command>
```

The repeatable proof set is:

```bash
pnpm experiment:composable:packages
pnpm architecture:snapshot:test
pnpm architecture:snapshot

env -u OPENWORK_DATA_DIR -u OPENWORK_TOKEN_STORE -u OPENWORK_RUNTIME_DB pnpm --filter openwork-server test
pnpm --filter openwork-server typecheck
pnpm --filter openwork-server build

pnpm --filter @openwork/app test
pnpm --filter @openwork/app typecheck
pnpm --filter @openwork/app build
pnpm --filter @openwork/app build:web

pnpm --filter @openwork/desktop test
pnpm --filter @openwork/desktop typecheck:electron
pnpm --filter @openwork/desktop check:electron
pnpm --filter @openwork/desktop package:electron:dir

pnpm --filter @openwork-ee/den-api exec bun test test/extension-manifest-contract.test.ts test/mcp-agent-timeouts.test.ts test/mcp-capability-source-composition.test.ts test/openwork-extension-seed-identity.test.ts
pnpm --filter @openwork-ee/den-api exec tsc --noEmit
pnpm --filter @openwork-ee/den-api build
pnpm --filter openwork-orchestrator typecheck
pnpm --filter openwork-orchestrator build

bash scripts/find-unused.test.sh
docker run --rm --entrypoint sh -v "$PWD:/repo:ro" -w /repo alpine/git:latest -lc 'apk add --no-cache bash >/dev/null && bash scripts/find-unused.test.sh'

pnpm fraimz --flow core-flow
pnpm fraimz --flow bare-settings-route-redirect
pnpm fraimz --flow share-diagnostics
pnpm fraimz --flow artifact-markdown-render
```

The server distribution proof used Bun 1.3.10 first on `PATH`:

```bash
pnpm --filter openwork-server build:bin:all
node apps/server/scripts/publish-npm.mjs --dry-run
```

After `package:electron:dir`, the direct-ASAR lifecycle proof was:

```bash
env ELECTRON_RUN_AS_NODE=1 apps/desktop/dist-electron/mac-arm64/OpenWork.app/Contents/MacOS/OpenWork apps/desktop/scripts/verify-packaged-embedded-server.mjs --asar apps/desktop/dist-electron/mac-arm64/OpenWork.app/Contents/Resources/app.asar
```

The packaged desktop proof used the actual packaged Electron runtime (Electron
35.7.5 / Node 22.16.0) to import the server directly from `app.asar`, started it
with isolated state, received health plus the expected authenticated workspace,
stopped it, restarted it on the same port, received health again, and stopped it
cleanly. This lifecycle check used `manageOpencode: false`; packaging includes
the OpenCode sidecar, but this proof does not claim managed-engine, GUI, or
non-macOS runtime coverage. Local code signing and notarization were
intentionally skipped because no signing identity or notarization credentials
were available.

The observable product proofs were also green:

| Fraimz flow | Result ID | Observable assertion |
| --- | --- | --- |
| Canonical core flow | `2026-07-13T12-12-43-784Z` | Workspace/session creation, response, reload, and exact persisted session identity |
| Bare settings | `2026-07-13T12-15-49-318Z` | Settings remains reachable through explicit settings composition |
| Share diagnostics | `2026-07-13T12-15-56-090Z` | Existing share/diagnostic surface remains intact |
| Artifact Markdown | `2026-07-13T12-16-07-521Z` | Consolidated Markdown path still renders the artifact behavior |

## Compatibility and trust posture

- On the migrated paths, characterization tests preserve existing route paths,
  request/response shapes, auth checks, Connect gating, settings IDs, deep
  links, desktop IPC types, persistence behavior, and Den credential modes.
  The pinned inventories, suites, and observed flows found no regression; this
  is not an exhaustive compatibility certification.
- Executable factories are never accepted from an untrusted manifest.
  Descriptors are data; trusted hosts bind implementations explicitly.
- There is no process-wide service locator, import-time global registration,
  arbitrary third-party code loading, sandbox promise, or public SDK stability
  claim.
- Den retains tenant, membership, credential, SSRF, and audit authority.
- Desktop retains filesystem, process, update, and IPC authority.
- Server retains authentication, approval, persistence, and engine-adapter
  authority.

## Known exceptions and unresolved questions

1. **Den whole-tree test discovery is not a release gate today.** A raw
   `bun test` discovers 733 tests: 636 pass and 97 fail in both normal and serial
   runs. The failures include hard-coded absent databases, global mock and
   environment contamination, a fixed port that conflicts with the isolated
   hub, and stale mocks. Tests that fail only in the combined run pass in
   isolation, including the six org-capability tests. The affected Den suite,
   typecheck, and build are green; fixing the global harness is separate work.
2. **Session events do not replay.** Snapshot reads remain authoritative. Source
   event IDs are stable within a subscription, but reconnect/resume semantics
   need an explicit product contract before the legacy event path can disappear.
3. **Process ownership still needs a focused design.** The active path is
   desktop `engineStart` to embedded server to managed OpenCode server. Known
   issues include a possible child leak on readiness failure, unbounded captured
   output, a CLI signal close that is not awaited, a desktop child snapshot
   mismatch, duplicated environment construction/global mutation, and the
   port-check/bind race. The next extraction should be a small `OwnedSidecar`
   contract after characterization, not a universal process abstraction.
4. **The broad app/server client is still hand-written.** Its main implementation
   remains 1,931 lines. The experiment proves owned schemas and a canonical
   session vertical slice, not full client generation.
5. **Settings factories still receive one broad optional context bag.** Explicit
   assembly, omission, IDs, and lifecycle are proven, but the six factories
   still share `ExtensionConfigContext`. Per-feature required host ports are the
   next narrowing step toward the enterprise MCP pattern.
6. **OpenCode coupling remains material.** Five direct production SDK sites were
   removed, but raw engine consumers outside the migrated session path remain.
7. **Release versioning must be resolved.** The new seven-package server shape
   verifies locally at `0.17.20`, but npm versions are immutable. A real publish
   must use a new server version if `0.17.20` already exists with the previous
   metadata.
8. **Local release proof is unsigned.** The directory package is runnable proof,
   not a signed/notarized distribution artifact.
9. **Current-head CI is path-filtered.** The last product-source commit,
   `d9232260`, passed the GitHub product workflows. Later commits contain eval,
   architecture-proof, and documentation changes, so those product matrices did
   not rerun. Current-head Vercel contexts report that the Git author is not
   authorized for the app, Den, and worker projects; landing and preview-comment
   contexts are green.
10. **A pre-existing post-reload UI race remains visible.** Snapshot inspection
   confirms the session is idle with two messages, but `Thinking`/`Stop` can
   briefly remain after response or reload. The baseline flow exhibited the
   same behavior; it is not evidence of event replay.
11. **The orchestrator file integration harness remains broken.** Its Bun launch
    cannot currently resolve the server's dynamic `node:sqlite` import. The
    orchestrator typecheck and build pass; the stale root alias was removed
    instead of disguising this independent harness defect.

## Adoption sequence recommended by the experiment

1. Land the portable audit and evidence-only stale removals independently.
2. Adopt extension contracts, catalog, and registration invariants as internal
   packages, then migrate one realm-owned contribution family per PR.
3. Adopt action, route-family, settings, IPC, and Den source composition roots
   without creating a universal executable extension interface.
4. Productize session contracts only after specifying replay/reconnect and
   finishing the remaining raw-engine consumer inventory.
5. Characterize process lifecycle failure modes, then introduce the smallest
   `OwnedSidecar` contract shared by two proven hosts.
6. Generate client surfaces from owned schemas one route family at a time.
7. Repair the Den and orchestrator integration harnesses before treating broad
   discovery commands as merge gates.
8. Add architecture-budget checks for vendor imports, domain-to-shell edges,
   composition-root reachability, duplicate IDs, and package export integrity.

Each coherent slice is independently revertible, but later consumers depend on
earlier contract-package slices. The safest rollback is to revert dependent
slices in reverse order; additive adapters and the app's canonical-event
fallback preserve the preceding behavior while a slice is removed.

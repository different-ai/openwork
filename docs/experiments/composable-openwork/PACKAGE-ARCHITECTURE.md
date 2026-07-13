# OpenWork package architecture

Status: experimental constitution; not an adopted public SDK or release plan
Evidence snapshot: `experiment/composable-openwork@5e4ef7d0a18bd660b4a5a6d5ad924919e7af2dfc`
Measured: 2026-07-13

## Purpose

The extension experiment proved one useful construction pattern, but extension
registration is only one part of the opportunity. The larger goal is to see
OpenWork as a set of coherent capabilities that work together through explicit
contracts: reusable product policy, portable domain behavior, browser and
server libraries, presentation surfaces, platform adapters, and thin hosts.

This document is the package constitution for that experiment. It asks every
candidate boundary to answer five questions:

1. What product value does this package own?
2. In which runtime realms can that value execute?
3. What is its complete public contract, including UI, CSS, assets, errors, and
   lifecycle rather than TypeScript types alone?
4. Which authority stays with the consuming host, and through which ports does
   the package request it?
5. Can the package be built, tested, packed, understood, replaced, and removed
   independently?

The target is open-source-quality modularity, not a larger collection of
workspace folders. A package is successful when it captures a cohesive piece of
OpenWork value with a smaller and more stable interface than the code it
replaces. Code that is only meaningful inside one host remains local to that
host.

## Constitution

The following rules are hard constraints for new package work:

- A package owns one named capability or contract. `utils`, `common`, `shared`,
  and layer names without a product purpose are not acceptable package
  boundaries.
- Dependency direction points from hosts and platform details toward portable
  policy. A package must never import a host, its stores, routes, composition
  root, environment parsing, database rows, or private source paths.
- Public entrypoints are allowlists. Consumers import only paths declared in
  `exports`; cross-workspace relative imports and package deep imports are
  forbidden.
- Ambient authority is not an API. Network, filesystem, process, secret,
  persistence, authentication, approval, tenancy, clock, randomness, and user
  interaction dependencies are either absent or represented by narrow ports.
- Serializable data contracts and executable bindings remain separate.
  Descriptors may cross realms; trusted code is selected by the composition
  root in each realm.
- Construction is explicit. Packages do not self-register, inspect process-wide
  containers, or mutate singleton registries when imported.
- Compatibility belongs at an edge. Vendor types, old wire shapes, stored
  schemas, and legacy IDs are translated by named adapters rather than leaked
  into the portable contract.
- A package move is not complete while duplicate ownership remains. The old
  implementation becomes a temporary compatibility adapter with a deletion
  condition, or it is removed in the same proven slice.
- Every package declares its realm, authority, side effects, entrypoint purpose,
  maturity, and publication intent in machine-readable metadata.
- Every exported behavior is proven from a packed consumer, not only through
  monorepo source resolution.

## Package taxonomy

Every governed package has exactly one primary kind. A package may contain
internal layers, but its public purpose must fit one row.

| Kind | Owns | May depend on | Must not own |
| --- | --- | --- | --- |
| `contract` | Serializable schemas, stable value types, identifiers, errors, compatibility fixtures | Other lower-level contracts and narrowly justified validation libraries | I/O, framework state, vendor runtime types, host policy, executable registration |
| `kernel` | Small, reusable mechanisms and invariants such as deterministic registration, lifecycle, or orchestration primitives | Contracts and environment-neutral libraries | Product feature policy, ambient authority, host lookup, unrelated helpers |
| `domain` | Cohesive OpenWork behavior and policy that has value independent of a host | Contracts, kernels, and injected ports | HTTP routing, React, database rows, environment variables, platform SDK ownership |
| `adapter` | Translation between one explicit platform/vendor boundary and OpenWork-owned contracts | Contracts, kernels, domains, and the named external SDK | Cross-feature policy, hidden fallback authority, host composition |
| `presentation` | Headless UI behavior, renderers, components, hooks, styles, assets, and accessibility contracts | Contracts, kernels, domains, framework peer dependencies | App router/store ownership, server transport policy, secrets, filesystem/process authority |
| `host` | Realm startup, composition, authorization, approval, deployment policy, persistence selection, and executable assembly | All inward package kinds | Pretending host-only behavior is a reusable public API |
| `tool` | CLIs, build/release utilities, mocks, conformance kits, fixtures, and developer workflows | Public package entrypoints and explicitly scoped tooling libraries | Production authority, imports of host-private implementation, silent mutation of product state |

`kernel` is deliberately narrow. It is not a home for miscellaneous reusable
code. `domain` contains OpenWork decisions; `kernel` contains a mechanism that
can enforce invariants for more than one domain. `adapter` names an outside
thing. `presentation` is a real product boundary, not a synonym for a React
component directory.

### Dependency direction

```text
                            host
                 /-----------|-----------\
                v            v            v
          presentation    adapter       domain
                \            |            /
                 +-----------+-----------+
                             v
                           kernel
                             |
                             v
                          contract

          tool (build/test time) ---> public entrypoints
```

Arrows mean "may depend on." Additional rules make the diagram stricter:

- contracts never depend on another kind;
- kernels may depend on contracts, never domains;
- domains may depend on contracts and kernels;
- adapters and presentations may depend on contracts, kernels, and domains but
  not on each other by default;
- hosts are the only production composition roots;
- tools consume public exports and do not become runtime dependencies of
  contracts, kernels, domains, or presentations;
- cycles between workspaces are always defects, including type-only cycles.

If presentation and adapter behavior must collaborate, the host wires them
together through a domain- or presentation-owned port. For example, a Markdown
surface receives an `openTarget` callback; it does not import the desktop
bridge or app router.

## Runtime realms

`realms` describes where an exported implementation can execute, not where its
current consumer happens to live.

| Realm | Available assumptions | Prohibited assumptions unless a narrower realm is declared |
| --- | --- | --- |
| `neutral` | ECMAScript plus explicitly documented portable Web value APIs such as `URL` or `AbortSignal`, explicit inputs, injected ports | DOM, Node/Bun APIs, Deno APIs, Electron, global network/filesystem/process access |
| `browser` | DOM and browser APIs documented by the entrypoint | Node/Bun/Deno built-ins, Electron main APIs, server credentials |
| `worker` | Web-standard worker APIs, no DOM | DOM, Node-only APIs, ambient persistent storage |
| `node` | Declared supported Node version and exported Node built-ins | Bun-only behavior, Electron, browser DOM |
| `bun` | Declared supported Bun version and Bun APIs | Assuming equivalent Node behavior without conformance proof |
| `deno` | Declared Deno runtime and permissions | Node/Bun behavior or unrequested Deno permissions |
| `electron-main` | Electron main-process APIs plus the packaged runtime contract | Renderer DOM, unbounded renderer trust |
| `electron-renderer` | Browser APIs and the typed preload bridge | Direct Node/Electron main authority |

A package can support multiple realms only when each exported subpath identifies
its realm and the package has a conformance proof for each one. `neutral` is a
claim that must be earned; transpiling Node code does not make it neutral.
Browser-safe contracts may be consumed by every realm, but that does not permit
browser packages to acquire server authority.

## Package admission scorecard

Extraction begins with a score, not a directory move. Score each dimension from
0 to 3 and record the evidence in the package proposal.

| Dimension | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| Cohesion | Unrelated helpers | Similar technology | One broad concern | One named capability with a crisp purpose |
| Consumer demand | No proven consumer | One current call site | Two call sites or one host plus independent consumer | Multiple independent consumers/realms with the same semantics |
| Contract clarity | Implementation is the interface | Large or unstable surface | Mostly explicit with named compatibility edges | Small, complete contract with stable errors/lifecycle |
| Portability | Host globals throughout | Heavy host coupling | A few extractable ports | Realm-neutral or cleanly split realm subpaths |
| Authority clarity | Authority is implicit | Mixed package/host ownership | Most authority is injected | No ambient authority; ownership and ports are explicit |
| Independent proof | No focused tests | Host-only tests | Isolated tests or build | Unit, conformance, packed-consumer, and failure proof |
| Dependency improvement | Adds coupling | Moves coupling unchanged | Removes host/vendor leakage | Deletes duplication and makes dependency direction enforceable |
| Removal value | No deletion path | Duplicates remain indefinitely | Named adapter with exit condition | Old code/dependencies are removed in the same proven migration |

Admission requires all of the following:

- at least 18 of 24 points;
- no zero in cohesion, contract clarity, authority clarity, or independent
  proof;
- one real consumer and either a second real consumer or a packed reference
  consumer demonstrating independent value;
- a named composition point and migration/deletion plan;
- no new cycle, host-private import, or broader authority than the old path.

Scores from 13 through 17 remain incubation proposals. Lower scores stay local
until the boundary becomes clearer. A high score does not force publication;
it permits an internal extraction with public-quality discipline.

### Provisional first-slice scores

| Candidate | Cohesion | Demand | Contract | Portability | Authority | Proof | Dependencies | Removal | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `@openwork/session-groups` | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 23 |
| `@openwork/workspace-portability` | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 2 | 22 |
| `@openwork/markdown` | 3 | 2 | 3 | 2 | 3 | 3 | 3 | 3 | 22 |

These scores are provisional because extraction proof can lower them. Markdown
must prove its CSS/Tailwind contract outside the app source tree before its
portability score is retained. Workspace portability must preserve all export
warning and stripping behavior while separating filesystem and HTTP errors.

## Public export contracts

`package.json#exports` is the complete API allowlist. An entrypoint exists for a
consumer purpose or realm boundary, not as a mirror of the source tree.

Each library package must provide:

- a minimal root entrypoint for its primary capability;
- named subpaths only when they isolate a realm, optional dependency, or
  independently meaningful contract;
- `types`, `development`, and built `default` conditions where appropriate;
- an explicit `files` allowlist and an explicit `sideEffects` declaration;
- no `src/*` wildcard export and no reliance on undeclared deep imports;
- stable, serializable error codes at cross-realm boundaries;
- no import-time registration, I/O, logging, timers, or global mutation;
- a README section for purpose, use/non-use cases, realms, authority, public
  entrypoints, composition, failure behavior, and compatibility.

The packed tarball is the contract. Source files can be present for the
development condition, but a clean consumer must resolve production exports
without workspace aliases, root TypeScript config, or hoisted dependencies.

### Backend and domain exports

Backend-facing contract, kernel, domain, and adapter packages follow these
rules:

- Inputs and outputs use OpenWork-owned values. Database records, request
  objects, Electron objects, and vendor SDK types stop at adapters.
- I/O is represented by capability-specific ports. Ports receive
  `AbortSignal`; time, randomness, and retries are injected when they affect
  behavior.
- Resource limits, cancellation, timeout, retry, and disposal semantics are
  part of the API and have failure-path tests.
- Errors cross package boundaries as named codes plus safe metadata. Raw
  provider bodies, filesystem paths, credentials, and internal stack details do
  not become wire contracts.
- Route registration, auth, tenant/member selection, approval, database
  transaction selection, filesystem root selection, and environment parsing
  stay in the host.
- An adapter may own vendor protocol knowledge but cannot silently fall back to
  global `fetch`, process environment, a default credential store, or a wider
  filesystem root.

`@openwork/enterprise-mcp-client` is the reference pattern: provider-neutral
MCP/OAuth lifecycle sits behind injected networking, persistence, clock, and
diagnostic ports, while Den retains tenancy, authorization, SSRF policy, and
encrypted credential ownership. New packages should preserve that visible
line, not copy its subject matter or turn it into a universal service runtime.

### UI and presentation exports

UI value is packageable only when the complete rendering contract is explicit.
Presentation packages follow these additional rules:

- Headless behavior is exported separately from React/browser adapters when it
  can execute without the DOM.
- React is a peer dependency. A package must not bundle a second React runtime.
- Components receive state and effects through props, callbacks, or
  capability-specific providers. They do not import app stores, routers,
  desktop bridges, server clients, or host composition roots.
- Controlled versus uncontrolled state, focus behavior, keyboard behavior,
  accessibility labels, loading/empty/error states, and disposal are documented
  contracts.
- Theme tokens, CSS, fonts, icons, and other assets have explicit exports and
  side-effect declarations. A package may not rely on a host accidentally
  scanning its source tree for Tailwind classes.
- DOM sanitization, link opening, image preview, clipboard, downloads, and
  filesystem selection are named ports or host wrappers when they carry policy
  or authority.
- Browser-only singletons live in a browser subpath. Importing the neutral root
  must not touch `window`, `document`, or browser storage.
- Each surface has an isolated render/demo fixture and an observed host flow.
  Visual parity, keyboard/accessibility behavior, and production CSS retention
  are proof gates, not follow-up polish.

Presentation packages are allowed to be opinionated. Their value is a coherent
OpenWork interaction or renderer, not lowest-common-denominator primitives.
App-specific orchestration stays in thin wrappers so the package remains useful
without inheriting the whole app shell.

## Machine-readable package declaration

Governed workspaces add a validated `openwork.packageContract` object. Schema v1
keeps the machine contract deliberately small: the standard manifest remains
authoritative for purpose (`description`), distribution (`private`, `license`,
and `publishConfig`), exports, dependencies, and side effects. The package
README is required to enumerate public entrypoints and authority boundaries.

```json
{
  "name": "@openwork/markdown",
  "version": "0.1.0-experimental.0",
  "private": true,
  "description": "Safe, presentation-aware Markdown rendering for OpenWork surfaces",
  "sideEffects": ["./styles.css"],
  "openwork": {
    "packageContract": {
      "schemaVersion": 1,
      "capability": "markdown-rendering",
      "layer": "presentation",
      "realms": ["browser"],
      "stability": "experimental"
    }
  }
}
```

Allowed layers match the taxonomy above. Allowed stability values are
`experimental`, `candidate`, `stable`, and `deprecated`. `stable` is a release
promise and requires the additional release gate below; it never follows
automatically from extraction. Schema v1 declares the package's narrowest
overall executable realm. A later schema may describe realm per entrypoint; in
v1, a package with a neutral kernel plus browser adapter declares `browser` and
must separately prove that importing its root does not touch the DOM.

The checker auto-discovers declarations and rejects unknown fields, duplicate
capability ownership, incompatible layers/realms, host or enterprise
dependencies in inward package kinds, missing explicit entrypoints, omitted
side-effect declarations, realm-specific imports in neutral packages, and
boundary-escaping source imports. Hosts can adopt the declaration when the
repository-wide rollout reaches them, but reusable package governance begins
under `packages/`.

## Quality gates

### Gate 1: boundary and documentation

- Admission score and evidence are recorded.
- README states purpose, non-purpose, realms, authority, entrypoints,
  composition point, lifecycle, failure modes, and migration status.
- Manifest metadata validates and dependency direction is acyclic.
- Public API contains no host-private or vendor types unless the package is the
  named vendor adapter.

### Gate 2: isolated implementation

- Focused tests cover successful behavior, malformed inputs, limits,
  cancellation/disposal, duplicate or concurrency behavior where applicable,
  and normalized failures.
- Typecheck and production build pass from the package directory.
- Runtime dependencies are declared by the package that imports them.
- No test relies on a root alias, app source path, hidden global, real secret,
  customer data, or live external service.

### Gate 3: tarball and export conformance

- `pack` produces only intended files.
- A clean temporary consumer installs the tarball and resolves every export
  condition and subpath.
- At least one representative runtime executes the built API in every declared
  realm.
- Missing peers, undeclared transitive dependencies, case-sensitive paths, and
  side-effect behavior are checked from the installed artifact.

### Gate 4: host adoption and parity

- Real consumers import public package exports; no duplicate implementation or
  private source bridge remains without a ledgered expiry condition.
- Existing wire shapes, IDs, persistence, feature gates, and trust decisions
  remain compatible.
- A focused host test, production build, and relevant Fraimz flow pass.
- Presentation packages additionally prove production CSS/assets, visual
  behavior, keyboard/accessibility behavior, and both supported presentation
  states.
- Backend packages additionally prove auth/approval remains in the host and run
  timeout, cancellation, redaction, and resource-limit checks where relevant.

### Gate 5: cleanup and repository proof

- Superseded files, exports, dependencies, aliases, tests, and documentation are
  removed or entered in the stale-code ledger with an exact deletion gate.
- The lockfile reflects removed direct dependencies.
- App, server, desktop bridge, affected Den packages, installers/distributions,
  and the canonical core flow pass in proportion to the touched realms.
- Architecture snapshot and unused-code audit run on tracked plus non-ignored
  inputs without counting generated output.

### Additional public-release gate

A `public` package must also have an explicit license decision, semantic version
policy, changelog, supported runtime matrix, third-party license audit,
provenance/release automation, API compatibility check, security reporting
path, and documentation that works outside this monorepo. Until that gate is
complete, packages remain private even when their design is independently
usable.

## Current inventory and readiness

The corrected architecture snapshot reports 28 workspaces and 37 internal
workspace dependency edges. The manifest audit below uses tracked
`package.json` files from `apps/*`, `packages/*`, `ee/apps/*`, and
`ee/packages/*`; ignored generated packages are excluded.

| Signal | All 28 workspaces | 16 package directories |
| --- | ---: | ---: |
| Description present | 14 | 10 |
| Explicit `exports` map | 13 | 12 |
| Test script | 15 | 9 |
| Typecheck script | 11 | 7 |
| Build script | 23 | 12 |
| Explicit `sideEffects` declaration | 4 | 4 |
| `files` allowlist | — | 14 |
| README | — | 11 |
| Manifest not marked private | 1 | 1 |

This is a readiness baseline, not a claim that every host needs a library
export. The package-directory column is the relevant warning: existing package
quality is uneven, and workspace placement alone does not establish a contract.

The strongest existing reference set is
`@openwork/enterprise-mcp-client`, `@openwork/extension-contracts`,
`@openwork/contribution-registry`, `@openwork/extension-catalog`, and
`@openwork/session-contracts`: each has a description, focused test,
typecheck, build, explicit exports, and an independently meaningful contract.
The four experiment-owned packages now declare and pass the package-contract
gate; the enterprise MCP client still needs that governance and a
release-readiness review.

Current boundaries that need deliberate treatment include:

- `@openwork/types`: seven subpaths combine workspace, desktop IPC, and several
  Den concerns without focused test/typecheck or a package purpose. It should be
  decomposed by contract ownership, then retained temporarily as a compatibility
  facade.
- `@openwork/ui`: one React export and a build exist, but description,
  test/typecheck, side-effect declaration, and complete CSS/asset contract are
  not yet manifest evidence.
- `@openwork-ee/utils`: the name does not express product value and must be
  split by proven capability or returned to its consuming host.
- `@openwork-ee/den-db`: many exports represent a realm adapter. It should be
  assessed as Den-owned persistence infrastructure, not generalized into a
  portable domain package.
- packages without exports may be executable tools or incomplete libraries.
  Their taxonomy must be declared before standardizing their manifest.

## Whole-repository extraction map

The sequence is dependency-first. Each stage can land independently and leaves
the application working; no stage authorizes a wholesale rewrite.

| Stage | Focus | Candidate outcomes | Exit condition |
| --- | --- | --- | --- |
| A. Govern | Make package intent measurable | Manifest schema/checker, dependency rules, scorecards, package template, tarball consumer harness | New governed packages cannot bypass constitution gates |
| B. Prove different product values | Extract a cross-host user domain, backend/domain policy, and presentation capability | `@openwork/session-groups`, `@openwork/workspace-portability`, `@openwork/markdown` | App and server consume packages; old implementations and direct dependencies are removed; packed and Fraimz proof pass |
| C. Untangle cross-realm contracts | Replace type grab bags with owned contracts | `@openwork/workspace-contracts`, `@openwork/desktop-contracts`, focused Den contracts; temporary `@openwork/types` facade | App/server/desktop/Den consume purpose-named entrypoints; facade usage reaches zero |
| D. Package server capabilities | Separate portable behavior from HTTP/Bun host policy | workspace import/export policy, route schemas and typed client, install/config policy, session adapters | Server routes are thin auth/transport composition; app client uses owned schemas; filesystem/process authority stays server-side |
| E. Package presentation value | Make UI behavior and styling independently consumable | Markdown first; design tokens/primitives, artifact viewers, settings surfaces, diagnostics views, headless controllers where they earn admission | Each package has CSS/assets/a11y/demo contracts and no app router/store/server-client imports |
| F. Clarify desktop/runtime edges | Split contract, mechanism, and OS adapter | desktop IPC contracts and handler bundles; updater/install contracts; characterized sidecar/process supervisor plus Electron adapters | IPC snapshots and packaged lifecycle pass; no universal process abstraction is invented before characterization |
| G. Clarify MCP and cloud domains | Reuse portable contracts while preserving enterprise authority | existing enterprise MCP client, connection contracts, capability-source conformance kit, provider adapters, cloud-domain packages one domain at a time | Den retains tenancy, credentials, SSRF, audit, and database authority; local/direct and cloud MCP planes stay distinct |
| H. Standardize tools and distribution | Treat executable value as products with inputs/outputs | bootstrap/install CLIs, UI MCP, mock servers, conformance fixtures, packaging helpers | Tools consume public exports, have dry-run/rollback behavior, and do not import host-private source |
| I. Prune and release-select | Remove compatibility layers and decide which packages deserve public stability | zero-consumer deletion, dependency/asset cleanup, public candidates with versioned API baselines | Full product/distribution proof passes; every retained package has a purpose and every public candidate passes the release gate |

### Capability placement map

| Current value | Target kind and boundary | Connection point | Important limit |
| --- | --- | --- | --- |
| Extension and session wire values | Existing purpose-named `contract` packages | App/server/Den adapters | Contracts remain data; they do not execute features |
| Contribution invariants | Existing `kernel` package | Realm-local registries | No service locator or universal contribution interface |
| Enterprise remote MCP lifecycle | Existing domain/adapter package boundary | Den composition adapter | No local/direct MCP or tenant/credential authority migration |
| Session-group state and transitions | `@openwork/session-groups` (`domain`, `neutral`) | Server persistence/routes, app client, optimistic UI adapter | Hosts retain IDs, persistence, HTTP, event retention, storage, and React state |
| Workspace export warning/stripping policy | `@openwork/workspace-portability` (`domain`, `neutral`) | Server export flow; app client contract | No filesystem, route, auth, archive, or secret-store ownership |
| Portable path policy | A focused subpath or later domain package if it passes admission | Server filesystem adapter and import preview | `ApiError` and filesystem calls remain host-side |
| Workspace and desktop IPC wire types | Purpose-named `contract` packages | Server, app, Electron main/preload | `@openwork/types` remains only as a temporary facade |
| Markdown parsing/highlighting/presentation | `@openwork/markdown` (`presentation`) | Existing conversation and document-preview wrappers | App link/router/image interaction stays in wrappers; browser adapter is a separate subpath |
| Broad app/server client | Route contracts plus a typed client domain/adapter package | App client composition | Auth token storage and request policy stay with host adapter |
| Settings and artifact surfaces | Presentation packages only where scorecard passes | Explicit app surface assembly | Do not package every component; router/store ownership stays app-local |
| Workspace import preview | Split domain policy from server adapter after characterization | Server workspace routes | Current crypto, filesystem, commands, skills, and config coupling is not moved wholesale |
| Desktop process/sidecar behavior | Deferred kernel/domain plus OS adapters | Desktop/orchestrator composition | No extraction until health, log, restart, cancellation, and disposal semantics are characterized |
| Den persistence and cloud routes | Den adapters and focused domain packages | Den composition roots | Tenant, role, credential, SSRF, audit, and transaction authority remain in Den |

## Completed proof slice: `@openwork/session-groups`

The first governed functionality package owns the session-group state model,
normalization limits, deterministic create/rename/remove/reorder/assign/import
transitions, transition results, and event wire vocabulary. It has no runtime
dependency and no ambient authority.

The package is consumed through three different connection points:

- the server SQLite/event adapter imports normalization and event contracts;
- the server HTTP route adapter applies the same deterministic transitions while
  retaining authentication, writable checks, random ID generation, persistence,
  and HTTP error behavior;
- the app client aliases its wire types to the package and the Zustand adapter
  uses the same transitions while retaining local storage, optimistic ordering,
  collapsed UI state, and React selectors.

The package has nine focused domain tests and is included in the multi-tarball
installed-consumer proof. The unchanged server session-group API test covers
persistence, concurrent updates, event ordering, and bounded per-workspace
events. The complete app suite, app/server typechecks, and production builds
remain the host parity gate. This slice removes duplicate state/event types and
transition implementations without moving host authority into the package.

## Completed proof slice: `@openwork/workspace-portability`

### Value and boundary

The server previously contained 323 lines of environment-neutral workspace
export policy in `workspace-export-safety.ts`, with focused tests for benign
configuration, secret-like keys and values, provider settings, portable files,
and exclude-mode stripping. The app separately declared corresponding export,
import-preview, mode, warning, and file wire types. Those owners are now one
cohesive domain boundary with server and browser consumers.

The package owns:

- `PortableFile`;
- workspace export bundle and import-preview wire contracts;
- `WorkspaceExportSensitiveMode`;
- `WorkspaceExportWarning`;
- portable path allowlists, normalization, and stable portability errors;
- `collectWorkspaceExportWarnings`;
- `stripSensitiveWorkspaceExportData`.

Its root is neutral and has no runtime host dependency. It returns
OpenWork-owned values and `WorkspacePortabilityError`; the server adapter maps
the two stable portability codes to the existing `ApiError` transport shape.

### What stays outside

Server routes, authentication, workspace root selection, filesystem reads and
writes, archive generation, import preview orchestration, command/skill loading,
and HTTP error mapping stay in `openwork-server`. The app retains transport and
dialog state. Secret detection remains a documented warning/sanitization policy,
not a claim that heuristics can guarantee an export contains no secret.

### Migration and proof result

- The safety implementation and four characterization tests moved into the
  package; three additional tests cover path normalization, allowlists, value
  coercion, traversal, environment files, reserved segments, and stable errors.
- The server export flow consumes the package directly. Filesystem traversal,
  absolute-path planning, writes, and transport-error mapping remain in its
  adapter and retain three focused tests.
- The server import preview and app client now consume the same import/export
  types; the public app aliases remain source-compatible.
- Six packages build, typecheck, pack, install together into a clean consumer,
  and resolve every public export from the tarballs.
- Sixteen existing import-preview tests prove preview/apply fingerprints,
  replacement, deletion, approval, rollback-on-write-failure, and public-shape
  behavior. Two new route tests prove auto/include/exclude and invalid-mode HTTP
  compatibility through the packaged policy.
- The superseded server safety module and duplicated app declarations are
  removed. The app/server typechecks and production builds remain the host gate.

## Next slice: `@openwork/markdown`

### Value and boundary

The app has one 345-line rendering kernel shared by the conversation and
document-preview Markdown surfaces, a 55-line browser adapter, text-highlight
helpers, and six focused kernel tests. It already exposes useful ports for HTML
sanitization and syntax highlighting. Seven direct app dependencies are
exclusive to this capability: `marked`, `marked-emoji`, `marked-shiki`,
`emojilib`, `dompurify`, `@shikijs/transformers`, and `shiki`.

The proposed package entrypoints are:

| Export | Realm | Owns |
| --- | --- | --- |
| `@openwork/markdown` | `neutral` | Rendering kernel, presentation variants, link/image safety policy, highlighting ports |
| `@openwork/markdown/browser` | `browser` | DOMPurify/Shiki implementation and browser lifecycle |
| `@openwork/markdown/text-highlights` | `neutral` or `browser`, based on live dependencies | Text-highlight parsing/selection contract |
| `@openwork/markdown/styles.css` | `browser` | Explicit CSS/Tailwind integration required by generated markup |

The exact subpaths must be reduced if they do not represent independent
consumer purposes. The root must remain importable without `window` or
`document`. Browser dependencies belong to the browser entrypoint, and the app
must no longer declare capability-private dependencies.

### What stays outside

The two React wrappers remain app-local initially. They own router/desktop
opening policy, motion, host state, image interactions, and product-specific
composition. A React entrypoint is admitted later only if another consumer can
use the same surface contract without importing app state.

The generated HTML currently contains Tailwind utilities and OpenWork design
tokens. The package must ship self-contained styles or an explicit exported
source/style contract; relying on the app's incidental Tailwind scan is not
acceptable. The preferred outcome is a package-owned stylesheet with an
explicit side-effect export, proven in production output. If that is not
technically viable, the host scan integration must be exported, documented,
and tested as part of the package contract.

### Migration and proof

1. Move the kernel, browser adapter, highlight helpers, and focused tests without
   changing output.
2. Declare the seven Markdown dependencies at the narrowest package/entrypoint
   that imports them and remove them from the app.
3. Migrate both existing wrappers through public exports; do not add a generic
   React facade merely to hide imports.
4. Pack and install the package in clean neutral and browser consumers; execute
   every public entrypoint and verify no browser global is touched by the root.
5. Prove sanitized raw HTML, unsafe links, emoji, tables, fenced-code fallback,
   highlighted code, conversation links, and document-preview behavior.
6. Prove production CSS/class retention and run app tests, typecheck, desktop
   and web builds, `artifact-markdown-render`, and the canonical core Fraimz
   flow.
7. Remove old app modules, aliases, direct dependencies, and redundant tests
   only after both surfaces use the installed contract.

## Authority boundaries and non-goals

Packaging does not transfer trust. The following authority remains with the
current hosts unless an explicit later decision changes it:

| Host | Authority retained |
| --- | --- |
| App/browser | User interaction, navigation, ephemeral UI state, permission prompts, host client selection |
| OpenWork server | Authentication, approvals, workspace filesystem root, local process/engine lifecycle, route and error mapping |
| Desktop/Electron | OS integration, IPC admission, updates/install, native helpers, packaged sidecars, renderer trust boundary |
| Den | Organization/member tenancy, roles, credential modes, encrypted persistence, SSRF/egress, audit, database transactions |
| External provider | Provider protocol and remote service behavior, represented only through adapters |

This experiment does **not**:

- create a universal extension runtime, marketplace, sandbox, or third-party
  code execution policy;
- force browser, Node/Bun, Electron, Den, and external providers into one
  lifecycle or dependency container;
- publish every internal package or promise stable public APIs prematurely;
- turn every component, hook, route, schema, or helper into a workspace;
- move authentication, approval, tenancy, secrets, persistence, network egress,
  filesystem roots, or process authority into portable packages;
- redesign product behavior or wire formats as part of a package move;
- accept a generic package merely because code appears in two places;
- delete code based only on an unused-import tool or a passing unit suite.

The goal is a thin, explicit host around valuable packages, not the elimination
of host code. Composition, deployment, security policy, and realm ownership are
valuable responsibilities and should remain obvious.

## Stale-code and compatibility workflow

Every extraction uses an evidence ledger. A candidate is not stale until all
of these paths have been checked:

1. tracked and non-ignored source imports, dynamic imports, exports, workspace
   dependency edges, and test-only imports;
2. convention-based discovery, generated manifests, route/file naming,
   Electron preload channels, package `files`, assets, installer/container
   copies, and documentation commands;
3. runtime composition lists, feature flags, compatibility fallbacks, persisted
   versions, external consumers, and release artifacts;
4. affected host tests/builds, packed distributions, and observable Fraimz
   flows.

The ledger records owner, purpose, entrypoints, known consumers, classification
(`active`, `compatibility`, `generated`, `test-only`, `unreachable`, or
`unknown`), evidence, removal risk, deletion condition, proof command, and
rollback commit. Unknown code is characterized; it is not silently deleted.

Removal happens in a focused commit after the new consumer path is proven. The
same slice removes obsolete exports, aliases, dependencies, lockfile entries,
fixtures, and docs. Compatibility adapters have an observable usage or consumer
count and an expiry condition. A passing build is necessary but insufficient:
packaged desktop/server/install artifacts and at least the canonical core flow
must prove that convention-loaded and runtime-selected code was not lost.

## Repository end state

The experiment is complete only when:

- every retained workspace declares a purpose and taxonomy, or is explicitly
  scheduled to return to a host;
- all reusable packages have realm, authority, export, side-effect, lifecycle,
  and packed-consumer contracts;
- contracts, kernels, domains, adapters, presentations, hosts, and tools follow
  an enforced acyclic dependency direction;
- app, server, desktop, Den, and distribution composition points are searchable
  and list the packages/adapters they trust;
- `@openwork/types` and generic utility packages no longer hide unrelated
  ownership;
- duplicated behavior and compatibility facades have either reached zero usage
  and been removed or have a named, measured reason to remain;
- the current feature inventory, wire compatibility, security authority, full
  supported builds, and observable core flows remain intact;
- publication candidates can be copied into a clean repository, installed from
  a tarball, documented, tested, versioned, and used without OpenWork host
  internals.

That end state makes extension registration one composition technique among
many. The durable product architecture is the set of clear packages and the
small, visible contracts through which they collaborate.

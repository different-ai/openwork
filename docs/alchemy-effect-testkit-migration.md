# Alchemy + Effect migration proposal for OpenWork testkit

Status: **Proposed**
Decision requested: approve an Effect-first refactor and one gated Alchemy
provider pilot; do not approve a wholesale testkit rewrite.
Research snapshot: **2026-08-21**, Alchemy `2.0.0-beta.72`.

## Executive summary

Alchemy, Effect, and `@openwork/testkit` solve different problems:

- **Effect** is a runtime and composition model for typed failures,
  dependencies, concurrency, retries, interruption, and scoped acquisition and
  release.
- **Alchemy** is a desired-state engine built on Effect. It adds resource
  identity, dependency graphs, plan/apply/destroy, provider lifecycle methods,
  and persisted state.
- **OpenWork testkit** is an application/E2E harness. It decides placement,
  starts local or Daytona resources, drives OpenWork, records witness evidence,
  and maps outcomes to Passed/Incomplete/Failed.

The current testkit is mostly **ephemeral orchestration**, not infrastructure
reconciliation. Effect is therefore a strong fit for its internals. Alchemy is
a fit only where a resource is external, durable enough to outlive the Node
process, discoverable after interruption, and safely reconcilable. The first
plausible Alchemy candidate is the desktop sandbox created by the Daytona suite
preparer; local child processes, ports, temporary profiles, mocks, users, and
organizations should remain scoped Effect resources or application fixtures.

The recommendation is:

1. Keep the public `@openwork/testkit` API, Vitest runner, witnesses, claims,
   ambient evidence, and verdict rules unchanged.
2. Introduce Effect behind that API and migrate one lifecycle at a time.
3. Build one custom Alchemy provider for a suite-owned Daytona desktop sandbox
   only after the Effect boundary is stable.
4. Compare reliability, cleanup, runtime, and maintenance cost against the
   existing implementation before expanding.
5. Remove the Alchemy pilot if it does not materially improve interrupted-run
   recovery or leak prevention. Do not keep it merely for architectural
   consistency.

This is intentionally not a big-bang migration.

## Why consider a change

The authoring contract is already good. Specs acquire resources in dependency
order with `needs()` -> `server()` -> `app()`, use normal observable
assertions, and get ambient evidence without passing recorder handles
(`evals/README.md`). The migration should preserve that.

The maintenance pressure is below the facade:

- `server()` contains attached, Daytona, and local lifecycles in one function,
  with hand-written acquisition rollback and disposal paths
  (`evals/packages/testkit/src/server.ts`).
- Local Den provisioning coordinates MySQL, Redis, an ephemeral database,
  ports, two child processes, readiness probes, organization fixtures, logs,
  and teardown.
- Daytona provisioning coordinates sandbox creation or reuse, checkout,
  install, display/browser readiness, public URLs, seeded identities, mocks,
  and conditional deletion (`evals/packages/hosts/src/provision.ts`).
- Most resources expose `AsyncDisposable`, but every composition site still
  decides how partial acquisition, retry, cancellation, and cleanup errors are
  represented.
- Placement and command execution are concrete dependencies, which makes
  failure-path testing harder than it needs to be.

Effect can centralize those mechanics without changing what a spec sees.
Alchemy may additionally help recover a remotely created sandbox after the
test process is interrupted, where in-process disposal cannot run, provided a
retry uses stable ownership identity or a janitor can rediscover the resource.

## What Alchemy would and would not replace

Alchemy's core loop is:

```text
Stack program
  -> desired resource graph
  -> diff against persisted state
  -> dependency-ordered reconcile/delete
  -> updated state
```

A custom provider implements required `reconcile` and `delete` behavior plus
optional hooks such as `read`, `diff`, and `list` as an Effect Layer. A stage
isolates physical resources and state. Alchemy's Vitest adapter can deploy and
destroy stacks, but it does not provide OpenWork's application-driving,
witness, evidence, or verdict semantics.

Alchemy would **not** replace:

- `evals/specs/**/*.test.ts` or Vitest;
- `@openwork/test-evidence`, `briefTest`, `prove.<claim>()`, screenshots, or PR
  publication;
- `@openwork/labs` deterministic provider witnesses;
- `@openwork/behaviors`, CDP surfaces, or matchers;
- requirement checks and named skips from `needs()`;
- product code or production deployment;
- Daytona, Docker, MySQL, Redis, Electron, or their underlying APIs.

It would replace only selected imperative **external-resource lifecycle** code
after an OpenWork-specific provider exists. Alchemy has no built-in Daytona
provider, so adopting it does not remove the need to understand or test the
Daytona lifecycle.

There is also a known runner incompatibility in the reviewed versions. OpenWork
evals use Vitest `^3.2.4`. `alchemy@2.0.0-beta.72` requires Effect
`>=4.0.0-beta.105` and depends on the matching Effect 4 `@effect/vitest`, whose
peer range requires Vitest `>=4.1.0 <5`. The Alchemy Vitest adapter therefore
cannot be installed as the OpenWork test fixture without upgrading the eval
runner. This proposal does not upgrade Vitest: the pilot may use only Alchemy's
core programmatic lifecycle behind OpenWork's existing fixture. If pnpm cannot
isolate Alchemy's transitive Vitest 4 from the Vitest 3 runner, the Alchemy
pilot stops. The repository's existing Effect `4.0.0-beta.83` also does not
satisfy Alchemy's peer floor, so the isolated eval workspace would initially
carry a newer pinned Effect version.

## Decision axes

Effect adoption and Alchemy adoption are separate decisions.

| Concern | Effect | Alchemy | Current testkit |
| --- | --- | --- | --- |
| Primary abstraction | Typed program with services and scopes | Desired resource with provider lifecycle | Promise-returning test fixture/handle |
| Normal lifetime | Request, test, process, or explicit Scope | Across deploys through persisted state | One test or prepared suite |
| Cleanup | Scope finalizers and interruption | `destroy`/provider `delete` | `AsyncDisposable` plus manual rollback |
| Dependency graph | Service/Layer composition | Resource inputs/outputs | Call order and nested helpers |
| Recovery after process death | No; the process is gone | Possible through state or deterministic identity plus `read` | No automatic recovery |
| Drift/reconciliation | Application-defined | Provider-defined plan/apply | Recreate, reuse, or health-check |
| Best OpenWork fit | Processes, DB handles, mocks, desktop, fixtures | Owned remote sandboxes/snapshots if discoverable | Spec API, evidence, user journeys |

Alchemy is not an always-on controller. A killed CI job still needs a later
rerun or janitor to invoke reconciliation/deletion. Its normal plan is also
based on persisted state; provider code must observe live state when it
reconciles. It must not be presented as universal drift detection.

## Goals

1. Preserve the existing spec-authoring and evidence contracts.
2. Make acquisition, partial failure, interruption, and reverse-order release
   explicit and testable.
3. Replace unstructured lifecycle errors with a small typed error taxonomy
   while preserving actionable messages at the Vitest boundary.
4. Make local, attached-Den, and Daytona implementations swappable through
   Layers rather than branches spread through resource constructors.
5. Determine with evidence whether Alchemy improves remote-resource recovery
   enough to justify its state and provider cost.
6. Keep pnpm and Node.js 22+ as the supported eval toolchain. Bun must not
   become required.

## Non-goals

- Rewriting all specs to `Effect.gen`.
- Replacing OpenWork's `test` fixture with `alchemy/Test/Vitest`.
- Treating users, org membership, OAuth grants, or seeded product data as IaC.
- Persisting test credentials in Alchemy props, outputs, or state.
- Managing an attached Den, an externally supplied reuse, or a borrowed
  suite-owned sandbox from per-test code.
- Moving eval state to Cloudflare or adding production cloud dependencies.
- Adopting Alchemy for local ports, temporary directories, child processes, or
  desktop profiles solely because they can be modeled as resources.
- Changing skip, evidence, or verdict semantics as part of the migration.

## Proposed architecture

```text
evals/specs + Vitest
        |
        v
@openwork/testkit public Promise/AsyncDisposable facade       unchanged
        |
        v
internal Effect programs and Layers                           new
  - EvalConfig / Place / TestCancellation
  - CommandExecutor / Clock / PortAllocator
  - LocalDatabase / LocalProcess / MockRuntime
  - DenRuntime / DesktopRuntime / DaytonaClient
        |
        +--> existing @openwork/hosts, @openwork/labs,
        |    @openwork/behaviors, @openwork/cdp
        |
        `--> optional Alchemy stack adapter                    gated pilot
               `--> OpenWork DaytonaDesktopSandbox provider
```

### Stable public boundary

Existing specs continue to look like this:

```ts
const requirements = needs({ placement: "local" });
await using den = await server({ place, ...requirements });
await using desktop = await app({ den, as: "admin", place });
```

Internally, the facade opens an Effect Scope, acquires the resource, and
returns the existing handle shape. Calling `Symbol.asyncDispose` closes that
Scope. This lets migration happen resource by resource without forcing Effect
types into every spec or coupling evidence recording to a new test adapter.

That disposal bridge covers normal lexical exit, not a timeout by itself. The
test fixture must retain Vitest's abort signal, interrupt the owning Effect
fiber when the signal fires, and close all registered scopes after the test
body. The current wrapper narrows the callback context to `place`, `evidence`,
and `skip`; carrying cancellation internally is part of Phase 1. Process death
still requires startup cleanup or an external janitor.

### Internal Effect services

The first internal services should be narrow capabilities, not a mirror of
every existing module:

| Service | Responsibility | Implementations |
| --- | --- | --- |
| `EvalConfig` | Validated run ID, placement, paths, timeouts | Environment-backed test Layer |
| `TestCancellation` | Interrupt fibers and close scopes on runner abort | Vitest signal, deterministic fake |
| `CommandExecutor` | Run local or sandbox commands with bounded output | Local, Daytona, fake |
| `PortAllocator` | Reserve/release ports | Local, deterministic fake |
| `DatabaseRuntime` | Acquire/drop an isolated database | Local MySQL, unavailable on Daytona |
| `MockRuntime` | Start/expose/stop a witness | Local, Daytona |
| `DenRuntime` | Acquire an attached, local, or Daytona Den | Layer selected once from `Place` |
| `DesktopRuntime` | Acquire and stop an isolated app surface | Local, Daytona |

Use scoped acquisition/release for resources and bounded Schedule-based retry
for readiness. Expected operational failures should be tagged errors such as
`RequirementUnavailable`, `ProvisionFailed`, `ReadinessTimedOut`, and
`CleanupFailed`. Unknown defects remain defects. At the public boundary:

- `RequirementUnavailable` maps to the existing named `SkipError` only when it
  represents a declared requirement;
- provisioning/readiness failures fail the test;
- cleanup behavior remains compatible with each existing handle: several
  disposers currently log and swallow cleanup errors, and this RFC does not
  change their verdict semantics;
- error messages retain the command context and bounded log tail used today.

Dedicated lifecycle specs and pilot post-run audits must still fail when they
observe a leaked owned resource. That verifies the migration without silently
changing the generic Passed/Incomplete/Failed contract. A separate decision is
required if all cleanup errors should become test failures.

### What belongs in Alchemy

A resource is eligible only if all answers are yes:

1. Can it outlive the test Node process?
2. Can the provider find it again by stable identity without trusting stale
   local memory?
3. Can `reconcile` safely run more than once after partial success?
4. Can `delete` safely run more than once and refuse foreign resources?
5. Is there value in planning/recovery beyond scoped acquire/release?

Initial classification:

| Resource | Owner | Rationale |
| --- | --- | --- |
| Local port or temporary directory | Effect Scope | Process-local and cheap; persisted state adds no recovery value |
| Local MySQL database | Effect Scope + startup cleanup | Random per-run name; scoped teardown handles live runners, while a TTL cleanup path is needed after process death |
| Den API/Web child processes | Effect Scope + startup cleanup | Process supervision, readiness, and interruption are runtime concerns, but detached children can survive a killed runner |
| MCP mock/fault proxy | Effect Scope | Deterministic witness with a short test lifetime |
| Electron profile/process | Effect Scope | Caller drives a live process; not desired cloud state |
| Den org/users/grants | Behavior fixture | Application data with authorization semantics, not infrastructure |
| Attached Den or externally supplied reuse | External reference | Caller-owned; testkit must never reconcile or delete it |
| Suite-prepared Daytona sandbox | Runner-owned resource borrowed by tests | Created and deleted in `evals/runner/prepare-stack.ts`; the normal Daytona path and first Alchemy pilot candidate |
| On-demand Daytona sandbox | Test-owned resource | Also eligible later, but ownership must remain distinct from external and suite-prepared reuse |
| Shared Daytona base snapshot | Later candidate | Durable desired artifact, but cache/version/ownership policy must be designed first |

Environment variables currently make a suite-prepared sandbox look similar to
reuse at the `server()`/`app()` layer. The migration must carry provenance
explicitly: `external`, `suite-owned`, or `test-owned`, plus the component that
is allowed to delete it. A borrowed per-test handle never deletes a
suite-owned sandbox; global setup owns its cleanup.

The first provider should expose one `OpenWork.DaytonaDesktopSandbox` resource
inside the suite preparer. Its desired props contain only non-secret identity
and configuration: requested git ref, snapshot name, retry-stable ownership ID,
and a resolved Daytona organization/account/target fingerprint. Returned
attributes contain the sandbox ID, ownership marker, and that fingerprint only.
Preview URLs are resolved by a scoped Effect service after deployment and are
not persisted in Alchemy state.

Den is deliberately not the first provider. Its provisioner obtains 24-hour
signed preview hostnames and bakes those exact hosts into OAuth/MCP identity.
Every fresh `daytona preview-url` call can mint a different hostname. Persisting
that URL risks storing a signed capability and later returning an expired
endpoint on an Alchemy no-op; regenerating it can break issuer identity. A Den
provider requires a separate endpoint-lifetime design.

Provider rules:

- `read` verifies the sandbox exists and carries the expected run ownership
  when state is absent or interrupted;
- every operation validates the active Daytona context against the persisted
  non-secret organization/account/target fingerprint and fails before create or
  delete on context drift;
- a foreign same-name sandbox fails with a provider-specific ownership error;
  it is not returned as `Unowned`, because Alchemy's `--adopt` mode can take
  over an `Unowned` resource;
- `reconcile` revalidates context, fence, and ownership before its first remote
  mutation, then observes/ensures and converges checkout and readiness;
- `delete` treats not-found as success and deletes only owned resources;
- `diff` updates a git ref in place only if the existing checkout/install path
  proves convergence; snapshot or ownership changes replace the sandbox;
- replacement uses a generation-specific physical name so create-before-delete
  cannot collide, or explicitly uses delete-first if Daytona cannot support
  overlapping generations;
- the first provider omits `list`; account-wide `alchemy unsafe nuke` remains
  unsupported, and TTL cleanup uses a separately ownership-filtered janitor;
- caller-provided `reuse` is represented as an external reference outside the
  Stack, never as a managed Resource;
- `alchemy unsafe nuke` is not part of any OpenWork workflow.

If Daytona CLI/API behavior cannot support those rules, the Alchemy pilot is a
no-go. Wrapping the same create/delete script in a provider without reliable
`read` and ownership would add state without adding reconciliation.

Restored terminal Alchemy state is not live proof: unchanged state normally
plans a no-op, so neither `read` nor `reconcile` is guaranteed to run. Before a
restored suite slot is published, the adapter performs a read-only preflight of
Daytona context, fence, and ownership; only then may it invoke a supported
forced reconcile. The provider repeats those checks immediately before its
first mutation to avoid a check/use race. A final live preflight verifies
existence, running status, requested checkout, and readiness. A stopped owned
sandbox is restarted, a missing owned sandbox is recreated, and a
foreign-owned sandbox fails with zero mutations. If Alchemy's core API cannot
force this path without the incompatible Vitest adapter, same-state recovery
is a no-go.

### State, identity, and cleanup

The pilot uses a retry-stable recovery ID supplied by the eval orchestrator,
not `Date.now()`. In CI it should derive from the workflow run, job, explicit
matrix/shard identity, and worker slot while intentionally excluding the retry
attempt. A rerun of one shard retains its key; concurrent shards must differ.
Local runs may generate an invocation ID when cross-run recovery is not
requested. A unique stage and resource owner derive from that value, for example
`eval-<recovery>-w<worker>`.

Alchemy beta.72's built-in `localState()` does not accept a path and captures
`process.cwd()` at module load, so it cannot directly satisfy run-scoped state
under the eval result area. Phase 0 must choose one of two isolated mechanisms:

- a conformant custom State Layer rooted under that run's result directory; or
- an Alchemy helper subprocess whose cwd is the run result directory before its
  first Alchemy import.

Do not mutate cwd inside the shared Vitest process. Preserve the isolated state
as a diagnostic artifact on failure and remove it after verified destroy on
success. Local state alone does not recover across a new CI machine.

A custom State Layer must prove the same safety properties the pilot depends
on: atomic replacement, recovery after interrupted write/delete, defensive
handling of missing directories/records, and concurrent disjoint stages. The
helper subprocess is preferred if it can reuse Alchemy's built-in local store;
path convenience alone does not justify maintaining a state backend.

Cross-machine recovery is a separate gate and does not inherently require
remote state. There are three mechanisms to test independently:

- preserve the run-scoped state artifact and resume with the same recovery ID;
- start with empty state but the same deterministic identity and let provider
  `read` rediscover the owned sandbox;
- run a Daytona ownership/TTL janitor for jobs that are never retried.

A remote state store is optional. It is useful only if retaining Alchemy's full
intermediate lifecycle is worth the additional locking, access-control, and
retention surface, and only after parallel workers are proven safe.

Retries that intentionally share a recovery ID need a single-writer lease and
fencing token scoped by Daytona context, recovery ID, shard, and worker. Every
reconcile, delete, janitor action, and borrowed-host mutation validates the
current token. The token is carried into `CommandExecutor`/the Daytona Host;
lease loss interrupts the old test worker and rejects its next operation. A
takeover must use a new sandbox generation unless prior-attempt termination is
positively confirmed, so an old in-flight command cannot mutate the new
attempt's sandbox. The lease is heartbeated by the active attempt; a janitor may
delete only after both lease expiry and ownership checks. If this cannot be
enforced with the Daytona API and runner, shared-identity retry is a no-go.

The janitor is required before claiming that the migration prevents leaks.
Alchemy only cleans up when a process runs `destroy`; it cannot finalise a job
after `SIGKILL` by itself.

No token, cookie, password, API key, signed preview URL, or raw environment map
may enter Alchemy state. Secrets and transient endpoints stay in Effect
services and are resolved inside or immediately after provider operations.
Remote state is out of scope until its encryption, access control, retention,
and locking are reviewed.

Effect Scope also cannot clean detached local children or databases after
`SIGKILL`. Phase 2 may only claim in-process cleanup improvements unless it adds
an ownership-aware startup/TTL cleanup path and proves that path against a
forcibly terminated runner.

## Migration plan

### Phase 0: compatibility and boundary spike (2-3 engineer-days)

No production lifecycle moves in this phase.

1. Pin exact `alchemy`, `effect`, and `@effect/platform-node` versions in the
   isolated `evals/` workspace; do not depend on `@next` and do not add
   `@effect/vitest` to OpenWork's runner.
2. Use an Effect version satisfying Alchemy's reviewed
   `>=4.0.0-beta.105` peer range. Verify pnpm + Node.js 22 execution,
   TypeScript 5.9, Vitest 3.2, ESM exports, and the existing eval tsconfig. Bun
   remains optional.
3. Prove an internal Effect Scope can return an existing `AsyncDisposable`
   facade, that ambient evidence survives Effect fibers, and that a Vitest abort
   signal interrupts the fiber and closes the Scope.
4. Exercise a fake lifecycle provider from a normal `@openwork/testkit`
   app-less spec, using Alchemy core rather than `alchemy/Test/Vitest`. Cover
   create, update, replace, repeated reconcile, partial failure, delete, and
   not-found delete.
5. Prove either the custom State Layer or pre-import helper-process approach can
   isolate state under one eval result directory; the built-in `localState()`
   is not configurable enough in the reviewed release. If custom, test atomic
   writes, interrupted write/delete recovery, missing records/directories, and
   concurrent disjoint stages.
6. Prove the Alchemy core API can force reconciliation of unchanged terminal
   state without adopting `alchemy/Test/Vitest`.
7. Measure install-size and cold-import impact of Alchemy's transitive graph.

**Gate:** stop Alchemy work if it requires replacing the OpenWork test fixture,
requires upgrading Vitest, leaks a second Vitest into runner resolution,
requires Bun, or cannot run through the existing pnpm/Vitest lane. Effect-only
work may continue.

### Phase 1: Effect foundation and one scoped resource (3-5 engineer-days)

1. Add the internal Scope-to-`AsyncDisposable` bridge and typed lifecycle
   errors.
2. Carry Vitest cancellation into the fixture and interrupt all registered
   Effect fibers/scopes while the process remains alive.
3. Add fake `CommandExecutor`, `Clock`, and `PortAllocator` Layers.
4. Migrate `mcpMock()` acquisition/readiness/stop behind the existing API.
5. Fault-test failure before acquisition, during readiness, in the test body,
   on timeout/cancellation, and during finalization.

**Gate:** existing local specs are source-compatible; evidence output and skip
classification are unchanged; timeout interrupts the fiber; no process or port
remains after any in-process injected failure.

### Phase 2: local Den orchestration (5-8 engineer-days)

Migrate the local `server()` branch to a composed Effect program:

```text
requirements
  -> mocks + database + ports
  -> db push
  -> den-api + optional den-web
  -> health/auth readiness
  -> org/member fixtures
  -> Den handle
```

Keep organization provisioning as an application fixture in testkit; moving
the current private provisioning/deletion functions to `@openwork/behaviors`
is not part of this phase. Keep attached Den as a non-owning Layer. Preserve
existing logs and endpoint shapes.

**Gate:** targeted specs pass in both the normal path and injected failures;
database, services, mocks, and organizations are released in reverse order;
cleanup logging and verdict behavior match the existing handles. Dedicated
lifecycle specs assert that every finalizer is attempted. Any claim about
cleanup after process death additionally requires a local stale-resource
janitor and forced-termination proof.

### Phase 3: one Alchemy Daytona pilot (5-8 engineer-days)

1. Add the `OpenWork.DaytonaDesktopSandbox` resource/provider in a pilot-only
   internal package or module.
2. Use an in-memory state store for provider lifecycle tests and run-scoped
   local state for one real E2E journey.
3. Integrate it at `evals/runner/prepare-stack.ts`, where suite ownership and
   global cleanup actually live. Per-test consumers continue borrowing the
   prepared desktop sandbox and cannot delete it.
4. Add an explicit force-suite-preparation mode for the comparison. A single
   explicitly selected test currently bypasses suite preparation, so each arm
   must assert that it received a suite-owned slot and record whether the old or
   Alchemy preparer created it.
5. Put the provider behind an explicit pilot selection; default Daytona tests
   continue using the current suite provisioner during comparison.
6. Run the same selected journey through old and pilot paths against the same
   git ref and resolved Daytona context fingerprint.
7. Coordinate the current Den branch and Alchemy desktop branch so an outer
   failure waits for both acquisitions to settle, then destroys every owned
   resource before returning. Inject a Den failure while desktop creation is in
   flight and require the ownership audit to find nothing.
8. Simulate interruption after remote create, then prove both same-state resume
   through forced live reconcile and empty-state `read` recovery with the same
   recovery ID. Seed terminal state against stopped, missing, wrong-checkout,
   unready, and foreign-owned sandboxes; the foreign-owned case must record zero
   remote mutations. Prove the TTL janitor handles a run that is never resumed
   and does not delete an active newer retry sharing that recovery ID.
9. Keep Den provisioning on the current path; signed endpoint identity is a
   separate design gate.
10. Run overlapping retry attempts: lease loss must interrupt the old worker,
    reject its next host mutation, and prevent it from changing the new
    generation.

**Gate:** do not make Alchemy the default until the go/no-go criteria below are
met. Do not migrate desktop and Den sandboxes simultaneously in the first
pilot.

### Phase 4: decide, then expand or remove (2 engineer-days for decision)

Possible outcomes:

- **Effect only:** remove Alchemy dependencies and retain the scoped runtime
  refactor.
- **Selective Alchemy:** make the proven desktop sandbox provider the Daytona
  suite-preparation default; consider a separately reviewed snapshot provider.
- **Stop/revert:** keep the original lifecycle behind the stable facade and
  remove the pilot modules/state.

A full conversion of all testkit resources is not an expected outcome and
would require a new RFC.

## Go/no-go criteria

The pilot is a **go** only when all are true:

### Correctness

- Existing selected specs require no source changes.
- Every existing claim still has observable test evidence.
- Comparison evidence proves suite preparation ran and identifies the selected
  old or Alchemy preparer; an on-demand fallback cannot satisfy the pilot.
- External reuses and per-test borrows of suite resources are never deleted;
  suite global cleanup deletes the suite-owned sandbox exactly once.
- Owned resources are deleted after pass, assertion failure, readiness
  failure, and runner cancellation while the process remains alive.
- A post-create interruption has a tested recovery or TTL janitor path.
- Restored terminal state is forced through live reconciliation/preflight;
  stopped, missing, stale-checkout, unready, and foreign-owned resources cannot
  pass as a no-op.
- Read-only ownership/context/fence validation runs before forced reconcile and
  again before its first mutation; the foreign-owned case makes zero mutations.

### Reliability

- Repeated reconcile and delete are idempotent in provider lifecycle specs.
- A 20-run comparison leaves zero local processes/databases and zero owned
  Daytona sandboxes in both paths.
- Parallel workers use disjoint names and state; no state corruption or
  cross-run deletion is observed.
- Concurrent matrix shards receive distinct recovery identities, while a rerun
  of the same shard retains its identity.
- Retrying under a different Daytona organization/account/target fails before
  reconcile or delete and cannot leak or duplicate a resource silently.
- Overlapping attempts with the same recovery ID are fenced to one writer, and
  a TTL janitor cannot delete the active newer attempt's sandbox.
- Lease loss interrupts the old worker and blocks borrowed-host mutations; a
  takeover does not hand the same sandbox generation to both attempts.
- Injected Den failure during desktop creation waits for the desktop branch and
  leaves no suite-owned sandbox.
- A dedicated post-run ownership audit fails the pilot comparison if any
  sandbox remains. Generic disposer errors retain current log-and-continue
  behavior until a separate verdict-policy decision.
- Same-state resume and fresh-state `read` recovery both use a documented,
  retry-stable identity rather than a new timestamp.

### Performance

- Local testkit cold start regresses by no more than 10% at p50.
- The selected Daytona journey regresses by no more than 10% at p50 and 20% at
  p95, unless the added time demonstrably replaces flaky retry work.
- Dependency install and cache impact is measured and accepted explicitly.

### Maintainability

- The custom provider plus adapter is smaller and easier to fault-test than the
  imperative suite lifecycle it replaces.
- Error output remains at least as actionable as current timed-step and log-tail
  messages.
- At least two maintainers can modify the provider without relying on Alchemy
  internals or undocumented APIs.

Failing any ownership, endpoint-security, cleanup, state-concurrency, or
fixture-compatibility criterion is a no-go, not a follow-up to absorb during
rollout.

## Tradeoffs

### Benefits of Effect-first

- One model for acquisition, interruption, timeout, retry, and finalization.
- Dependencies become replaceable Layers, enabling deterministic failure-path
  tests without shelling out to real infrastructure.
- Typed operational errors make skip/fail classification deliberate.
- Local and Daytona implementations can share orchestration while differing at
  capability boundaries.
- Incremental adoption is possible behind Promise and `AsyncDisposable` APIs.
- OpenWork already has limited Effect 4 usage in `packages/codemode` and
  `ee/apps/den-api`, so the concepts are not entirely new to the repository.

### Costs of Effect-first

- Effect, Layer, Scope, Cause, and interruption add a learning curve.
- Poorly chosen services can turn straightforward code into indirection.
- Effect failure channels plus Vitest errors plus evidence verdicts create three
  taxonomies that must have one explicit boundary.
- Stack traces and debugging can worsen if every helper is wrapped rather than
  only lifecycle boundaries.
- Effect 4 is currently beta in this repository, so version pinning and upgrade
  work remain real.
- Alchemy's peer floor is newer than the Effect beta currently pinned elsewhere
  in OpenWork, creating temporary version skew even though evals are isolated.
- Scoped finalizers improve timeout and in-process failure handling but do not
  clean detached processes or databases after a killed runner; a janitor is a
  separate mechanism.

### Additional benefits of selective Alchemy

- Stable resource identity and a dependency graph replace implicit remote
  creation order.
- Plan/apply/destroy makes ownership and replacement decisions inspectable.
- Persisted intermediate lifecycle state can support recovery after partial
  remote provisioning.
- Provider lifecycle tests exercise create/update/replace/delete consistently.
- Stages give parallel runs an explicit isolation key.

### Additional costs and risks of Alchemy

- Alchemy's README labels the project alpha and its current v2 package is beta;
  breaking changes should be expected.
- The reviewed Alchemy/Effect Vitest adapter requires Vitest 4.1+, while
  OpenWork evals use Vitest 3.2; using the adapter would force an unrelated
  runner migration.
- It brings a broad IaC dependency graph into an otherwise narrow eval
  workspace.
- There is no built-in Daytona provider. OpenWork must own `read`, `diff`,
  `reconcile`, `delete`, auth, ownership, and upgrade compatibility.
- Most testkit resources are short-lived runtime resources; modeling them in
  persisted desired state would be conceptual and operational overhead.
- State introduces retention, locking, concurrency, corruption, and secret
  handling concerns that do not exist for in-memory handles.
- The reviewed local state backend has no configurable path; isolation requires
  a helper process or a correctly crash-safe custom State Layer.
- Retry reuse needs leasing and fencing across both IaC lifecycle calls and the
  test processes borrowing a sandbox, which may outweigh the provider benefit.
- Daytona Den preview hosts are expiring signed values and OAuth/MCP identity;
  persisting them as attributes or refreshing them on a no-op is unsafe without
  a dedicated endpoint-lifetime design.
- A custom provider can become the same homegrown provisioner behind a more
  complex interface. Alchemy is valuable only if the provider truly converges.
- Alchemy's documented test posture favors real cloud resources. OpenWork must
  retain deterministic witnesses because identity, failure, and policy claims
  require controlled observations.
- Alchemy cannot clean up after a dead runner without a subsequent command or
  external janitor.
- Adopting Alchemy's Vitest adapter directly could conflict with OpenWork's
  evidence fixture and skip mapping; this proposal avoids that coupling.

## Alternatives considered

| Option | Advantages | Disadvantages | Decision |
| --- | --- | --- | --- |
| Keep current implementation | No migration or dependency cost; familiar debugging | Manual rollback and concrete dependencies remain; no interrupted remote recovery | Valid fallback |
| Effect-only internals | Best fit for ephemeral resources; incremental; deterministic failure testing | No persisted desired state or post-process recovery | **Recommended baseline** |
| Effect + selective Alchemy | Adds recovery/plan semantics where remote resources justify them | Provider/state/maturity cost | **Recommended gated pilot** |
| Full Alchemy rewrite | One resource vocabulary everywhere | Poor fit for app fixtures and local processes; highest churn; risks evidence contract | Reject |
| Terraform/Pulumi/CDK for evals | Mature IaC/state ecosystems | Separate language/runtime or heavier bridge; still does not replace test orchestration | Reject for this scope |
| Kubernetes/Docker-only test environments | Strong declarative runtime where supported | Does not cover Electron/Daytona/attached Den and changes current lanes | Out of scope |

## Rollback strategy

- The public testkit facade remains the rollback seam throughout.
- Each migrated resource keeps one implementation selected at composition
  time; specs do not branch on implementation.
- Pilot resource names and state are isolated from current Daytona names.
- No production or shared long-lived state is converted.
- Reverting means selecting the existing provisioner, destroying pilot-owned
  resources, deleting pilot state, and removing Alchemy dependencies.
- Effect phases are independently reversible; no spec should require Effect
  types to compile.

## Open questions before Phase 3

1. Does the Daytona API expose stable metadata/tags, or only CLI names? This
   determines whether ownership-safe `read` is possible.
2. What exact workflow/job/matrix-shard/worker fields form a retry-stable and
   shard-unique recovery ID across local, GitHub, and Daytona lanes?
3. Which stable Daytona organization/account/target identifiers can be resolved
   without persisting credentials?
4. Where does the single-writer lease/fencing record live, and how is its
   heartbeat distinguished from a cancelled attempt? Can takeover isolate the
   new sandbox generation from old in-flight commands?
5. What is the concurrency/locking contract of the selected state store under
   parallel Vitest workers and retried CI jobs?
6. Can Alchemy's programmatic deploy/destroy path be used without installing a
   second Vitest fixture around the test, despite its transitive Effect 4
   `@effect/vitest` dependency?
7. Which exact Alchemy/Effect versions are mutually compatible with the eval
   workspace at implementation time?
8. Where should the ownership/TTL janitor run so it still executes when a CI job
   is cancelled and never retried?
9. Can a future Den provider avoid persisting signed preview hosts while
   preserving the exact issuer identity baked into the sandbox?

Whether generic cleanup errors should become Failed or Incomplete is a
separate evidence-policy question. The current implementation often logs and
swallows them; this migration preserves that behavior rather than silently
choosing a new verdict.

## Requested decision

Approve Phases 0-2 as an **Effect-first internal migration** and approve Phase
3 only as a time-boxed Alchemy experiment. Do not approve Alchemy as the new
testkit foundation until the provider meets every go/no-go criterion.

The likely end state is a hybrid:

```text
Vitest + OpenWork evidence contract
  + Effect for test resource orchestration
  + Alchemy for a small set of owned, recoverable remote resources
```

That uses each tool at the layer it is designed for and avoids replacing a
working E2E harness with an IaC engine that does not solve its core evidence
problem.

## References

OpenWork:

- `evals/README.md`
- `evals/packages/testkit/src/fixture.ts`
- `evals/packages/testkit/src/server.ts`
- `evals/packages/testkit/src/app.ts`
- `evals/packages/testkit/src/place.ts`
- `evals/packages/hosts/src/provision.ts`
- `evals/packages/test-evidence/src/ambient.ts`
- `evals/runner/prepare-stack.ts`
- `evals/runner/stack-env.ts`
- `evals/runner/stack-suite.ts`
- `.devcontainer/test-server-on-daytona.sh`

Alchemy (reviewed 2026-08-21):

- [Repository and alpha notice](https://github.com/alchemy-run/alchemy)
- [What is Alchemy?](https://alchemy.run/what-is-alchemy)
- [Custom providers](https://alchemy.run/infrastructure-as-code/custom-provider)
- [Resource lifecycle](https://alchemy.run/infrastructure-as-code/resource-lifecycle)
- [State store](https://alchemy.run/state-store)
- [Test harness](https://alchemy.run/testing/test-harness)
- [Local development](https://alchemy.run/environments/local-development)
- [Getting started and Node.js support](https://alchemy.run/getting-started)

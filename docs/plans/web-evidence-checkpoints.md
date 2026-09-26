# Forkable web evidence: branch-local implementation plan

> **Status (2026-09):** shipped, then simplified. Checkpoints are explicit
> (`user.checkpoint()`, `step(..., { checkpoint: true })`, end state of tests tagged
> `checkpoints`), capture no longer waits for the snapshot to be saved, CI selects
> tagged specs, and records publish through the normal evidence report. The
> synthetic probe, branch-format report and per-PR review deployment below were
> removed. See `packages/freestyle/README.md` for current behavior.

## Outcome and scope

An opted-in web proof runs its test controller on Blacksmith and its complete
web world (including Chromium) in Freestyle. A screenshot can carry a checkpoint.
A reviewer opens the screenshot in the evidence report and chooses **Open from
here** to create an independent, private fork, if that checkpoint still exists.

This is not a CI migration, a debugger for the test runner, continuous time
travel, or a promise of arbitrary instruction-level resume. Checkpoints exist
only at explicit captures. Desktop, real-provider stream continuation and
Infisical integration are out of scope initially.

## Corrections established by source inspection

- The existing app-web preview proxies hosted Den; it is NOT a self-contained
  Den + app snapshot. Do not reuse it as proof of isolated authentication.
- Freestyle prewarm checks out a pinned controller. It cannot prove new controller
  code from this branch. Leave that workflow and its trust boundary unchanged.
- `FREESTYLE_API_KEY` is referenced by existing CI and the repository secret name
  is present. That does not imply a local key, a usable account, or unlimited quota.
- Ordinary screenshots followed by snapshots are not atomic. UI state can change
  between them. Record ordering and a capture window; only claim matching state
  when an application-specific check or controlled fixture establishes it.
- A VM memory snapshot does not preserve connections to external systems. Even
  wholly in-VM streams require live verification before promising continuation.
- Snapshot-ready latency is not VM pause time. Storage accounting and billing
  deduplication are unresolved, not free or near-zero by assumption.
- Never silently pass a checkpoint-required proof when checkpoint creation fails.
  Preserve the PNG and diagnostics, mark capture failed, and fail that proof.

## M0 — live platform prerequisite (implemented first)

Files:
- `packages/freestyle/test/fixtures/checkpoint-stream.mjs`
- `packages/freestyle/src/checkpoint-probe.ts`
- `scripts/prove-freestyle-checkpoints.ts`
- `.github/workflows/evidence-checkpoint-proof.yml`

Boot a fresh public Ubuntu VM, with no public ingress or outbound rule and no
controller credentials in the guest. Run a synthetic producer and consumer in
two processes. Hold a real loopback HTTP stream after three chunks; retain ten
synthetic session names in RAM and a disk marker. Snapshot, delete the source,
and create two independent forks. Both must have identical process boot IDs and
partial data, continue the original connection without reconnecting, and finish
with the exact expected text. A disk mutation in one fork must not affect the
other or the immutable checkpoint. Delete both forks and snapshot.

The receipt explicitly identifies this as a **synthetic VM prerequisite**, not
an OpenWork E2E, browser proof or screenshot proof. Publish source SHA, individual
checks, snapshot-ready and fork-ready latency, and cleanup result. No raw SDK
errors, private links or credentials belong in the artifact. Provider TTL bounds
resources if the runner disappears; successful completion also requires cleanup.

Run from the PR head in a same-repository, non-bot PR through the existing
`pr-slow-specs` protected environment. No default-branch dispatch or merge is
required. Do not bypass the environment's human approval boundary.

## M1 — smallest complete evidence web world

Reuse `packages/freestyle` building/cache primitives but add an explicit isolated
evidence recipe. Boot only what the selected web journeys need:

- branch-head app, engine, Den and databases;
- synthetic identity and data;
- deterministic local inference fixture, no real inference credentials;
- Chromium, virtual display and authenticated noVNC;
- same-VM loopback URLs for internal browser, engine and mock traffic.

Pin app, migrations, test fixtures and controller to the same full SHA. Include
all runtime/controller inputs in cache identities. Never use `dev` fallback or
change a shared preview template in place. Keep build caches credential-free.
Do not inject the Freestyle control key into a snapshottable VM.

First prove a browser frame and an in-progress mock stream survive a fork. A
restore must not reseed, renew identities, reload the page or restart services.
New external viewer credentials must not disturb internal loopback sessions.
For the faithful checkpoint view, noVNC shows the restored tab; a fresh app URL
is a separate optional view, not the captured browser.

## M2 — evidence placement and capture

Wire a web-only placement adapter through `evals/packages/env` and existing CDP
handles. Blacksmith retains Vitest, test steps and publication. Do not generalize
all providers or change default placement. Unsupported requested combinations
fail before resource allocation.

Add an opt-in capture policy at the testkit screenshot boundary (not at every
step or every internal diagnostic image). Existing specs keep their calls;
checkpoint-enabled runs default explicit screenshots to checkpointed capture,
with a per-capture opt-out. Return evidence artifact references, not provider SDK
objects, from the testkit. The placement owns capture and lifecycle.

Record an optional versioned checkpoint reference alongside the PNG in
`evals/packages/test-evidence` and preserve it through `packages/review`:

- provider, opaque checkpoint ID, owning run/artifact ID;
- source SHA, recipe version, capture start/end, expiry;
- state: available / capture-failed / expired / deleted;
- capture semantics: controlled hold or best-effort window.

No access tokens or browser cookies in public metadata. A receipt must never
accept a caller-supplied arbitrary snapshot as authorized merely because the
caller knows its ID.

## M3 — fork backend and lifecycle

In `packages/freestyle`, expose checkpoint-specific launch separate from ordinary
preview refresh. Verify ownership, report association, source, lifetime and
recipe version. Each successful launch is a new fork with its own access token
and bounded lifetime. Reject expired or missing snapshots before publishing a
link. Preserve expiry/deletion errors as useful UI states.

The review server authorizes the visitor and resolves the checkpoint from the
trusted report. It holds the Freestyle credential; neither the browser nor a
static HTML artifact does. Add request deduplication, a small concurrency limit,
and launch rate limits. Rotation changes only the viewer boundary, not the
captured app session. CDP and noVNC remain authenticated and non-public.

Use provider expiry, owned-resource ledgers, synchronous teardown and bounded
orphan cleanup. Start with at most 10 checkpoints per proof, 24-hour retention
and a 60-minute fork lifetime. Validate these against actual provider limits;
make them configurable and visible. Retention is useful for passing proofs too,
not just failures. The feature must not depend on a sweeper merged to `dev`.

## M4 — actual click-to-fork on the unmerged PR

Read `DESIGN.md` before changing the review UI. In `apps/review`, preserve the
normal screenshot viewer and add availability plus **Open from here**. Show
launch progress, expiry and actionable launch failures. Opening an image alone
must not allocate a billable VM. Opening a fork must not alter the test result.

Deploy a **separate protected preview of the review app from this PR head**.
Publish this run's evidence to an isolated report namespace and link to that
preview in the PR evidence comment. Do not move the shared review alias or rely
on its older code. If Vercel Preview configuration is unavailable, a protected
branch-built review deployment is required before claiming this milestone;
a CLI-only fallback does not meet the requested end-user experience.

A helper CLI may support diagnosis, but it is not the acceptance criterion.
Anonymous requests must fail at the hosted auth boundary. Authorized users must
be able to open the report and launch the restored browser without a local key.

## M5 — acceptance journey on this branch

Add an agent-first testkit journey following the write-a-spec skill:

1. Boot the exact branch SHA into the isolated evidence web world.
2. Create ten actual OpenWork sessions and capture screenshot A + checkpoint.
3. Start a deterministic mock reply; hold it at a known partial response; capture B.
4. Allow the original journey to finish, then destroy the original VM.
5. Open the branch-built review app, select A and click Open from here.
6. Assert the restored tab is signed in and has the ten expected sessions.
7. Select B and fork it; assert the captured partial text appears before continuing.
8. Release the mock barrier in the fork and assert the remaining stream arrives
   on the restored connection without reload/reconnect or duplicated output.
9. Launch a second fork, modify the first, and assert isolation.
10. Verify expiry, unauthorized launch rejection and cleanup; retained human
    inspection checkpoints use the configured bounded retention.

The stream barrier makes this deterministic. A free-running stream can advance
before a reviewer connects, so do not promise that every restored stream will
wait visibly at the pictured moment without an explicit hold mechanism.

## M6 — branch-only CI and publication

Extend the existing PR proof selection with one explicit checkpoint option.
Keep ordinary Blacksmith/local proof untouched. The enabled lane checks out the
exact PR head, installs without privileged lifecycle scripts, then runs only the
selected web journey using a scoped provider credential. Same-repo guards and
the existing protected environment gate execution of secret-bearing PR code.

Controller, world, schemas, testkit, publisher and review preview must all come
from that head. Do not rely on prewarm, default-branch workflow_run code, a new
workflow_dispatch registration, or the shared review deployment. The proof
must publish a branch-local report even if the existing publisher cannot yet
understand the new metadata. Re-run the exact landable head after each change.

Required negative tests include opt-out (zero snapshot calls), wrong placement,
malformed metadata, unauthorized snapshot IDs, expiry, capture failure with PNG
retained, failed launch cleanup, duplicate launch requests and a canceled run.

## Secrets now; Infisical later

Do not configure or call Infisical for this work. Define a small deployment
boundary: host/controller reads `FREESTYLE_API_KEY` from its environment, and
publication/hosting use their existing credential interfaces. Test guests get
synthetic app identity only. Never serialize host credentials into checkpoints.

Later, an Infisical wrapper can provide the same host environment variables,
scoped separately for CI and the review backend. This changes credential delivery,
not checkpoint code or evidence formats. Production inference and connector
credentials remain out of the snapshot feature.

## Completion bar

The feature is complete only when an unmerged PR's own report lets an authorized
reviewer click a screenshot and enter the verified, independent browser fork.
A green synthetic M0, a snapshot ID, a mock launch button, or a CLI command alone
does not meet that bar. Report progress by these milestones rather than equating
infrastructure probes with product E2E coverage.

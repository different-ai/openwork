# Core preview handoff (CI only)

Core's required verdict is its assertions and finalized native test/CLI records.
A screenshot is evidence without a reopenable VM. Core keeps the opening body
screenshot, but captures only the final state. Other journeys retain Start/End.

On Daytona, `OPENWORK_DAYTONA_PREVIEW_OWNER=<run>-<attempt>-core` opts Core into
this lifecycle:

1. The source's creation request includes owner, source SHA and its own unique
   name, so interrupted builds and lost creation responses remain discoverable.
   Its name distinguishes a fork inheriting source labels from the actual source.
2. Before requesting a fork, persist a credential-free control-plane label receipt
   (also a private guest file) containing checkpoint, screenshot hash, source ID
   and deterministic random fork name. Recovery works even when the source is
   stopped. Write the usual checkpoint manifest before capture, preserving the
   normal restore/auth checks.
3. Capture the fork, label it, and return. No snapshot request, polling promise or
   background timer runs in the producer. Close browser/CDP connections; retain
   the source because Daytona will not release it while its fork exists.
4. Upload finalized native records with an explicitly pending preview annotation,
   not a checkpoint that claims to be reopenable. Assertion errors remain errors.
5. The **Optional Core preview finalization** job reads provider-owned receipts,
   validates SHA/ownership/manifest, requests a memory save, polls `active` with a
   ten-minute budget, deletes the fork and polls until it is gone, then deletes
   and confirms deletion of the source. DELETE acknowledgement alone is not
   release (see Daytona's SDK `Sandbox.delete` documentation). An already
   accepted snapshot request is polled, never blindly repeated. A pre-POST
   control-plane marker prevents replay after controller interruption. Crashing
   between the marker and POST sacrifices only the optional preview, then cleans
   up after a bounded wait. Daytona documents that client timeouts do not cancel
   server operations ([SDK configuration](https://www.daytona.io/docs/en/typescript-sdk/daytona/#daytonaconfig)).
6. Reopen one private reviewer copy after confirmed source teardown and assert
   Core's final model reply is still on screen; release that copy. Only snapshots
   passing readiness and this live restore check annotate matching image hashes/IDs.
   Failed saves/restores retain images and verdicts. The job is visibly red on provider failure;
   it is not the mandatory Core check. Original attempt-bound artifact names and
   CLI records are retained for Evidence review's existing native run binding.

A missing producer artifact triggers cleanup rather than publication. A canceled
workflow might skip even an `always()` job, so **Core preview recovery** runs from
trusted default-branch code on workflow completion and hourly. It checks the
GitHub producer path, event, completed status, attempt and source SHA before
releasing labelled resources. The pre-request receipt recovers a fork even if
its POST response or subsequent relabelling was lost. Unverifiable resources are
retained and reported, not deleted speculatively. Rejected fork deletion retains
the source for a later recovery. Recovery never downloads or executes PR code.

Provider REST requests have their own finite retry/timeout limits; these can add
up to three minutes beyond the polling budget on an unavailable API. Job timeouts
bound the controller; hourly recovery handles interrupted controllers. The
existing provider idle stop/delete policies remain the final backstop.

## What gets faster

The Core check no longer waits for memory snapshot storage. It still pays for
world preparation, assertions, screenshot matching hold, fork capture and artifact
upload. The optional job starts afterward and pays setup, save/poll and teardown.
Evidence review still triggers on **whole-workflow completion**, so full evidence
latency is not a promised 50% reduction; it may increase by finalizer setup time.

## Verification

- `pnpm --filter @openwork/daytona-evidence test`: provider lifecycle, errors,
  timeout, cancellation/lost response, retry cleanup, restore after source deletion;
  separate producer/finalizer subprocesses against a durable fake provider.
- `node --test .github/scripts/core-preview-handoff.test.mjs`: CI ownership,
  immutable mandatory verdict, artifact attempts, cancellation recovery wiring.
- `pnpm evals:pr specs/checkpoint-runtime.test.ts`: opening screenshot retained,
  only final state captured, other journeys unchanged.
- `pnpm evals:pr specs/evidence-checkpoint.test.ts`: pending previews cannot be
  reopened, readiness/SHA/hash binding, failed assertion verdict not softened.

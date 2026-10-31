# Testing without blocking unrelated work

Unit and API tests live next to the code they test. End-to-end coverage is the
nine journeys in `evals/core` (see `evals/README.md`). Install both
workspaces with `pnpm install --frozen-lockfile` and
`pnpm --dir evals install --frozen-lockfile` first. Use Node 24, Bun 1.3.14,
pnpm 11.4.0, and the OpenCode version in `constants.json` on PATH, matching CI.

## What blocks a merge

The `openwork-tests-required` check keeps its existing name and fails closed.
For ordinary code changes it requires two independent Linux jobs:

- **Eval framework:** the headless runner typecheck, spec lint
  (`pnpm --dir evals lint:specs`) and its rule fixtures
  (`pnpm --dir evals run test:framework`).
- **Packaging:** outbound-access declarations, the server's actual Node-target
  plugin build, Electron's IPC contract typecheck, and the packaged desktop
  smoke.

Model-snapshot-only and docs-only PRs keep their existing dedicated validation.
New commits cancel obsolete runs on the same PR. Dev pushes still run the core
and packaging checks.

To expand coverage, add a step to a core journey in `evals/core`. A failing journey
must be diagnosed and fixed, not retried until green or silently ignored.

## Broader coverage

The test-framework checks (`pnpm evals:check`) also run on every PR in "Unit
tests (test framework and contract tooling)". The core journeys other than
core-chat run on every `dev` push and nightly ("Core journeys"), and on a PR only
when it changes them. Nightly at 07:37 UTC (or through **Run workflow** on a selected branch)
the same workflow runs all PR specs (`pnpm evals:pr`, Linux, with MySQL and the
bundled OpenCode binary) and the engine smoke (`pnpm test:e2e`, Linux and macOS).
Packaging can be reproduced with `pnpm --filter openwork-server build` and
`pnpm --filter @openwork/desktop typecheck:electron`. Check the macOS nightly
before releases; it is not a PR prerequisite. The core journey and every
Freestyle world path also run nightly ("Freestyle world check"); the old
"Product journeys" and "Test reliability" nightlies were retired in October 2026.

A skipped journey is incomplete coverage, even if a runner exits successfully.
Do not describe a run containing skips as full proof.

## Why this changed

An audit of OpenWork Tests runs created August 28–September 3, 2026 (UTC)
found 159 failures among 632 runs, including 17 awaiting approval. Among the
615 success/failure results, 25.9% failed. These are run counts, including
repeated branch updates, not a measured flake rate.

Sampled failure logs show different problems that need different fixes:

- [September 3](https://github.com/different-ai/openwork/actions/runs/33814401384):
  `spec-impact` and `spec-quarantine` inventory assertions failed on both OSes
  while 115/116 other spec files passed. Those specific specs have since been
  removed; keeping test-framework bookkeeping out of the default gate prevents
  rebuilding the same barrier elsewhere.
- [August 28](https://github.com/different-ai/openwork/actions/runs/33215552704):
  a compatibility spec spawned another test runner, obscuring the underlying
  failure behind a wrapper assertion.
- [PR #4442](https://github.com/different-ai/openwork/pull/4442): the shared suite
  failed on the same engine-retirement timing assertion seen in a
  [dev run](https://github.com/different-ai/openwork/actions/runs/33907568505).
  [PR #4439](https://github.com/different-ai/openwork/pull/4439) independently
  repairs that race. Core coverage still exercises real engine eviction and
  reload behavior; the broad test is retained.
- The separate [SDK check on #4442](https://github.com/different-ai/openwork/actions/runs/33916924365)
  failed when schema generation connected to MySQL at `127.0.0.1:3306` without a
  database. That is a setup dependency to fix in the SDK change, not a reason
  to suppress schema-drift validation. This CI cleanup does not fix that branch.

This change adds no tests of tests and no new test files. Runtime savings must
be measured after rollout; reducing four broad PR jobs to two focused jobs is
not itself evidence of a particular wall-clock improvement.

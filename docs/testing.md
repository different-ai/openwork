# Testing without blocking unrelated work

Run `pnpm test` (alias: `pnpm test:core`) before a PR. Install both workspaces
with `pnpm install --frozen-lockfile` and
`pnpm --dir evals install --frozen-lockfile` first. Use Node 24, Bun 1.3.14,
pnpm 11.4.0, and the OpenCode version in `constants.json` on PATH, matching CI.
The core suite uses local fixtures and scripted providers; no cloud account,
provider key, Docker daemon, or running Den database is required.

## What blocks a merge

The `openwork-tests-required` check keeps its existing name and fails closed.
For ordinary code changes it requires two independent Linux jobs:

- **Core regressions:** session admission, streaming and reconnects, permission
  state, attachments, provider credentials, and Connect reconciliation in the
  client; real server routes for threads, groups, proxying, folder permissions,
  upload approval, artifact I/O, cloud configuration, engine eviction and
  reloads; token scope and export safety; Den authentication; desktop workspace
  persistence, archives, links, credential keys, automation execution, process resilience, and TLS.
  Three existing real-engine journeys additionally check remembered thread
  approvals, effective permission attribution, and PDF model routing.
- **Packaging:** outbound-access declarations, the server's actual Node-target
  plugin build, and Electron's IPC contract typecheck. A test failure cannot
  prevent this independent job from reporting a packaging regression.

Model-snapshot-only and docs-only PRs keep their existing dedicated validation.
New commits cancel obsolete runs on the same PR. Dev pushes still run the core
and packaging checks. PRs no longer pay for two OS copies of the broad suites.

The package `test:core` scripts are the selection. There is no second inventory,
selection generator, coverage ratchet, or test asserting that inventory matches
itself. To expand coverage, extend an existing test for a core failure mode.
Add a test to the gate when it catches an observable regression in a critical
journey, runs deterministically with declared prerequisites, and earns its cost.
Do not add source-text/layout assertions, test-runner wrappers, or bookkeeping
checks to this gate. A failing core test must be diagnosed and fixed, not retried
until green or silently ignored.

## Broader coverage

The same OpenWork Tests workflow runs the broad app, server, Den, desktop,
release, test-framework, PR-spec, and engine-smoke suites on Linux and macOS at
07:37 UTC daily, or through **Run workflow** on a selected branch. Each suite
reports even if an earlier suite fails; failures still make that run red.
`pnpm test:extended` runs those test suites locally. Packaging can be reproduced
with `pnpm --filter openwork-server build` and
`pnpm --filter @openwork/desktop typecheck:electron`.

Use the full package test command when changing its internals, and
`pnpm test:eval-runner` when changing the test framework. These tests remain in
the repository. Moving them out of the universal gate means regressions outside
the selected core may first be detected by targeted validation or the nightly
run. Check the macOS nightly before releases; it is no longer a PR prerequisite.
The existing Daytona E2E and nightly flake-report workflows are unchanged.

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

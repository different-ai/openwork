# Testing without blocking unrelated work

Unit and API tests live next to the code they test. End-to-end coverage is the
nine journeys in `evals/core` (see `evals/README.md`). Install both
workspaces with `pnpm install --frozen-lockfile` and
`pnpm --dir evals install --frozen-lockfile` first. Use Node 24, Bun 1.3.14,
pnpm 11.4.0, and the OpenCode version in `constants.json` on PATH, matching CI.

## What blocks a merge

PRs run one quick check ("Quick check", `quick-check.yml`); its
`openwork-tests-required` context is the only required test check. It covers
the highest risks only, in about a minute:

- **Static guards:** CI selection and policy tests, the outbound access
  manifest, and the feature registry with its Helm chart.
- **Typecheck of shipped code:** every changed package and every package that
  depends on it, test files left out (`.github/scripts/typecheck-shipped.mjs`),
  plus Electron main when the desktop is affected.
- **Imports Node loads from source:** Den API and the Gateway run in plain Node
  and load some workspace packages from TypeScript source. Node resolves less
  than tsx, bundlers and the typecheck do, so an import that works everywhere
  else can fail the deploy. `pnpm check:node-source-imports` follows each
  service's runtime imports into that source, on every PR (see "Modules Node
  loads from source" in `AGENTS.md`).
- **Den API auth and permission tests** and audit route coverage, when Den API
  inputs change (`pnpm --filter @openwork-ee/den-api test:api:security`).

- **Desktop build:** the server bundled the way packaged builds do, and
  Electron main typechecked against the IPC contract.

These are the critical checks, and the only ones that gate anything. They run
on every PR, where they gate the merge, and again on every dev push, where the
alpha build and the release refuse a commit they did not pass
(`.github/scripts/require-quick-check.mjs`). Keep the set under two minutes:
a check that cannot block a merge and a release does not belong in CI, and a
test nothing runs should be deleted. The rest is nightly or on demand:

| Check | Where it runs |
| --- | --- |
| Test-framework checks, engine smoke tests, docs and model snapshot validation | Nightly and on demand ("Nightly regression") |
| Core journeys | Nightly and on demand ("Core journeys"); core-chat nightly in "Freestyle world check" |
| Changed one-off proofs (`evals/proofs`) | Never automatically; by hand with `gh workflow run pr-proof.yml --ref <branch> -f pr=<n>` |
| Packaged desktop build and boot | Before every alpha release ("Packaged desktop smoke"); macOS update install nightly |
| CodeQL analysis | Every dev push and weekly (PRs upload empty results for the merge rule) |
| EE images, Helm, plugin, Terraform, installers, evidence tooling | Dev pushes that change them; EE health checks nightly |

A red nightly run is a regression in what merged that day: fix or revert it first.

To expand coverage, add a step to a core journey in `evals/core`. A failing journey
must be diagnosed and fixed, not retried until green or silently ignored.

## Broader coverage

The test-framework lint (`pnpm evals:check`) is not run in CI; run it locally
when changing the framework. Nightly at 07:37 UTC (or through **Run workflow** on a selected branch)
the same workflow runs all PR specs (`pnpm evals:pr`, Linux, with MySQL and the
bundled OpenCode binary) and the engine smoke (`pnpm test:e2e`, Linux and macOS).
Packaging can be reproduced with `pnpm --filter openwork-server build` and
`pnpm --filter @openwork/desktop typecheck:electron`. Check the macOS nightly
before releases. The core journey and every
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

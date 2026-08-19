---
name: prove-a-pr
description: Prove a PR, prepare merge verification, publish all evidence, check a stacked PR. Use when declaring a PR Passed, Incomplete, or Failed.
---

# Skill: Prove a PR

## Verify the tree that will land

- Run every check on the PR head after its final rebase or cherry-pick. Re-run
  and re-publish after any history rewrite; test runs are bound to a commit SHA.
- Before merging a stacked PR, inspect
  `gh pr view <n> --json baseRefName,headRefName,headRefOid`. If its base PR
  merged first, the stack can merge into the feature branch instead of `dev`;
  GitHub then recreates commits with new SHAs and orphans their test evidence.
- Detect stray commits with `git log --oneline <branch> ^origin/dev`. Remedy a
  bad stack by cherry-picking only the intended commits onto current `dev`, then
  re-run every check and re-publish every test run.

## Produce the agent-first verdict

- Use `write-a-spec` and `run-tests`. Prose, screenshots, and recordings never
  decide pass/fail.
- Prefer Daytona for agent-first verification. Attempt the Daytona lane first
  when its credentials and service access are available; otherwise run the same
  checks locally. Missing Daytona credentials, tooling, or service access is an
  expected OSS contributor fallback, not a failed check.
- Determine fallback eligibility before execution: use local only when Daytona
  credentials, tooling, or service access are unavailable, or when the user
  explicitly requires local.
- Once Daytona is available and selected, a runtime, test, or product failure
  does not make Daytona unavailable. Diagnose and repair any red or incomplete
  Daytona run in Daytona; never switch lanes to turn the verdict green.
- A local reproduction may aid diagnosis, but it is not fallback and cannot
  replace the required Daytona verdict.
- Record whether each check ran on Daytona or locally. When falling back, state
  the unavailable Daytona prerequisite without exposing secret values.
- Give every claim an observable assertion and visible test evidence.
- Report only `Passed`, `Incomplete`, or `Failed`. Always quote exact commands,
  exit codes, and passed/failed/skipped counts.
- Call a failure pre-existing only after the same command demonstrates it in a
  clean `origin/dev` worktree. Quote the control command and matching failure.

## Satisfy local fallback prerequisites

```bash
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm dev:den:mysql
```

- Local `server()` requires MySQL at `127.0.0.1:3306`; unbuilt workspace
  dependencies can make den-api imports fail.
- If the checkout path contains spaces, set `OPENWORK_EVAL_SURFACES_DIR` to a
  space-free path; node-gyp and electron-rebuild otherwise fail.
- Set `OPENWORK_EVAL_E2E_TESTS=1` for app-driving E2E tests.

## Publish human verification

- The orchestrator owns publishing after the verdict. After a multi-test run,
  publish each head-matching test run:

```bash
pnpm evals:e2e --publish --pr <n> --test-run <dir|name>
```

- Confirm the sticky PR comment shows one section for every claimed test.
- Never use `--force` to paper over a SHA mismatch; re-run on the PR head.
  Reserve it for deliberately publishing historical or red test evidence, and call
  that exception out in the report and PR comment.

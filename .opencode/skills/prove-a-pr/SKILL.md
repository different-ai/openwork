---
name: prove-a-pr
description: Prove a PR, prepare merge verification, publish all evidence, check a stacked PR. Use when declaring a PR Passed, Incomplete, or Failed.
---

# Skill: Prove a PR

## Verify the tree that will land

- Run every check on the PR head after its final rebase or cherry-pick. Re-run
  and re-publish after any history rewrite; tapes are bound to a commit SHA.
- Before merging a stacked PR, inspect
  `gh pr view <n> --json baseRefName,headRefName,headRefOid`. If its base PR
  merged first, the stack can merge into the feature branch instead of `dev`;
  GitHub then recreates commits with new SHAs and orphans their tapes.
- Detect stray commits with `git log --oneline <branch> ^origin/dev`. Remedy a
  bad stack by cherry-picking only the intended commits onto current `dev`, then
  re-run every check and re-publish every tape.

## Produce the agent-first verdict

- Use `write-a-spec` and `run-tests`. Prose, screenshots, and recordings never
  decide pass/fail.
- Prefer Daytona for agent-first verification. Attempt the Daytona lane first
  when its credentials and service access are available; otherwise run the same
  checks locally. Missing Daytona credentials, tooling, or service access is an
  expected OSS contributor fallback, not a failed check.
- Record whether each check ran on Daytona or locally. When falling back, state
  the unavailable Daytona prerequisite without exposing secret values.
- Give every claim an observable assertion and a visible testkit tape.
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
- Set `OPENWORK_EVAL_APP_SPECS=1` for app-driving specs.

## Publish human verification

- The orchestrator owns publishing after the verdict. After a multi-spec run,
  publish every head-matching tape with:

```bash
pnpm fraimz:publish -- --pr <n> --all
```

- Confirm the sticky PR comment shows one section for every claimed spec.
- Never use `--force` to paper over a SHA mismatch; re-run on the PR head.
  Reserve it for deliberately publishing a historical or red tape, and call
  that exception out in the report and PR comment.

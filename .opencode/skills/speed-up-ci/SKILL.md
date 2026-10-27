---
name: speed-up-ci
description: CI is slow, time to green, how long do checks take, p50/p90, make CI faster, speed up a job or spec, hillclimb CI. Use to measure PR CI time, find where a job's seconds go, and land speedups one measured change at a time without weakening any check.
---

# Skill: Speed up CI

CI speed is a measured number, not a feeling. Measure it the same way every
time, find where the seconds actually go, change one thing, measure again,
keep it only if the number moved and every check still guards what it did.

## 1. Measure time to green

```bash
node .github/scripts/ci-time-to-green.mjs --hours 24            # all PRs
node .github/scripts/ci-time-to-green.mjs --hours 6 --branch-prefix perf/ci-x --json
```

- `required`: push → last merge-gating check green (`openwork-tests-required`, `warden-clear`).
- `full`: push → last GitHub Actions check green. "Evidence preview" is ignored (a link, not a test).
- Failed or unfinished commits are excluded from the percentiles and counted separately.

Record the baseline (p50/p90/p99 and `n`) before changing anything. Compare
p50/p90 with at least ~20 commits; one PR's run is a data point, not a trend.

## 2. Find where the seconds go

Never guess from YAML. Read the timings GitHub and the test kit already record.

```bash
# Every job and step of a run, with durations
gh run view <run-id> --json jobs --jq '.jobs[] | "\(.name)", (.steps[] | "  \(.name)")'
gh api repos/different-ai/openwork/actions/jobs/<job-id> \
  --jq '.steps[] | "\(((.completed_at|fromdate)-(.started_at|fromdate)))s \(.name)"'
# Full log (strip colours)
gh api --allow-escape-sequences repos/different-ai/openwork/actions/jobs/<job-id>/logs | sed 's/\x1b\[[0-9;]*m//g'
```

For e2e specs, download the run's `pr-proof-*` artifacts and read
`test-runs/*/test-run.json`: every `trace` entry has a `stage`, `channel`,
`verb` and `ms`. Sum `ms` by `(stage, channel, verb)`:
`world/seed/den|desktop|appWeb` is time spent starting services; `body/*` is
the test. Compare `createdAt`/`closedAt` with the first and last trace entry
to see setup and teardown the trace does not cover.

Things that look slow but are not the cause until measured: runner pickup
(usually ~3s), the test's own assertions. Things that usually are: starting
services per test, rebuilding the same commit in several jobs, waiting on
something no assertion uses, repeated setup in every matrix job.

## 3. Choose the change: strongest rung first

Work down this list (the classic performance mantras) and stop at the first
rung that reaches the target:

1. **Don't do it.** Remove waits and work whose result nothing checks
   (e.g. waiting for a reviewer snapshot to save before reporting a verdict).
2. **Don't do it again.** Reuse a result whose inputs are byte-identical:
   build once per commit and share it; skip a suite whose input hash already
   passed. Failures are never reused.
3. **Do it less.** Start one service per job and isolate tests inside it
   (one organization per test) instead of one service per test.
4. **Do it later.** Move work that need not block a push into the merge queue.
5. **Do it when nobody is waiting.** Pre-warm images and worlds on `dev`.
6. **Do it concurrently.** Shard long serial steps.
7. **Do it cheaper.** Faster flags, in-memory databases, fewer statements.

Rung 7 alone rarely gets far: folding the Den API test schema DDL and an
in-memory MySQL saved 18s on a 134s step. Rungs 1-3 remove minutes.

## 4. The loop

- One hypothesis per change, naming a mechanism ("den-web runs `next dev`
  and recompiles per test"), never "try caching".
- Measure before and after on CI, against a control on the same runner type
  at about the same time (another PR on current `dev`, or the same job on
  `dev`). Laptop wall times are not evidence: other work on the machine
  moved the same suite between 94s and 147s.
- Keep a change only when the number moves past noise and every gate stays
  green. Otherwise revert it completely and record why.
- Log every attempt, kept or not, in a `decision.tsv` outside the repo:
  `id, hypothesis, change, before, after, delta, tests, verdict, note`.
- Independent hypotheses can run in parallel, each in its own worktree and
  PR. Give each lane the baseline, the measured facts and these rules.

## Guardrails

- **Never weaken a check for speed.** No skipped specs, no soft-failing
  steps, no looser assertions. A moved check must still run before merge
  (e.g. in the merge queue) and fail for the same defects.
- **Never make the shared clone shallow.** `git fetch --depth=1` in any
  worktree writes `.git/shallow` for every worktree and the main checkout;
  rebases then replay the whole history. CI scripts that fetch with depth 1
  are for CI only. If it happens: confirm the parents of the shallow commit
  exist (`git cat-file -e`), move `.git/shallow` aside, run
  `git fsck --connectivity-only`.
- Work in a worktree from fresh `origin/dev`; do not touch someone else's
  checkout, branch or running containers. Start your own MySQL on a free
  port with a unique name, and remove it afterwards.
- Den API tests assume UTC: run them locally with `TZ=UTC`, or the
  hourly sign-in tests fail for reasons unrelated to your change.
- Check open PRs for the same files before starting (`gh pr list`), and
  re-measure after rebasing onto a `dev` that changed the job you measured.
- A red `dev` invalidates every comparison: fix or wait for it first
  (`diagnose-a-red-run`).

## Evidence in the PR

Name the job and step, the control run and your run, and the seconds:
"Run Den API security tests: 134s → 116s (run A vs run B, same runner)."
State `Release note: none`. Follow `open-a-pr`.

---
name: diagnose-a-red-run
description: Test is red, typecheck failed, CI job failed, flaky, timed out, was this already broken. Use to classify any failing check before changing code or calling it pre-existing.
---

# Diagnose a Red Run

Classify before changing code. Report per **Honest Verdict**.

## 1. Capture

- Exact command, commit SHA, exit code, passed/failed/skipped counts. Quote the first actionable failure.
- Kind: testkit spec, typecheck, build, lint, or CI job. For CI, run the first failing job's exact command locally before widening scope.
- For a testkit failure, read the run's last unvalidated artifacts before touching code.

## 2. Control

Per **Clean Control**, run the exact command in a clean baseline with equal tools, env, services, flags and secrets:

```bash
git fetch origin dev
git worktree add /tmp/openwork-dev-control --detach origin/dev
# prepare the same prerequisites, run the exact command, quote SHA, exit code, counts, failure text
git worktree remove /tmp/openwork-dev-control
```

Then label it: pre-existing (control fails the same way), introduced, environment-specific, or unresolved. Flaky needs repeats on both sides.

## 3. Known signatures

| Signature | Meaning |
|---|---|
| Vision disagreement on identical pixels | Claim wording or product ambiguity. Make one unambiguous |
| Timeout with an On-screen dump | Read it. It names the state (e.g. `/session` steer-back race) |
| `403 INVALID_ORIGIN` | Den trusted origins |
| Authorize URL hits the real provider | Den booted without mock env |
| Teardown `403 fresh_auth_required` | Session aged. A `freshSession` retry exists |
| `EADDRINUSE` in logs while `/health` is 200 | A zombie kept the port. `tsx watch` orphans its Node child |

## Red core journey (`pr-proof.yml` "Core journey")

- Open the job summary's "Freestyle world" table. It names the path (reused, fast, full build) and why.
- World preparation failed: read the "builder log" group. A failed fast path already fell back to a full build, so this is a real build or boot failure.
- Journey failed: read the printed on-screen state, then rerun the `run-tests` core journey command on the same pushed commit.

## Environment hygiene

- Kill by port or process group, never by name. Electron zombies respawn from a root process.
- Leaked state pollutes organizations. Delete leftover connectors between runs.

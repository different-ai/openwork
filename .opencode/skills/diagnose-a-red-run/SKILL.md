---
name: diagnose-a-red-run
description: Test is red, typecheck failed, CI job failed, flaky, timed out, was this already broken. Use to classify any failing check before changing code or calling it pre-existing.
---

# Skill: Diagnose a Red Run

## Capture the branch failure

- Record the exact command, commit SHA, exit code, and passed/failed/skipped
  counts. Quote the first actionable failure; do not summarize it away.
- Classify the check: testkit spec, unit suite, typecheck, build, lint, or CI job.

## Run a clean control

Never call a failure pre-existing from memory or from a modified checkout.

```bash
git fetch origin dev
git worktree add /tmp/openwork-dev-control --detach origin/dev
# In that clean worktree, prepare the same prerequisites and run the exact command.
git worktree remove /tmp/openwork-dev-control
```

- Keep tool versions, environment, services, flags, and secrets equivalent.
- Quote the control command, `origin/dev` SHA, exit code, counts, and matching
  failure text.
- Classify as pre-existing only when the clean control demonstrates the same
  failure. Otherwise classify it as introduced, environment-specific, or
  unresolved. A non-reproducing control is not proof of flakiness; repeat both
  sides before using that label.

## Classify by signature

- Unit/type/CI-only failure: inspect the first failing job and run its exact
  command locally before broadening scope.
- Vision disagreement on identical pixels: claim wording or product ambiguity.
  Make the product unambiguous or make the claim factual.
- Timeout with an On-screen dump: read it. It names the state; for example,
  `/session` can expose a steer-back race.
- Auth `403 INVALID_ORIGIN`: inspect Den trusted origins.
- Authorize URL points at the real provider: Den booted without mock env.
- Teardown `403 fresh_auth_required`: the session aged; a `freshSession` retry
  exists.

## Environment forensics

- Kill by port, not process name. `tsx watch` can orphan its Node child, which
  keeps the port while `/health` lies.
- `EADDRINUSE` in logs while health returns 200 means a zombie survived.
- Electron zombies can respawn from a root process; kill the process group.
- Leaked state pollutes organizations; delete leftover connectors between runs.

For a testkit failure, read the tape's last unclaimed takes before touching
code. Publish a useful red tape with `publish-evidence`; it remains human audit,
not a passing verdict.

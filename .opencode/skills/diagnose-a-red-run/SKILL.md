---
name: diagnose-a-red-run
description: Test is red, flaky, timed out, was this already broken. Use to classify and diagnose a failing @openwork/testkit spec before changing code.
---

# Skill: Diagnose a Red Run

## First establish ownership

The first question is always: is it red on `origin/dev` too? Materialize the
baseline with `git show origin/dev:<file> > zz-baseline`, run it, then delete
the baseline. Introduced versus pre-existing determines the response; never
hand-wave a failure as unrelated.

## Classify by signature

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

The tape ends at the stuck screen. Read its last unclaimed takes before
touching code.

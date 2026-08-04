---
name: run-tests
description: Run the tests, run e2e locally, run on Daytona, why is this skipped. Use for running and interpreting @openwork/testkit specs.
---

# Skill: Run Tests

## Choose the lane

- `pnpm evals:spec` is the app-less PR lane.
- App specs require `OPENWORK_EVAL_APP_SPECS=1` and run with
  `vitest --project stack <file>`.
- Set `OPENWORK_EVAL_DAYTONA=1` to place resources in sandboxes. Leave it unset
  for isolated local instances.
- Local `server()` requires Docker MySQL from `pnpm dev:den:mysql`.

## Read the verdict

Report exactly: passed, failed, or `skipped — needs: X`. A skip must name the
missing environment requirement. A green suite containing skips is not proof.

## Iterate without weakening proof

- Run one spec at a time.
- While iterating, reuse a warm Den with `OPENWORK_EVAL_DEN_API_URL`.
- Before declaring green, cold-boot through local `server()`.
- Inject secrets with `infisical run --silent --`; never print or echo values.

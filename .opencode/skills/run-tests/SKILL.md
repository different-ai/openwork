---
name: run-tests
description: Run the tests, run one spec, run e2e locally or on Daytona, investigate a skipped spec. Use for executing @openwork/testkit agent-first verification.
---

# Skill: Run Tests

## Run the landable tree

- Check out the exact PR head that will land. After any rebase or cherry-pick,
  discard the old verdict and run again.
- Run one test at a time so each failure and ambient test evidence has one owner.

## Choose the execution environment

- Prefer Daytona when Daytona credentials, tooling, and service access are
  available. Set `OPENWORK_EVAL_DAYTONA=1` for that run.
- If Daytona is unavailable, run the same spec locally with
  `OPENWORK_EVAL_DAYTONA` unset. Missing Daytona access is an expected path for
  OSS contributors and does not make the verdict fail or incomplete.
- Determine fallback eligibility before execution: use local only when Daytona
  credentials, tooling, or service access are unavailable, or when the user
  explicitly requires local.
- Once Daytona is available and selected, a runtime, test, or product failure
  does not make Daytona unavailable. Diagnose and repair any red or incomplete
  Daytona run in Daytona; never switch lanes to turn the verdict green.
- A local reproduction may aid diagnosis, but it is not fallback and cannot
  replace the required Daytona verdict.
- Record the selected lane. For local fallback, report which Daytona
  prerequisite was unavailable without printing secret values.

## Prepare local fallback

```bash
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm dev:den:mysql
```

- Local `server()` requires MySQL at `127.0.0.1:3306`.
- Build those workspace dependencies before local Den; otherwise den-api imports
  can fail.
- If the checkout path contains spaces, set `OPENWORK_EVAL_SURFACES_DIR` to a
  space-free path before E2E tests. node-gyp and electron-rebuild require it.

## Choose one lane

- Run one app-less PR-lane test:

```bash
pnpm evals:pr specs/<name>.test.ts
```

- Run one app/Den-driving E2E test:

```bash
pnpm evals:e2e <name>
# Fallback:
OPENWORK_EVAL_E2E_TESTS=1 pnpm --dir evals exec vitest run --config vitest.config.ts --project e2e specs/<name>.e2e.test.ts
```

- The commands above use Daytona when `OPENWORK_EVAL_DAYTONA=1` is set and
  isolated local resources when it is unset.

## Read the verdict

- Record the exact command, exit code, and passed/failed/skipped counts.
- Report each skip as `skipped — needs: X`; never call it passed. A green command
  containing skips makes the overall verdict `Incomplete`.
- Use `Passed`, `Incomplete`, or `Failed` for the overall result.

## Iterate, then cold-boot

- While iterating, reuse a warm Den with `OPENWORK_EVAL_DEN_API_URL`.
- Before declaring `Passed`, remove the reuse override and cold-boot through
  `server()` on the same commit.
- Inject secrets with `infisical run --silent --`; never print or echo values.

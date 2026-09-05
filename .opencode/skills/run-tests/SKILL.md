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

```bash
pnpm evals:e2e <slug>
pnpm evals:pr specs/<name>.test.ts
```

The CLI prints the placement and reason; copy that line into the report. Use
`--local` only when the user asks for local. `--daytona` requires Daytona. Never
switch lanes to turn a red Daytona run green.

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
```

- The CLI owns placement and prints `placement: <daytona|local> (<reason>)`.

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

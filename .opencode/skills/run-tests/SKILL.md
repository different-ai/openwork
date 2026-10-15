---
name: run-tests
description: Run the tests, run one spec, run e2e locally or on Daytona, investigate a skipped spec. Use for executing @openwork/testkit agent-first verification.
---

# Run Tests

Report every result per **Honest Verdict**. Run on the shipping runtime per **Prove It on the Real Thing**.

## Run one test on the landable head

```bash
pnpm evals:e2e <slug>                  # app/Den-driving E2E
pnpm evals:pr specs/<name>.test.ts     # app-less PR-lane test
```

- Check out the exact head that will land. One test at a time, so each failure has one owner.
- The CLI prints `placement: <daytona|local> (<reason>)`. Copy it into the report.
- `--local` only when the user asks. `--daytona` requires Daytona. Never switch lanes to turn red green.

Know what each placement runs before reading a verdict:

- Daytona (the default when the `daytona` CLI is logged in) builds `OPENWORK_EVAL_REF`, which defaults to `dev`, not your working tree. To test a branch, push it and export `OPENWORK_EVAL_REF=$(git rev-parse HEAD)`; add `--strict-ref` so a mismatch fails instead of warning.
- `--local` runs your working tree. An `appWeb` world stays in headless Chrome. A `desktop` world (`seed.desktop`, `app()`) opens an Electron window that takes focus here; run those on Daytona unless the user asks for a local window.

## Core journey

Every PR runs it. Its world is a Freestyle VM on the pushed `HEAD`, so push first:

```bash
FREESTYLE_API_KEY="$(infisical secrets get FREESTYLE_API_KEY --env dev --path /openwork-ops --plain --silent)" \
  node evals/bin/evals.mjs specs/core-chat.e2e.test.ts --local --engine v1 --surface web
```

After changing the world itself, run `node evals/scripts/check-freestyle-world.ts --base <sha>` instead.

## Local prerequisites

```bash
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm dev:den:mysql                     # local server() needs MySQL on 127.0.0.1:3306
```

- A checkout path with spaces breaks node-gyp. Set `OPENWORK_EVAL_SURFACES_DIR` to a space-free path.
- Electron profiles and their `electron.log` are deleted at the end. Set `OPENWORK_EVAL_SURFACE_LOGS_DIR` outside the surfaces dir to keep logs.
- Inject secrets with `infisical run --silent --` (never for `pnpm world`).

## Match the runtime

`apps/server` runs on Bun in evals but on Electron's Node (undici) in Desktop. For changes touching fetch, streams, signals, GC or timers, also run:

```bash
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --expose-gc <script>
```

## Iterate, then cold-boot

- While iterating, reuse a warm Den with `OPENWORK_EVAL_DEN_API_URL`.
- Before `Passed`, drop the override and cold-boot through `server()` on the same commit.

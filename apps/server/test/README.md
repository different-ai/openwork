# Server component tests

Use Node 24, pnpm 11.4.0 and Bun 1.3.14, matching
`.github/actions/setup-tests/action.yml`. From the repository root:

```sh
pnpm install --frozen-lockfile --prefer-offline
pnpm --dir evals install --frozen-lockfile --prefer-offline
pnpm --filter openwork-server build
pnpm --filter @openwork/sandbox build
bun test --path-ignore-patterns '**/*.vitest.test.ts' apps/server/test
```

The server build prepares computer-use, types, free-auto and
enterprise-mcp-client. Install alone leaves compiled workspace exports missing.
The sandbox build is needed for the cloud-computer Vitest fixtures below.

Do not use an unfiltered `bun test apps/server/test`: `*.vitest.test.ts` files
belong to the **Vitest PR project**, not Bun. This is runner selection, not a
skipped assertion. Run those files separately, one spec at a time:

```sh
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr ../apps/server/test/computer-use-tools.vitest.test.ts
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr ../apps/server/test/cloud-computer-lifecycle.vitest.test.ts
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr ../apps/server/test/non-reasoning-model-variants.vitest.test.ts
pnpm --dir evals exec vitest run --config vitest.config.ts --project pr ../apps/server/test/session-title-sigv4.vitest.test.ts
```

## Native fixtures

Native provider tests need the pinned V2 engine (currently 2.0.26), not a mock.
Prepare checkout-local sidecars without launching the desktop:

```sh
pnpm --filter @openwork/desktop prepare:sidecar
OPENWORK_TEST_OPENCODE2="$PWD/apps/desktop/resources/sidecars/opencode2" \
OPENWORK_OPENCODE2_BIN="$PWD/apps/desktop/resources/sidecars/opencode2" \
bun test --path-ignore-patterns '**/*.vitest.test.ts' apps/server/test
```

Both variables matter: provider fixtures use the first; staged-history and
forced-start recovery tests use the second. Without them, tests may fall back to
an installed engine or explicitly skip when their binary is unavailable. Report
those skips; a zero exit code is not full native coverage. On Windows, use the
`.exe` filename. The large-history test writes a disposable database larger than
260 MiB, so allow sufficient disk and memory. Fixtures use isolated profiles,
not a running desktop's data.

## CI versus local

`.github/workflows/ci-tests.yml` selects specific server tests: readiness,
fresh-install engine defaults, plugin dependency extraction, and several Vitest
specs. It does **not** run the broad Bun directory command on every PR. The
scheduled extended job runs the Vitest PR project (Linux only), engine smoke
and builds on Linux/macOS. Its success is not a claim that every server test
above ran. For packaging/cold-engine preparation, see
`../../desktop/test/README.md`.

# Issue #5913 reproduction and PR #6039 verification

## Rebase

The repository has no `main` branch. PR #6039 targets `dev`; the clean comparison
base is `25b99c96f06c3611c7e02972438a7103a67b3109` (latest `origin/dev` at fetch).
Rebased both original PR commits, resolved source/CI/Helm conflicts, and respected
current policy that generated OpenAPI/SDK files are ignored, not committed.

The rebase preserves scoped Gateway model access, selected-model pinning,
required-access no-fallback behavior, current CI jobs, and durable step execution.
It additionally carries attribution through Responses, scoped adapters, step
calls, title calls, and newly introduced resume/refresh paths. Fresh credentials
replace or clear old identity. No inference gateway fold-in was implemented.

## Reproduction world

See `ee/apps/headless-runner/scripts/attribution-world.README.md` for commands,
setup, boundaries and cleanup. The fake upstream gateway implements OpenAI Chat,
Anthropic Messages, and OpenAI Responses, JSON and SSE. The real runner API and
runtime receive five concurrent mocked principals in each configured/off case.
Both baseline protocol client and runner come from the clean baseline checkout.

Verified using Node **24.22.1**, matching the repository's supported version:

| Source / expectation | Cases | Requests | With correct member header | Without header | Exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| Clean base / anonymous | 6 | 66 | 0 | 66 | 0 |
| Rebased branch / attributed | 6 | 66 | 18 | 48 | 0 |
| Clean base / attributed (intentional red control) | first configured case | — | — | — | 1 |

The red control fails on the actual issue: `actual: null`,
`expected: 'mem_fixture_a'`, not on setup, authentication, or network failure.
Each case witnesses five simultaneous streams and five completed nonstream title
calls. The 18 attributed branch requests are three enabled members × turn/title ×
three protocols. The 48 anonymous requests cover configuration off, identity
issuance off/missing, and a same-session follow-up without identity. Unauthenticated
submission returns 401. Identity and secrets are absent from model context, HTTP
snapshots, and durable SQLite/sidecar bytes.

This reproduces anonymous **direct/shared-key header transport**, not anonymous
OpenWork Gateway accounting: our Gateway already identifies its member key.
The world mocks Den issuance; real Den issuance is covered separately below.

## Focused verification

All listed successful commands exited 0, with zero failures/skips/cancellations.
Run from repo root unless noted; use Node 24.22.1 in `PATH`.

| Command | Result |
| --- | --- |
| `pnpm --filter @openwork-ee/headless-runner test:attribution` | 15 passed (existing boundary tests + reusable world) |
| `pnpm --filter @openwork-ee/headless-runner exec tsx --conditions=development --test scripts/attribution.test.ts scripts/resume-attribution.test.ts scripts/model-responses.test.ts scripts/scoped-model-access.test.ts scripts/scoped-model-pin.test.ts scripts/steps-scoped-model.test.ts scripts/self-resume.test.ts scripts/steps.test.ts` | 73 passed |
| `pnpm --filter @openwork-ee/headless-runner exec tsx --conditions=development --test scripts/conversation.test.ts` | 8 passed |
| `pnpm --filter @openwork-ee/workbot test:model` | 11 passed |
| `pnpm --filter @openwork-ee/den-api exec tsx --conditions=development --test test/headless-model-attribution.test.ts` | 3 passed |
| Den API `test/api/headless-model-attribution.api.test.ts`, disposable MySQL | 5 passed |
| `pnpm --filter @openwork/features test` | 26 passed |
| Runner, Workbot, Den API `typecheck` | Passed |
| Runner `build` | Passed |
| Fixture/world strict standalone TypeScript check (README source files) | Passed |
| `pnpm features:check` | Passed |

Den API tests boot the real API on an isolated database. They verify off/on
issuance for two actual memberships, fresh resume identity, rollout removal from
existing grants and new turns, and per-member overrides/inheritance. No paid model
calls. The initial default-local-MySQL attempt failed authentication; the successful
run used a separate disposable `mysql:8.4` container, then removed it.

An initial Den typecheck found newly typed database ID operands in this PR; the
membership query now normalizes IDs at the SQL boundary and the rerun passed.
Earlier partial-rebase attribution tests failed because the client had not yet
been resolved to forward identity; the final integrated suite passes.

No live vendor budget enforcement, production deploy, full repository/core desktop
journey, or full CI result is claimed by this focused local verification. New CI
and security clearance must complete on the pushed head; old approval does not
validate the rebased code. Do not merge automatically.

# Device login regression

This is a standalone integration test. The normal `test/*.test.ts` suite does not load it.

Run from the repository root:

```sh
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx test/device-login/run.mjs
```

Select one case per invocation. Each case gets a fresh database:

```sh
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx test/device-login/run.mjs --case delayed
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx test/device-login/run.mjs --case denial
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx test/device-login/run.mjs --case expiry
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx test/device-login/run.mjs --case abuse-isolation
```

`--case=<name>` also works. The default case is `delayed`.

For a real-clock delayed-approval run, add `--real-clock`:

```sh
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx test/device-login/run.mjs --real-clock
```

The real-clock run needs more than two minutes after the fix. The runner allows four minutes for the scenario. Only the delayed case supports real-clock mode.

## Prerequisites

- Install workspace dependencies with pnpm.
- Start local MySQL. Use `pnpm dev:den:mysql` if required.
- The default local account must permit database creation and deletion.
- For other local MySQL credentials, set `OPENWORK_CONTRACT_MYSQL_URL`.

The runner uses `scripts/den-contract-database.mjs`. It rejects remote database hosts. It does not use the caller's `DATABASE_URL`. It creates a fresh database and drops it after the run. It runs `drizzle-kit push --force` through pnpm with `--conditions=development`.

## Test boundary

- Run the real `packages/openwork-bootstrap/bin/openwork.mjs` in a child process.
- Import the real `src/auth.ts`. Do not change its options.
- Assert that auth rate limiting is enabled and uses database storage.
- Register the real session middleware, auth routes, and me routes on Hono.
- Use actual localhost HTTP for the CLI and browser decision.
- Create synthetic users and browser sessions through the real auth adapter.
- In the delayed case, approve on the first token request at or after 130 seconds.
- Require CLI exit 0 for approval. Check the saved token against the real session table and `/v1/me`.
- Do not send production sign-in requests. Block non-local fetch calls in both processes.
- Do not print CLI output, device codes, session tokens, or SQL errors.

The fast mode replaces JavaScript `Date` in the two isolated processes. The CLI preload advances only the shipped CLI's `sleep` timer. It sends virtual time in a test header. The server sets its clock before each CLI request. Network timers and SQL time stay real. The approval request runs at that same clock value. The real-clock mode does not replace Date or timers.

## Cases and trace

- `delayed`: recover from a real plain HTTP 429. Keep the first code. Approve after 130 seconds. Require one new session and saved credentials.
- `denial`: deny through the real decision route. Require CLI exit 1 and `login_denied`. Require no new session and no credentials file.
- `expiry`: leave the code pending for its full 900-second TTL. Require CLI exit 1 and `login_expired`. Require no CLI polls at or after the deadline. Then use a separate direct HTTP probe at 901 seconds to check Den's `expired_token` response. Require no new session and no credentials file.
- `abuse-isolation`: use direct HTTP and two synthetic users. Check same-code `slow_down`, the 20-request IP limit, independent IP counters, and per-device polling state. Refuse Better Auth's raw approve and deny endpoints for a signed-in browser cookie, and keep the code pending. Approve one code for each user. Refuse another user's attempt to rebind an approved code. Redeem each code while supplying the other user's bearer token. Verify that each new session still belongs to its approving user. Refuse replay of a consumed code.

The endpoint rate limit is per IP, not per device code. **Codes on one IP intentionally share that IP's rate limit.** Device status and `lastPolledAt` remain separate. A fresh IP does not bypass the per-device minimum poll interval.

The JSON result includes:

- Case, clock mode, commit SHA, and Den service version.
- Request counts by endpoint.
- Token poll counts and timestamps. Each trace entry identifies a CLI request or a direct probe.
- HTTP 429 count and timestamps. Retry headers are recorded as numeric seconds.
- Code TTL and poll interval.
- Database counter counts, CLI exit, safe CLI error category, and session delta.
- Case-specific assertion results. No code, token, user identity, or raw auth output is included.

Each trace array is limited to 256 entries. A truncated trace fails the case. Device labels are test labels, not real code values. In the expiry case, `cliElapsedSeconds` is 900, while the final direct probe is at 901 seconds. Thus, total polls and CLI polls differ.

Run the cases one at a time. The historical red result below predates the case extensions.

## First red run

SHA: `ad22cdc2217370f28f24f0f8758016c2921e3c73`.

Command: the fast command above.

Result:

- Runner exit: 1.
- CLI exit: 1.
- Passed: 0. Failed: 1. Skipped: 0.
- Token polls: 21.
- Virtual elapsed time: 105 seconds.
- Last token response: HTTP 429, without OAuth `slow_down`.
- Database rate counter: 20.
- Approval: not reached.
- Session validation: not reached.
- Runner duration: 4.610 seconds.

First actionable failure:

```text
Expected CLI exit 0 after delayed approval. Actual CLI exit 1 after HTTP 429.
```

This is the target regression. No clean control was run. No failure is classified as pre-existing.

Three setup attempts preceded this result. Each used the same command and SHA. Each exited 1 with zero passes and one failure. The first two failed before a scenario result. The second exposed a missing `tsx` import from the child working directory. The third returned HTTP 401 for the synthetic browser session. The harness now starts the child from the API package and installs the real session middleware.

This historical run stopped after the red result.

## Results after the correction

Date: 2026-10-12. Base SHA: `ad22cdc2217370f28f24f0f8758016c2921e3c73`, with the local CLI correction.

Main runtime: Node `26.10.0`, macOS arm64. Better Auth: `1.7.0-beta.10`. CLI version: `0.1.0`.

All commands below exited 0. Each server case reported one pass, zero failures, and zero skips. Each invocation used a fresh database.

- `--case delayed`: one code request, 22 token polls, and one new session. HTTP 429 occurred at 105 controlled seconds. `X-Retry-After` was 55 seconds. The next poll succeeded at 160 seconds. The saved session passed `/v1/me`.
- `--case denial`: one code request and one token poll. The CLI exited 1 at five controlled seconds with `login_denied`. No new session or credentials file was created.
- `--case expiry`: one code request and 71 CLI token polls. The last CLI poll was at 895 controlled seconds. The CLI stopped at 900 seconds with `login_expired`. A separate probe at 901 seconds received `expired_token`. No new session or credentials file was created.
- `--case abuse-isolation`: two code requests and 27 direct token requests. The primary IP was limited at request 21. A second IP used a separate counter. Both device state and session ownership remained separate. Wrong-user approval and replay were refused.
- `--real-clock`: one code request and 22 token polls. HTTP 429 occurred at 105.493 seconds. `X-Retry-After` was 55 seconds. The next poll succeeded at about 160.5 seconds. The CLI exited 0 at 160.577 seconds. One new session passed `/v1/me`. Total runner duration was 164.881 seconds.

The controlled delayed case also passed on Node `22.23.3`. Run this command from `ee/apps/den-api`:

```sh
pnpm dlx node@22.23.3 --conditions=development --import tsx test/device-login/run.mjs --case delayed
```

The CLI protocol suite has 36 passing tests on Node `26.10.0` and Node `22.23.3`. See `packages/openwork-bootstrap/test/README.md`.

The production correction is in the CLI only. Server rate limits and auth routes are unchanged. The automated runs above used localhost only.

## Manual check with production Den

A later, explicitly authorized check used production Den and the fixed local CLI. It used a separate HOME and credentials file. No requests, responses, or clocks were simulated.

One device code was requested. The CLI made 26 token polls. Production returned HTTP 429 on polls 21 through 24. The CLI stayed active and increased its retry delays. Poll 26 succeeded after browser approval. The CLI exited 0 after 207.588 seconds. Its saved session passed `/v1/me` with HTTP 200. The credentials file had mode `0600`.

This proves recovery for that one delayed-approval attempt. It does not prove production denial or expiry behavior. No second production attempt or deployment was made. The public CLI was not updated.

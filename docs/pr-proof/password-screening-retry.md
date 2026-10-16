# Password screening retry validation

## Failure and scope

A self-hosted Den instance returned HTTP 503 `password_screening_unavailable`
from normal email/password registration when its outbound Pwned Passwords range
request failed. The old request had no explicit timeout or retry, and its caller
discarded the underlying error. The precise historical transport failure cannot
be reconstructed from those logs. Outbound access and normal registration also
recovered before applying the patch; the live failure was intermittent.

This change bounds each range attempt to five seconds and permits one retry for
connection failures, response-body failures, and HTTP 500/502/503/504. Other HTTP
errors are not retried. Password screening remains enabled. Persistent failures
still reject registration with HTTP 503, and compromised passwords remain
rejected. Logs contain only diagnostic categories, attempt counts, and HTTP/error
codes; they contain no password, password hash, range prefix, request URL, or
account identity.

## Fault verification

The operational fault harness ran against the compiled candidate on Node.js
22.23.3. All nine cases passed:

| Case | Observed result |
| --- | --- |
| Clean password | One request; five-character hash prefix, padding header and abort signal verified |
| Compromised password | HTTP 400 `password_compromised` |
| First connection attempt fails | Second attempt succeeds |
| First response is HTTP 503 | Failed body cancelled; second response is checked and a compromised password remains rejected |
| HTTP 403 | One attempt; HTTP 503 returned to the caller |
| Persistent connection failure | Exactly two attempts; HTTP 503 `password_screening_unavailable` |
| Response-body connection failure | Second attempt succeeds |
| Hung upstream | Two five-second attempts; HTTP 503 within the bounded test window |
| Diagnostic privacy | No fixture password, hash, prefix, suffix or range URL in captured fields |

The checked-in regression suite is
`ee/apps/den-api/test/password-screening-retry.test.ts`, included by the existing
Den provider unit-test command:

```sh
pnpm --filter @openwork-ee/den-api test
```

The nine checked-in regression tests also passed against the actual TypeScript
source in a disposable Node.js 22.23.3 container with networking disabled. The
transient connection-failure case was run against the unpatched base and failed
with the injected connection error; it passes with the patch. The timeout case
observed two real five-second aborts. These local results are independent of
upstream CI, which has not yet run for this contribution.

A broader local Den API suite attempt reported 304 passes and four failures.
Those failures were missing runtime-image test prerequisites: the OpenAPI
snapshot (two tests), repository constants for the pinned-engine test, and
headless-runner sources. This was a reduced runtime image, not a complete CI
checkout; the full suite is not claimed to pass. No tests were skipped or
modified to obtain the focused regression result.

For a focused run after installing/building the existing workspace dependencies:

```sh
pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx --test test/password-screening-retry.test.ts
```

## Normal registration and sixth-member verification

Operator-observed validation on 2026-10-15 used the patched Den API and real HTTP
requests. The organization remained on its existing `free` plan in `single_org`
mode, with the existing plan-gating configuration unchanged. Password breach
screening was verified enabled after deployment. The runtime fix source matches
the source change in this PR; the regression test and this report were added
after that live run.

Five temporary accounts were created through
`POST /api/auth/sign-up/email`; no internal account-provisioning method or direct
user insertion was used for this run.

| Check | Observed result |
| --- | --- |
| Normal registration requests | Five HTTP 200 responses |
| Active human members | 1 -> 2 -> 3 -> 4 -> 5 -> 6 |
| Sixth member signs out and signs in again | HTTP 200 |
| Sixth member reads its identity and organizations | HTTP 200; returned identity and organization matched the temporary account |
| Sixth member reads active organization | HTTP 200; membership and free-plan context verified |
| Sixth member reads its library and config objects | HTTP 200 |
| Sixth member reads desktop configuration | HTTP 200 |
| Sixth member updates its own profile | HTTP 200; subsequent read returned the saved value |

This is registration and member-API evidence, not desktop GUI or model-inference
acceptance. It does not change any license entitlement or claim that the sixth
member is free to use under the software license.

## Cleanup and final health

| Check | Observed result |
| --- | --- |
| Temporary accounts remaining | 0 |
| Temporary authentication sessions remaining | 0 |
| Temporary login credentials remaining | 0 |
| Active human members after cleanup | 1 |
| Original user records | Identical to the baseline |
| Original membership records | Identical to the baseline |
| Reuse of the removed temporary session | HTTP 401 |
| Den API, Den Web and database health | Healthy |

This public report intentionally omits hostnames, IP addresses, machine paths,
organization names, user and membership IDs, emails, credentials, cookies,
tokens, raw database contents, original-record hashes and deployment image
identifiers. Raw operational artifacts remain outside the contribution tree.
The live results are operator-observed evidence, not an upstream CI verdict.

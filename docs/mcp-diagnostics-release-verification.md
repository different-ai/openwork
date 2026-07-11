# MCP diagnostics release verification

## Current status

**Verification is just starting.** This branch is the controlled integration
branch for the MCP diagnostics program. It is intentionally based on upstream
`dev` and does not contain any of the three implementation branches yet.

Parent draft: [#2674](https://github.com/different-ai/openwork/pull/2674).

The goal is to let Jalil review one understandable capability at a time,
record what was personally verified, address findings on the source branch,
and only then integrate that capability here. The parent draft pull request is
the living status page for that process.

## What we set out to build

The program has three levels:

1. Structured MCP connection errors that identify the failed phase, safe error
   code, responsible owner, and recommended action.
2. A deterministic enterprise MCP server for ServiceNow and Microsoft-style
   OAuth, protocol, session, catalog, and fault testing without customer data.
3. Live Den-side diagnostic tracing that shows progress, highest proven health,
   first failure, safe evidence, authorization continuation, and remediation.

## Source pull requests

| Level | Source pull request | Implemented | Technical review | Verified by Jalil | Integrated here |
| --- | --- | --- | --- | --- | --- |
| Structured errors | [#2669](https://github.com/different-ai/openwork/pull/2669) | Yes | Changes requested | Not started | No |
| Enterprise mock | [#2670](https://github.com/different-ai/openwork/pull/2670) | Yes | Changes requested | Not started | No |
| Live tracing | [#2672](https://github.com/different-ai/openwork/pull/2672) | Yes | Passed with documented operational limitations | Not started | No |

Passing isolated tests does not automatically change **Verified by Jalil**.
That column changes only after Jalil reviews the relevant demonstration and
accepts the behavior and any limitations.

## Findings that must be managed

### Level 1: structured errors

Three focused issues were found:

- local OAuth callbacks can use Den Web instead of Den API;
- an OAuth exchange can outlive its diagnostic deadline and write credentials
  after the timeout response;
- the detailed diagnostic owner and the higher-level user action can disagree.

These are high-priority but localized fixes. Level 1 should not be integrated
until each issue has a regression test and its demonstration is reviewed.

### Level 2: enterprise mock

The default confidential-client profiles can select `client_secret_basic`
while the profile requires `client_secret_post`. The DCR demonstration avoids
that path, so the realistic manual/pre-registered enterprise flow still needs
a direct Den SDK regression test and correction.

The mock also simplifies provider-specific OAuth endpoint paths. Exact
ServiceNow and Microsoft endpoint fidelity will be tracked separately after
the primary client-authentication path is correct.

### Level 3: live tracing

No new merge-blocking correctness defect was found. Its main limitations are
operational: active diagnostics are not fully restart- or instance-durable,
there is no per-organization concurrency limit yet, completion audits may be
duplicated, and SSE resume can be improved.

These limitations must be either accepted for the initial release or fixed
before Level 3 is integrated.

### Combined integration

The three source branches modify overlapping MCP client, URL guard, route, UI,
mock, and diagnostic-model files. They cannot be combined safely by accepting
merge conflicts mechanically. This parent branch will choose one coherent
implementation for each overlap and run the union of all tests after every
integration step.

## Controlled verification process

For each level:

1. Jalil selects the next capability to review.
2. The source PR is updated to fix its known blockers.
3. Focused automated tests and a fresh user-visible proof are run.
4. Jalil reviews the short demonstration and records what is understood and
   accepted.
5. Only the verified change is integrated into this parent branch.
6. This ledger and the parent pull request are updated with the commit, proof,
   accepted limitations, and remaining work.
7. The combined parent branch is retested before selecting the next level.

After all three levels are integrated, the final gate is one connected journey:

```text
Add enterprise mock connection
-> complete OAuth
-> test protocol and catalog readiness
-> run live diagnosis
-> inject a failure
-> identify the exact failing phase
-> repair the mock
-> retry successfully
```

Approved nonproduction ServiceNow and Microsoft tenants are a later provider
verification stage. Local mock success alone will not be described as real
provider conformance.

## Parent branch rules

- Base every parent update on current upstream `dev`.
- Keep this branch on Jalil's fork; do not push feature branches to upstream.
- Do not integrate a source PR while its selected blocker is unresolved.
- Do not label a capability user-verified based only on CI or agent review.
- Keep secrets, raw OAuth values, session identifiers, and customer content
  out of evidence and pull-request discussions.
- Update this document and the parent draft description after every checkpoint.

GitHub only permits a pull request to use branches in its base repository as
its literal base. Because this parent branch intentionally exists only on
Jalil's fork, the existing upstream source PRs remain based on upstream `dev`.
Their descriptions link back to the parent release PR, and verified changes
are integrated into this branch only after approval.

## Verification log

| Date | Checkpoint | Result |
| --- | --- | --- |
| 2026-07-11 | Parent integration branch created from current upstream `dev` | Complete |
| 2026-07-11 | Parent draft opened and linked from all three source PRs | Complete |
| 2026-07-11 | Initial technical review of the three source PRs recorded | Complete |
| 2026-07-11 | Jalil-led capability verification | Not started |
| 2026-07-11 | Implementation merged into parent | None |

## Next decision

Jalil selects whether to begin with structured errors, the enterprise mock, or
live tracing. The recommended starting point is structured errors because it
defines the diagnostic language consumed by the later levels.

# MCP diagnostics controlled release

Parent draft: [#2674](https://github.com/different-ai/openwork/pull/2674).

## Management purpose

This branch is the controlled destination and verification ledger for the MCP
diagnostics program. It records four different states deliberately:

1. implemented on a source branch;
2. verified by automation;
3. personally verified and understood by Jalil; and
4. integrated into the controlled release.

Automation can reduce risk, but it never changes Jalil's verification state or
authorizes a merge by itself.

## Program goals

The program has three user-facing levels:

1. **Clear failure source:** identify where an MCP connection failed, who owns
   the next action, and a safe diagnostic reference.
2. **Enterprise development fixture:** reproduce Microsoft- and ServiceNow-style
   OAuth/MCP behavior and controlled faults without customer data.
3. **Live diagnostic mode:** show connection phases in real time, preserve the
   highest proven health and real first failure, and support repair/retry.

The work also established a package-first outbound client boundary. Reusable
MCP behavior belongs in a package; Den provides guarded network access,
encrypted persistence, organization/member authority, and public diagnostics
through explicit adapters.

## Microsoft 365 and current package boundary

OpenWork's **Microsoft 365 quick add** is a native OAuth/Microsoft Graph
integration. Jalil verified that it connects successfully, but it does not use
`@openwork/enterprise-mcp-client`. The enterprise flag selects Den's external
remote MCP runtime only.

The Microsoft- and ServiceNow-named mock scenarios are provider-shaped
fixtures, not new production quick-add connectors. The package is
provider-neutral; `enterprise` describes hardened security, lifecycle,
persistence, and diagnostics.

The long-term direction is to consolidate reusable remote MCP behavior behind
package contracts. Migrating native Microsoft 365 or every connection type is
outside this release.

## Current status

| Area | Source | Automated state | Jalil verification | Integration state |
| --- | --- | --- | --- | --- |
| Structured MCP diagnostics | [#2669](https://github.com/different-ai/openwork/pull/2669) | Passed | Initial error-source behavior reviewed | **Merged into upstream `dev`** |
| Native Microsoft 365 OAuth errors | [#2698](https://github.com/different-ai/openwork/pull/2698) | Focused tests and typecheck passed | Real Connect succeeded after replacing the secret value | Draft |
| Enterprise mock package and lab | [#2670](https://github.com/different-ai/openwork/pull/2670) | 162 local package and 20 lab tests passed; GitHub rerunning after Node 24 socket fix | Lab opened; Den-to-mock walkthrough not complete | Draft |
| Package-first enterprise client | [#2694](https://github.com/different-ai/openwork/pull/2694) | Source and Den matrices passed | Manual end-to-end review not complete | Draft |
| Client/mock combined proof | [#2699](https://github.com/different-ai/openwork/pull/2699) | 23 client tests and four integration scenarios passed; GitHub rerunning after Docker dependency fix | Manual replay not complete | Verification-only draft |
| Live diagnostic tracing | [#2672](https://github.com/different-ai/openwork/pull/2672) | Earlier focused proof passed | Not started | Draft; refresh before review |

## Real Microsoft 365 learning

The browser authorization and callback succeeded, but token exchange returned
HTTP 401. The old message only said `Token request failed with status 401`.
Microsoft's safe response identified `invalid_client` / `AADSTS7000215`: the
client secret value must be configured, not the secret ID. After the active
secret value was supplied, Jalil confirmed the connection succeeded.

#2698 maps that provider signal to a precise, safe administrator action and a
Den diagnostic reference without exposing secrets or raw provider bodies.

Azure local development also confirmed the exact callback shape:

```text
http://localhost:<den-api-port>/v1/oauth-providers/microsoft-365/connect/callback
```

#2670 accepts exact HTTP OAuth callbacks on `localhost`, `127.0.0.1`, and
`[::1]`. The mock lab's protected admin origin is a separate exact literal
loopback host (`127.0.0.1` by default, optionally `[::1]`) and never treats
`localhost` as equivalent.

## Combined verification finding

The package-first client/mock rehearsal found that a token-exchange 401 could
be followed by a successful metadata request. The later successful request
overwrote the recorded request phase, so the administrator could be directed
to discovery instead of the incorrect client secret.

#2694 now tracks request progress and failed-request evidence separately.
#2699 proves that wrong-secret Microsoft and ServiceNow scenarios both retain
`oauth-token-exchange`, while healthy flows complete OAuth, MCP initialization,
catalog loading, and a safe read through the packages' public exports.

## What remains open

- Jalil's manual healthy and wrong-secret ServiceNow mock walkthrough.
- Jalil's manual healthy and wrong-secret Microsoft Enterprise walkthrough.
- Live Microsoft Enterprise MCP and live ServiceNow tenant verification.
- Refresh and review of live tracing against current upstream `dev`.
- Maintainer decisions on package naming, adapters, rollout policy, and the
  explicit mock-versus-live evidence boundary.

The deterministic mock does not prove a customer's licensing, consent,
Conditional Access, ACLs, proxy/CA, egress policy, region, patch level, or
provider business behavior. Those require approved nonproduction tenants.

## Controlled verification process

For each checkpoint:

1. Jalil selects one visible behavior to understand.
2. Start only the isolated services required for that behavior.
3. Record **verified**, **needs changes**, or **deferred** here.
4. Integrate only accepted source commits into this branch.
5. Rerun cumulative package, Den, and browser checks.
6. Update this ledger before selecting the next capability.

## Recommended next checkpoint

Start with ServiceNow mock onboarding:

1. create a healthy fixture;
2. register Den's exact `localhost` callback;
3. connect and confirm catalog readiness;
4. switch to invalid client/wrong secret;
5. confirm Den identifies OAuth token exchange and the organization-admin action;
6. recover to healthy; and
7. repeat the same story with Microsoft Enterprise.

Review live tracing only after the underlying package connection and failure
story is understood.

## Verification log

| Date | Checkpoint | Result |
| --- | --- | --- |
| 2026-07-11 | Controlled feature branch and parent draft created | Complete |
| 2026-07-11 | Original three-level automated integration rehearsal | Passed in [#2675](https://github.com/different-ai/openwork/pull/2675) |
| 2026-07-12 | Structured diagnostics landed in upstream `dev` | Complete via #2669 |
| 2026-07-12 | Real native Microsoft 365 OAuth | Connected after correct secret value was configured |
| 2026-07-12 | Mock aligned to Azure localhost and provider-specific wrong-secret errors | Automated checks passed |
| 2026-07-12 | Package client tested against ServiceNow and Microsoft mocks | Passed in #2699; failure-phase bug found and fixed |
| 2026-07-12 | Jalil manual Den-to-mock verification | Next checkpoint |

Secrets, OAuth codes, tokens, session identifiers, customer hostnames, and
customer content must remain outside commits, PR descriptions, and evidence.

# Reconciliation with earlier MCP diagnostic work

Reviewed 2026-07-12 against OpenWork PRs #2669, #2670, #2672, #2674, #2675,
and this package branch. The table distinguishes package behavior from Den
policy so the package does not absorb database, environment, or UI opinions.

| Earlier finding or practice | Reference implementation result | Owner |
| --- | --- | --- |
| Generic `failed to connect` / dropped cause | Operation and request phases retain the cause; Den #2669 produces the safe diagnostic envelope and reference. | Package + Den diagnostic adapter |
| Wrong OAuth callback public origin | Callback URI continues to come from validated Den public-origin configuration; the package accepts the URI as explicit input and never derives it from environment. | Den composition root |
| Token exchange succeeded but resource/MCP rejected it | Callback performs authenticated MCP initialization; unusable tokens are invalidated. | Package |
| Timed-out work wrote credentials later | Every port write carries an absolute commit deadline; Den checks inside a transaction and again before commit so throwing rolls back. | Contract + Den persistence adapter |
| One PKCE verifier was clobbered by concurrent Connect attempts | State-bound encrypted authorization transactions coexist up to a fixed cap and commit single-use. | Contract + Den persistence adapter |
| Concurrent DCR attempts selected different clients | Persistence is first-writer-wins; a losing SDK registration is rejected rather than used with the winner's stored state. Client revision is bound into authorization. | Contract + Den persistence adapter |
| Callback used stale in-memory credentials | Credential loads refresh the scoped Den record; callback MCP validation observes the committed credential. | Den persistence adapter |
| Expiry was stored but not part of the contract | Token, client-secret, authorization, lifecycle, and documentation expirations are explicit and validated. | Package contract |
| Refresh response omitted a rotated refresh token | The package preserves the existing refresh token only on the refresh path. | Package |
| 401 credential failure and 403 provider permission were confused | Den's structured HTTP diagnostics keep resource authentication separate from provider authorization. | Merged Den diagnostics |
| MCP `isError` looked successful | `isError: true` throws a typed provider-operation error with only allowlisted status/category/request-id signals. | Package |
| Unbounded response/catalog/SSE/redirect behavior | Catalog limits live in the package; guarded redirect, response/SSE size, cross-origin secret stripping, and body cancellation remain mandatory injected network policy. | Package + Den network adapter |
| Deleting a connection raced credential work | Delete and enterprise credential transactions lock the same connection row and clean dependent credentials/client state atomically. | Den persistence layer |
| Catalog Ready was mistaken for provider readiness | This package reports successful catalog retrieval only. The mock/test UI must continue to label operation/mutation readiness separately. | Mock/UI PR, not this package |
| Live timeline, retention, reconnect replay, support bundle | Package events are safe inputs; persistence, SSE, retention, and support access remain the separate live-diagnostics feature. | #2672, outside package |
| Mock controls, realistic ServiceNow/Microsoft fixtures | Used as the next conformance gate; not copied into the production client package. | Enterprise mock package/EE app |
| Proof viewer mobile/accessibility issues | No UI exists in this server/package PR. | Outside scope |

## Explicitly not collapsed into the package

- databases, tables, encryption keys, organization/member types;
- process environment or Helm/Docker parsing;
- admin/member route authorization and UI state;
- provider-specific ServiceNow/Microsoft product availability or scopes;
- support-bundle retention/access policy;
- mutation approval and provider idempotency policy.

Those concerns are required at their named adapter or product boundary. Leaving
them out is inversion of control, not omission: the package defines what must
be supplied and fails when a required contract is absent.

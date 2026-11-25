# Security, validation, and expiration contract

- Document status: active reference implementation
- Last code-and-document review: 2026-07-12
- Review by: 2026-10-12, or sooner when the MCP SDK/protocol baseline changes
Stable protocol evidence baseline: MCP 2025-11-25; provider support must still
be verified against the deployed ServiceNow or Microsoft surface.

This document is intentionally time-bounded. A reviewer must re-check the live
SDK, MCP specification, provider documentation, and Den adapter before changing
the review date. A date alone is not evidence of provider conformance.

## Required composition contracts

| Boundary | Package requirement | Den responsibility |
| --- | --- | --- |
| Network | A fetch port is required; all requests share cancellation/deadline signals. | Enforce protocol, credentials, DNS/IP policy, redirects, downgrade rules, cross-origin secret stripping, proxy/TLS posture, response limits, and body cancellation. |
| Clock | Absolute epoch-millisecond values; finite/non-negative validation. | Supply deployment time; monitor clock skew operationally. |
| Tenant and actor | No tenant/member model in the package. | Construct an adapter already scoped to exactly one organization, connection, and shared/member credential owner. |
| Client registration | Opaque revision, source, and expiry. Concurrent DCR is first-writer-wins. | Encrypt the secret, omit secrets from JSON metadata, serialize competing writers, and reject a losing client. |
| Authorization | Signed id, verifier, expiry, optional client revision, opaque transaction revision. | Store only a non-reversible state key plus encrypted verifier; cap transactions and enforce single-use. |
| Credentials | Validated OAuth token wire value plus absolute expiry and opaque revision. | Encrypt tokens and atomically persist/consume under connection and identity locks. |
| Diagnostics | Secret-free phase events; observer failures cannot affect behavior. | Add safe classification, correlation reference, authorized support evidence, retention, and audit. |

## Expiration rules

| Record | Validation | Expired behavior |
| --- | --- | --- |
| Operation lifecycle | `now < commitExpiresAt` before and immediately before transaction commit; abort signal remains active. | Reject/roll back with `MCP_LIFECYCLE_DEADLINE`; never commit after a reported timeout. |
| OAuth authorization/PKCE | Absolute expiry, signed state id, transaction revision, client revision; Den state verification is an additional outer check. | Delete the transaction and require Connect to restart. It cannot be reused. |
| Access token | Persist absolute expiry computed from `expires_in`; reject invalid/negative lifetimes. | With a refresh token, allow the bounded SDK refresh path. Without one, invalidate and require reconnect. |
| Refresh token | Opaque; provider rotation is authoritative. | Preserve the previous refresh token only when a successful refresh response validly omits a replacement. Invalid grant is reconnect-required, not generic retry. |
| OAuth client/client secret | Absolute `client_secret_expires_at` when declared; `0` means no declared expiry per DCR convention. | Invalidate and require client renewal/re-registration. Do not silently use an expired secret. |
| Documentation/provider assumptions | `Last review` and `Review by` above. | Revalidate against primary sources and a nonproduction tenant; never promote a stale preview/patch assumption. |

The default clock-skew allowance is 30 seconds and is configurable only at
client construction. It is not an environment read inside the package.

## Validation and failure ownership

Validation happens before secrets cross a boundary whenever possible:

- configuration: non-empty ids, HTTP(S) URLs, no URL credentials/fragments,
  bounded OAuth state/code, positive timeouts and TTLs;
- persistence: OAuth wire schemas, opaque revisions, finite expirations,
  matching authorization/client revisions, correct credential identity;
- protocol: initialize first, bounded complete pagination, tool schemas,
  provider `isError`, close within deadline;
- adapter: tenant/member scope, encrypted columns, same-row transaction locks,
  safe public origin, and guarded outbound requests.

Stable package codes distinguish missing/expired authorization, changed/expired
client registration, expired credentials, invalid persistence, and lifecycle
deadline. Den maps those codes to a safe phase, owner, remediation, and
diagnostic reference. Raw provider messages are not the administrator contract.

## Known evidence boundary

The deterministic OAuth/MCP tests prove protocol and port semantics. They do
not prove a real customer's ServiceNow ACL/domain policy, Microsoft consent or
Conditional Access, provider licensing/preview availability, egress allowlist,
or mutation behavior. Those remain explicit nonproduction conformance gates.

Pre-existing records written by another implementation may contain historical
provider metadata in the generic JSON column. This package never writes OAuth
client secrets or registration access tokens there. A separate reviewed data
cleanup is required before claiming that historical rows were rewritten; this
PR does not silently mutate every existing record at startup.

Pending PKCE data is intentionally not cross-mode compatible: current mode has
one unbound verifier, while enterprise mode has a versioned collection of
state-bound transactions. Feature-flag rollout/rollback must drain or expire
in-flight browser authorizations first. The adapter fails closed instead of
guessing a transaction identity for an old verifier.

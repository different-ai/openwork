# `@openwork/enterprise-mcp-client`

Reference implementation for server-side remote MCP consumption in OpenWork.

The package owns the provider-neutral MCP/OAuth lifecycle. A composition root
supplies networking, persistence, tenancy/authorization, diagnostics, and the
clock. Den is one adapter; it is not embedded in the package architecture.

The implementation is additive. Den's current client remains the default:

```bash
DEN_ENABLE_ENTERPRISE_MCP_CLIENT=true pnpm dev:den
```

Only `true`, `false`, or an unset value are valid. An invalid value fails Den
startup, and there is no request-time fallback that could hide an error.

## Reference architecture

```text
Den routes and capability authorization       composition root
                    │
                    ▼
        enterprise MCP client API             application package
          │         │          │
          ▼         ▼          ▼
     network     OAuth ports   diagnostics    injected contracts
       │             │
       ▼             ▼
 guarded fetch   encrypted Den DB adapter     infrastructure adapters
```

Dependency direction always points inward. The package does not import Den
routes, database schemas, organization/member types, deployment configuration,
or environment variables.

The public OAuth persistence contract is split into three narrow ports:

- `clientRegistrations`: validated pre-registered or dynamically registered
  clients with an opaque compare-and-swap revision and explicit expiry;
- `authorizations`: state-bound, expiring PKCE transactions that are loaded
  without consumption; and
- `credentials`: token load/save/invalidation, including an atomic callback
  commit that consumes the matching authorization transaction.

Every persistence write receives an absolute `commitExpiresAt` and abort
signal. An adapter must reject or roll back a transaction that cannot commit
inside that lifecycle. This prevents the system from reporting a timeout and
then silently writing credentials afterward.

## Security invariants

- Outbound `fetch` is mandatory injection. There is no global-fetch fallback.
  Den supplies the redirect-safe SSRF/DNS-rebinding guard for the MCP endpoint,
  OAuth discovery, registration, token endpoints, SSE, and tool calls.
- OAuth connect requires the caller's signed authorization id before network
  or persistence work begins. No random-state fallback exists.
- PKCE transactions are state-bound, individually expiring, capped, encrypted
  by Den, and consumed in the same database transaction as callback tokens.
- Callback token commit verifies the OAuth client revision, authorization
  revision, connection identity, member/shared ownership, and lifecycle.
- Dynamic client registration is first-writer-wins. A losing concurrent DCR
  cannot silently continue with the wrong client.
- New DCR client secrets are stored only in Den's encrypted client-secret
  column. Unencrypted JSON metadata excludes `client_secret` and
  `registration_access_token`.
- Access-token and client-secret expiration are absolute, validated values.
  An expired access token without a refresh token is invalidated and reported
  as reconnect-required. Refresh-token rotation preserves the previous refresh
  token when a valid provider omits it from the refresh response.
- MCP `isError: true` is a failed provider operation, not a successful request.
- Tool catalogs have page, item, cursor, name, schema depth, schema size, and
  aggregate-byte ceilings.
- Diagnostic events contain phases, outcome, duration, and HTTP status only.
  They never contain tokens, API keys, codes, PKCE verifiers, URLs, tool
  arguments, provider bodies, or customer content; a failing sink is isolated.
- Connection deletion and enterprise credential commits take the same Den row
  lock, so deletion and a late callback have one deterministic winner.

See [SECURITY.md](./SECURITY.md) for the expiration/validation contract and
[PRIOR-FINDINGS.md](./PRIOR-FINDINGS.md) for the earlier MCP findings that were
incorporated, delegated to Den, or intentionally kept outside this server-side
package.

## Rollout boundary

The package covers Den's outbound server-side remote MCP client only. It does
not change local/direct engine MCP, the incoming OpenWork Cloud meta-MCP,
desktop UI, or provider-specific tenant administration.

Rollback is one restart with the feature flag unset or `false`. No schema
migration or token copy is required; both implementations use the existing
encrypted credential records through separate code paths.

Do not toggle the implementation while a browser authorization is in flight.
The current client stores one raw verifier; the enterprise client stores a
versioned state-bound transaction envelope in the same encrypted transient
field. Neither path guesses how to reinterpret the other's pending value.
Wait for callbacks to finish or expire, then toggle and restart. Durable client
registrations and tokens remain compatible.

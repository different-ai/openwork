# `@openwork/enterprise-mcp-client`

Reference implementation for server-side remote MCP consumption in OpenWork.

The package owns the provider-neutral MCP/OAuth lifecycle. A composition root
supplies networking, persistence, tenancy/authorization, diagnostics, and the
clock. Den is one adapter; it is not embedded in the package architecture.

Den uses this package as its single runtime for new and existing MCP
connections. Existing OAuth registrations retain their stored callback URL;
new registrations use Den's deployment-wide shared callback.

## MCP 2026 core boundary

The package exports an SDK-independent foundation for the locked
`2026-07-28` release candidate while the live client continues to use the
stable `2025-11-25` SDK lifecycle:

- OpenWork-owned protocol policy, binding, status, and normalized-result types;
- deterministic `server/discover` parsing and capability hashing;
- fail-closed current/legacy selection with silent-downgrade protection;
- stateless current request metadata and Streamable HTTP routing headers;
- bounded JSON and SSE response parsing with legacy-session/version rejection;
- Base64-sentinel encoding and body/header validation for `Mcp-Name` and
  `x-mcp-header`-derived `Mcp-Param-*` values;
- nested/reference-aware `x-mcp-header` extraction that excludes one malformed
  tool without discarding an otherwise healthy catalog;
- tenant, connection, credential-owner, credential-revision, protocol, and
  capability-hash-separated ephemeral caching; and
- bounded JSON Schema 2020-12 composition and local-reference validation.

These exports are protocol primitives, not a production feature flag. Den
rejects `2026-07-28` requests with the standardized unsupported-version
response and advertises only the stable baseline. OpenWork must not advertise
or send current traffic until a stable official SDK,
the current and legacy wire adapters, Den persistence, OpenCode compatibility,
and the three-plane conformance suite are all present. Authentication, TLS,
issuer, malformed metadata, and provider errors are never fallback signals;
only a `server/discover` method-not-found response or another recognized
legacy-lifecycle outcome is eligible for legacy negotiation. A standardized
unsupported-version response identifies a modern server and must be handled
through its advertised supported-version list, never as an implicit fallback.

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
- Den supplies `application_type: web`, a deployment client-metadata URL, an
  exact authorization-server issuer binding, and the administrator-approved
  scope set. The SDK chooses pre-registration, client metadata, then DCR.
- `discoverConnectionRequirements` performs bounded, side-effect-free MCP,
  protected-resource, authorization-server, and unauthenticated tool discovery.
  It never performs DCR or writes application state.
- `scopes_supported` is treated as an availability declaration while an
  administrator or challenge selects scopes. When neither selects any, the
  client falls back to the provider-advertised set so providers with a
  scope-less challenge still receive a usable authorization request. It
  includes `offline_access` only when refresh support is advertised.
- New DCR client secrets are stored only in Den's encrypted client-secret
  column. Unencrypted JSON metadata excludes `client_secret` and
  `registration_access_token`.
- Access-token and client-secret expiration are absolute, validated values.
  An expired access token without a refresh token is invalidated and reported
  as reconnect-required. Refresh-token rotation preserves the previous refresh
  token when a valid provider omits it from the refresh response. Refresh
  commits compare the credential revision so a stale concurrent response cannot
  overwrite newer rotated credentials.
- MCP `isError: true` is a failed provider operation, not a successful request.
- Tool catalogs have page, item, cursor, name, schema depth, schema size, and
  aggregate-byte ceilings. JSON Schema 2020-12 composition branches, nodes,
  local-reference depth, unresolved references, external references, and
  reference cycles are also bounded or rejected.
- Current-protocol routing metadata rejects header/body mismatches. The client
  never emits legacy session state; a modern server ignores a stale legacy
  request header as required by the compatibility rules and rejects a response
  that attempts to mint or echo a legacy session. Unsafe routing values use the
  draft's Base64 sentinel encoding, and tool annotations can produce only
  `Mcp-Param-*` headers.
- Ephemeral protocol caches remain tenant- and credential-owner-scoped even
  for provider-declared public results. Authorization or capability changes
  can invalidate the relevant organization/connection/member slice without
  relying on protocol sessions.
- Diagnostic events contain phases, outcome, duration, and HTTP status only.
  They never contain tokens, API keys, codes, PKCE verifiers, URLs, tool
  arguments, provider bodies, or customer content; a failing sink is isolated.
- Connection deletion and enterprise credential commits take the same Den row
  lock, so deletion and a late callback have one deterministic winner.

See [CONFORMANCE.md](./CONFORMANCE.md) for exact source pins, qualified
surfaces, and the promotion gate; [SECURITY.md](./SECURITY.md) for the
expiration/validation contract; and
[PRIOR-FINDINGS.md](./PRIOR-FINDINGS.md) for the earlier MCP findings that were
incorporated, delegated to Den, or intentionally kept outside this server-side
package.

## Runtime boundary

The package covers Den's outbound server-side remote MCP client only. It does
not change local/direct engine MCP, the incoming OpenWork Cloud meta-MCP,
desktop UI, or provider-specific tenant administration.

Den uses this package as its only remote MCP OAuth runtime. New connections use
the deployment-wide shared callback. Existing connection rows retain their
stored callback mode and reconnect with that exact redirect URI, so no callback
migration, credential rewrite, or token copy is required. Version-one legacy
authorizations already in flight remain valid only through their original
per-connection callback and normal expiration window.

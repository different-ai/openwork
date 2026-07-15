# External MCP OAuth administration

OpenWork discovers and authorizes Den-managed external MCP connections without
placing provider credentials in the agent engine. Tokens, refresh tokens,
client secrets, PKCE verifiers, and pending authorization transactions remain
encrypted in Den.

## Required public origin

Set `DEN_API_PUBLIC_URL` to the externally reachable HTTPS base URL for the Den
deployment. OpenWork derives both public OAuth URLs exclusively from this
configured origin; request host headers cannot replace it.

- Shared callback: `<DEN_API_PUBLIC_URL>/v1/mcp-connections/oauth/callback`
- Client metadata document: `<DEN_API_PUBLIC_URL>/oauth/client-metadata.json`

The client metadata document is public, contains no secrets, and describes
OpenWork as a web OAuth client. Each self-hosted Den deployment has its own
callback and metadata URL.

## OAuth engine selection

OpenWork keeps both Den-managed OAuth implementations available:

- **Previous flow (default):** the established MCP SDK client, including
  per-connection callbacks for untouched legacy connections.
- **Hardened client (opt-in):** `@openwork/enterprise-mcp-client`, including
  state-bound transaction persistence and the shared callback contract.

Workspace owners can opt an organization into the hardened client under
**Org settings → MCP OAuth engine**. The organization setting takes precedence
over `DEN_ENABLE_ENTERPRISE_MCP_CLIENT`; an unset organization follows that
deployment value. The environment value defaults to `false`, so a deployment
must explicitly opt in before the hardened client becomes the default for
organizations without an override. The effective engine and whether it comes
from the organization or deployment default are returned to the dashboard, but
the environment variable name is never exposed to the browser.

## Add a connection

In Cloud → Connections, enter the MCP server URL and select **Discover
requirements**. Discovery is side-effect free: it does not create a connection,
register an OAuth client, open a browser, or save credentials. It reports MCP
initialization, RFC 9728 protected-resource metadata, authorization servers,
PKCE and refresh support, registration choices, scopes, visible tools, and any
network or administrator work that standards metadata cannot prove.

When authorization starts, OpenWork uses this registration priority:

1. An administrator-supplied pre-registered client.
2. A client metadata URL (CIMD) when the authorization server advertises it.
3. Dynamic client registration when the server advertises a registration endpoint.
4. A configuration-required result with the missing manual steps.

Required challenge scopes are locked. Administrators may select optional
advertised scopes and edit the saved scope set later. When neither the 401
challenge nor the administrator selects scopes, OpenWork falls back to the
provider's advertised `scopes_supported` set; this preserves compatibility
with providers that reject scope-less authorization requests. A configured
scope set still takes precedence. `offline_access` is requested only when both
that scope and refresh-token support are advertised.

## Callback migration

New OAuth connections use the previous per-connection callback by default.
Organizations that explicitly enable the enterprise MCP engine create new
connections with the deployment-wide shared callback. Existing
dynamically registered clients are cleared and registered again against the
shared callback on their next explicit authorization. Existing manually
registered clients keep their connection-specific legacy callback until an
administrator copies the shared URL, adds it to the external OAuth application,
confirms that step, and selects **Reconnect using shared callback**. That action selects
the shared callback, clears old tokens and pending authorizations, and starts a
new authorization while preserving the manually entered client ID, client
secret, access grants, and plugin bindings.

For a pre-registered client, **Revert to previous callback** restores the
connection-specific callback. It clears tokens and pending authorizations,
rewrites the stored public redirect URI while preserving the manual client and
secret, and removes SDK-created registrations so they can be registered again.
Keep the workspace on the previous OAuth engine before reconnecting a reverted
connection. Migration and reversion both require an administrator with a fresh
session and preserve access grants, plugin bindings, and other members' saved
credentials.

The legacy callback route accepts version-two transactions only when their
signed callback mode and connection binding both select `legacy-v1`.
Version-one authorization transactions remain statically bound to the previous
client for their original ten-minute lifetime.
Deleting and recreating a connection remains a recovery option, but it can
remove access grants, per-member authorization state, and plugin or marketplace
bindings, so use the guided reconnect flow first.

Changing the MCP server identity or selected issuer clears tokens and pending
authorization state. An issuer change also clears the saved client registration
so a secret can never be sent to a newly selected issuer.

## Troubleshooting

- **Configuration required**: supply a manually registered client when neither
  client metadata nor dynamic registration is advertised.
- **Issuer mismatch**: repeat discovery and select an issuer advertised by the
  protected resource. Metadata must return that exact issuer.
- **Reauthorization required**: the refresh grant is missing, expired, rejected,
  or bound to an older issuer/client registration.
- **Network trust required**: verify Den's proxy, private CA, DNS, firewall, and
  service-mesh egress. Discovery uses the same Den network policy as live MCP calls.
- **Additional permission required**: review and approve the newly challenged
  scope before reconnecting; OpenWork does not silently expand access.
- **Provider identity/verification page after authorize**: leave requested
  scopes empty only when the provider advertises the complete workable set, or
  edit the connection's requested scopes and reconnect.
- **`redirect_uri did not match` after shared-callback migration**: add the
  shared callback to the provider while keeping the previous callback, then
  reconnect. If the provider cannot be changed yet, revert the connection and
  use the previous OAuth engine.

OAuth logs and support data use phase/error codes and omit tokens, secrets,
authorization codes, signed state, PKCE verifiers, and URL query strings.

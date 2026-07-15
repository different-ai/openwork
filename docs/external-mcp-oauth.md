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
advertised scopes. `offline_access` is requested only when both that scope and
refresh-token support are advertised. OpenWork never treats the entire
`scopes_supported` list as a permission request.

## Callback migration

New OAuth connections always use the deployment-wide shared callback. Existing
dynamically registered clients are cleared and registered again against the
shared callback on their next explicit authorization. Existing manually
registered clients keep their connection-specific legacy callback until an
administrator copies the shared URL, adds it to the external OAuth application,
and selects **Reconnect using shared callback**. That action permanently selects
the shared callback, clears old tokens and pending authorizations, and starts a
new authorization while preserving the manually entered client ID, client
secret, access grants, and plugin bindings. There is no ordinary configuration
or action that returns a migrated connection to the legacy callback.

The legacy callback route remains available only for untouched legacy
connections and version-one authorization transactions already in progress.
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

OAuth logs and support data use phase/error codes and omit tokens, secrets,
authorization codes, signed state, PKCE verifiers, and URL query strings.

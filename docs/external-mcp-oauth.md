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
- Existing connection callback: `<DEN_API_PUBLIC_URL>/v1/mcp-connections/<connection-id>/connect/callback`
- Client metadata document: `<DEN_API_PUBLIC_URL>/oauth/client-metadata.json`

The client metadata document is public, contains no secrets, and describes
OpenWork as a web OAuth client. Each self-hosted Den deployment has its own
callback and metadata URL.

## OAuth runtime and callback compatibility

Den uses `@openwork/enterprise-mcp-client` for discovery, authorization,
refresh, tool discovery, and tool calls. There is no deployment or workspace
runtime switch.

New OAuth connections use the deployment-wide shared callback. An existing
connection keeps the callback mode already stored on its row, including the
older per-connection callback. Reconnecting therefore uses the exact redirect
URI that was registered with the provider and does not rewrite credentials,
tokens, access grants, or plugin bindings.

One exception keeps stored state truthful: when a row still carries a
per-connection callback mode but its administrator-supplied client recorded the
shared callback as its registered redirect, starting authorization records the
shared mode on that row. The redirect sent to the provider, the client
registration, credentials, grants, and bindings do not change; only
transactions signed with the stale mode keep failing closed.

## Public-domain changes

`mcpOauthDomainRecovery` is available on Cloud and self-hosted deployments and
starts **off**. Enable it through the feature registry rollout controls (or the
self-hosted operator lock) after updating `DEN_API_PUBLIC_URL`. Request hosts
never select the replacement callback. Turning it off stops further automatic
replacement; it does not undo a completed provider registration or delete data.

With recovery enabled, an explicit Connect/reconnect detects a recorded
callback on a different public origin. It keeps the stored callback **mode**
(shared or per-connection). The intentional hosted web-proxy compatibility
callback is not treated as an obsolete domain.

- **Dynamic / client-metadata registrations:** when authorization is needed,
  Den requests a replacement using the active public callback and the provider's
  advertised registration mechanisms. It does not assume dynamic registration
  exists or bypass provider approval. The old registration stays saved until a
  replacement is successfully persisted; a discovery or registration failure
  leaves it available for ordinary calls/refreshes. Concurrent registration
  attempts cannot overwrite an administrator-supplied client or a newer winner.
- **Administrator-supplied clients:** Connect returns a configuration-required
  warning naming the new callback. An organization admin updates the existing
  OAuth application's redirect allowlist in the provider console, then saves
  the same client ID in Connections and reconnects. Omitting the secret retains
  the saved secret. Saving confirms the provider change; Den cannot verify the
  provider console or alter its allowlist itself.

No connection deletion is needed: connection IDs, access grants, tool policies,
plugin bindings and account rows stay in place. Ordinary calls do not migrate a
registration or discard working tokens just because the origin changed. When
an automatically registered client is successfully replaced, existing access
tokens and scopes remain, but refresh grants and pending PKCE transactions
bound to the old client are cleared for all identities on that connection.
Members with still-valid access tokens can continue until they need to sign in
again; an old refresh token is never sent with the replacement client. Existing
revision and single-use checks reject callbacks from replaced registrations.

## Add a connection

In Cloud → Connections, enter the MCP server URL. OpenWork automatically runs
discovery after the URL settles; there is no separate discovery step. A failed
check shows its error and a retry action. Discovery is side-effect free: it does
not create a connection, register an OAuth client, open a browser, or save credentials. It reports MCP
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

## Callback routing

The callback mode is persisted and bound into signed OAuth state. The shared
route accepts only shared-callback transactions; the per-connection route
accepts only transactions for that connection whose signed mode is
`legacy-v1`. Version-one transactions already in flight remain bound to the
legacy verifier for their original ten-minute lifetime.

The dashboard links to the redirect URL documentation from pre-registered OAuth
app forms instead of repeating callback and client-metadata URLs on every
connection. It does not offer migration or rollback actions. Deleting and
recreating a connection creates a new shared-callback registration and may
remove access grants, per-member authorization state, and plugin or marketplace
bindings.

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
- **OAuth client rejected** (`invalid_client`, for example "unsupported client
  authentication method"): the provider refused the client credentials or
  authentication method. A registration Den created dynamically is discarded and
  registered again on the next sign-in. An administrator-supplied client is kept
  as saved, with its registered callback; compare its client ID, secret, and
  token endpoint authentication method with the provider application, then sign
  in again. Rejected tokens are cleared either way.
- **Network trust required**: verify Den's proxy, private CA, DNS, firewall, and
  service-mesh egress. Discovery uses the same Den network policy as live MCP calls.
- **Additional permission required**: review and approve the newly challenged
  scope before reconnecting; OpenWork does not silently expand access.
- **Provider identity/verification page after authorize**: leave requested
  scopes empty only when the provider advertises the complete workable set, or
  edit the connection's requested scopes and reconnect.
- **`redirect_uri did not match`**: verify the exact callback derived from
  `DEN_API_PUBLIC_URL` against the provider registration. Some providers take a
  short time to propagate callback changes before authorization succeeds.

OAuth logs and support data use phase/error codes and omit tokens, secrets,
authorization codes, signed state, PKCE verifiers, and URL query strings.

# Den API MCP Exposure Policy

The MCP catalog is generated from `openapi.json`, then filtered by `policy.ts` before tools are registered.

For third-party client setup and `invalid_target` troubleshooting, see
[Connect a third-party MCP client with OAuth](../../../../../docs/mcp-client-oauth.md).

## Allowed Tags

Every tagged Den API product surface is allowed unless it is listed under blocked tags or blocked operation IDs:

- `API Keys`
- `Capability Sources`
- `Config Objects`
- `Connectors`
- `Desktop Policies`
- `GitHub`
- `Invitations`
- `LLM Providers`
- `Marketplaces`
- `Members`
- `Organizations`
- `Plugins`
- `Roles`
- `Teams`
- `Users`
- `Worker Activity`
- `Worker Runtime`
- `Workers`

`Desktop Policies` reads require org admin; mutations require super-admin + Enterprise entitlement. Both are enforced in-route.

## Blocked Tags

These tags are intentionally excluded from MCP:

- `Admin`: internal administrative controls should not be broadly exposed as agent tools.
- `Authentication`: OAuth/session plumbing is used to authorize MCP, not exposed through MCP.
- `System`: health, docs, and other service metadata are not product actions.
- `Webhooks`: external webhook ingress routes require provider signatures and should not be invoked by agents.

## Blocked Paths

Routes are blocked if their path:

- starts with `/api/auth`
- contains `/admin`
- contains `/webhooks`

This catches auth/admin/webhook routes even if they are untagged or incorrectly tagged.

## Blocked Operation IDs

These individual operations are blocked even though their tags may otherwise be allowed:

- `postApiKeys`: creating API keys returns credentials and should stay behind explicit UI/API flows.
- `postV1ApiKeys`: generated OpenAPI ID for creating API keys.
- `deleteApiKeysByApiKeyId`: destructive credential revocation should stay behind explicit UI/API flows.
- `deleteV1ApiKeysByApiKeyId`: generated OpenAPI ID for deleting API keys, if present.
- `deleteOrg`: defensive block for organization deletion if a route is added.
- `deleteV1Org`: defensive block for organization deletion if a route is added.
- `deleteV1OrgsByOrgId`: defensive block for organization deletion if a route is added.
- `postWorkersByWorkerIdTokens`: worker token minting returns credentials and should stay behind explicit UI/API flows.
- `postV1WorkersByWorkerIdTokens`: generated OpenAPI ID for worker token minting.
- `postOauthProvidersByProviderIdDisconnect`: removing a connected OAuth credential is a mutation that should stay behind explicit UI/API flows, not an agent-callable tool.
- `postV1OauthProvidersByProviderIdDisconnect`: generated OpenAPI ID for disconnecting an OAuth provider.

## Untagged Operations

Untagged operations are excluded by default. Today these are OAuth/MCP discovery and registration routes, for example:

- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration`
- `/.well-known/oauth-protected-resource`
- `/api/auth/oauth2/authorize`
- `/api/auth/oauth2/register`
- `/register`

They are required for OAuth/MCP setup, but should not appear as callable MCP tools.

### Apps as MCP servers

`create_app`, `update_app`, and `read_app` on `/mcp/agent` build Apps; they are
not App launch surfaces. Each App is a Plugin config object served as its own
MCP server at `/mcp/agent/connections/<appId>`, beside directly exposed
connections, so OAuth resource matching and desktop index reconciliation work
unchanged. That server lists only `open_app` (fixed `ui://` revision binding),
the App's declared tools, and its revision resources.

A declared tool binds one exact capability. Publishing resolves it as the
author (Code Mode tool tree, or accessible Workflows) and stores its argument
shape, input schema, and Den-verified read-only flag in the revision. Calls run
through the ordinary executor as the caller: `api` tools take `{ path, query,
body }`, `mcp` and Workflow tools take the capability's own arguments, and
`live` Workflow tools run read-only with only an optional `timeZone`.
Plugin access is rechecked on every request; unavailable Apps return a
JSON-RPC error. The Connect server index lists accessible Apps with
`exposeDirectly: true`, capped with connections at the desktop limit of 100.
Search returns each App as `kind: mcp_app`; executing it returns an
`openwork/mcpApp` launch reference to the App's own server.

Where `create_app` is available, Workflow-bound views are read-only:
`save_artifact_view` (create or edit), `activate_artifact_view_revision`, and
the REST save and activate routes return `legacy_view_read_only`. Existing views
keep their render, preview, run, and resource paths, and can still be retired.

`DEN_APP_MCP_SERVERS_ENABLED` (default `true`) gates all of this per
deployment, together with each organization's member-facing MCP connections
setting. `false` restores the previous surface: no builder tools or App
servers, the original `save_artifact_view` guidance, and writable
Workflow-bound views. Eval Dens that enable generated artifact views default it
to `false` so older Workflow-bound journeys keep testing that mode.

### Live generated apps

GeneratedArtifactView.dataMode is optional on the wire. An absent value means
legacy snapshot; new save_artifact_view calls persist live by default.
The mode is immutable for a view. Migration 0101_artifact_view_data_mode
preserves existing rows as snapshots.

Live views expose run_artifact_<id> alongside render and preview tools.
All three execute the current saved Workflow as the authenticated caller,
using only exact declared capabilities whose current Den authority marks them
read-only. Normal explicit Workflow runs and Automation authority are unchanged.
A view's output schema must match the current version before execution.

The only live run argument is optional timeZone, an IANA zone, defaulting to
UTC. Desktop callers should supply Intl.DateTimeFormat().resolvedOptions().timeZone.
The Workflow receives input.runtime with now (ISO instant), today (YYYY-MM-DD),
timeZone, dayStart (ISO instant), and dayEnd (exclusive ISO instant). The server
computes these values for every run, including daylight-saving changes.
Author Workflow input schemas to accept that runtime object; example inputs
and creation dates are never reused. Arbitrary inputs and receipt overrides
are rejected.

GET /v1/apps/:appId also executes live views, accepts timeZone, and returns
Cache-Control: private, no-store. A failed run returns a null payload and an
optional structured runError, including connection status/card details when
available. MCP failures retain those details and connection cards.

Receipts, detail results, and snapshot pages are caller-private, including for
organization admins. Sharing an app shares the Workflow and view, never a
personal receipt. Explicit snapshot creation rejects capability-dependent
Workflows, including Google and other personal integrations. External metadata
hints cannot establish non-personal data. This contract does not provide a
cross-member snapshot-data sharing override; legacy snapshots and Automation
results remain readable by their own caller.

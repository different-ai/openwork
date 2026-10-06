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
author, looking up only that capability (the Workflow, one connection's tool
list, or the Den operation), and stores its argument shape, input schema, and
read-only flag in the revision. Den and native GET operations and `live`
Workflows are read-only. A connection tool is read-only when its provider marks
it `readOnlyHint: true` and not destructive, as the author's tool list shows at
publish; search results carry the same `readOnly` label. Den and native writes
are refused as App tools; other connection tools and Workflow runs with input
are not read-only, so hosts ask before each call. The App server advertises the
flag, but every connection-tool call still needs `mcp:write`, as all external
dispatch does.

Calls run through the ordinary executor as the caller. `api` tools take
`{ path, query, body }` and are rechecked as GETs on every call; `mcp` tools
take the tool's own arguments and fail closed once the provider's input schema
no longer matches the published digest, or, for a read-only binding, once the
caller's live tool list no longer marks the tool read-only; the App then gets a
`policy_blocked` error naming its tool. Workflow tools take the Workflow's
input, and `live` ones run read-only with only an optional `timeZone`. Results
drop the `openwork/mcpApp` and `openwork/serverTools` hints, which name tools on
`/mcp/agent`. Plugin access is rechecked on every request; unavailable Apps
return a JSON-RPC error.

`create_app` and `update_app` add each bound Workflow to the App's Plugin and
route its tool through that Plugin, so sharing the Plugin shares the Workflows;
adding one requires Workflow manager access. `update_app` keeps omitted
`cssSource`, `description`, and `tools`, reusing stored bindings as published.

The Connect server index lists accessible Apps only to the App host
(`mcp-app-host-v1` with the app-host scope), with `exposeDirectly: false`, so
their tools never become model-facing servers. Apps fill only the room
connections leave under the desktop limit of 100. Search returns each App that
fits beside every usable connection as `kind: mcp_app`, and executing it returns
an `openwork/mcpApp` launch reference to the App's own server; an App past the
limit keeps its MCP URL but gets no launch.

Organization Dashboards can hold Apps too. `GET /v1/mcp-apps` lists the Apps
the calling admin can use in the dashboard element shape (`connectionId` is the
App id, `toolName` is `open_app`), which Den web's Add app picker offers as
"Apps built in OpenWork". Every dashboard read, including the desktop's
`GET /v1/me/dashboards`, serves such an element with the App's current
revision, so `update_app` never strands an assigned tile; a member still needs
the App's Plugin to open it.

Workflow-bound generated Artifact views ("saved apps", `save_artifact_view`
and its sibling tools, `DEN_GENERATED_ARTIFACT_VIEWS_ENABLED`) are retired
(D36). Their tables are kept but unread. `routes/org/legacy-saved-apps.ts`
keeps the routes published desktops still call, hidden from OpenAPI and MCP:
`GET /v1/apps` answers `{ enabled: false, sharingEnabled: false, items: [] }`
and the others answer 404 `artifact_view_not_found`.

Building your own Apps is on for every organization. It needs
`DEN_APP_MCP_SERVERS_ENABLED` (default `true`; `false`, `0`, `off`, or `no`
turns it off for the deployment) and the organization's member-facing MCP
connections. `appMcpServersEnabled` in `mcp-app-rollout.ts` combines the two,
and `GET /v1/org` reports the result as the `appMcpServers` capability. The
retired per-organization `appMcpServers` override is ignored and dropped on the
next admin capabilities write. Where it is off, an organization has no app
builder: no builder tools or App servers, the original connection index, and
agent guidance that offers Workflow results instead. MCP Apps from connected
MCP servers work either way. Eval Dens default the deployment flag to `false`;
the App journeys set it to `true`.

### Live Workflows

Live Workflow runs (an App tool bound in mode live, or
`execute_capability_script` with mode live) execute the current saved Workflow
as the authenticated caller.

The only live run argument is optional timeZone, an IANA zone, defaulting to
UTC. Desktop callers should supply Intl.DateTimeFormat().resolvedOptions().timeZone.
The Workflow receives input.runtime with now (ISO instant), today (YYYY-MM-DD),
timeZone, dayStart (ISO instant), and dayEnd (exclusive ISO instant). The server
computes these values for every run, including daylight-saving changes.
Author Workflow input schemas to accept that runtime object; example inputs
and creation dates are never reused. Arbitrary inputs and receipt overrides
are rejected.

Receipts, detail results, and snapshot pages are caller-private, including for
organization admins. Sharing a Workflow never shares a personal receipt. Explicit snapshot creation rejects capability-dependent
Workflows, including Google and other personal integrations. External metadata
hints cannot establish non-personal data. This contract does not provide a
cross-member snapshot-data sharing override; legacy snapshots and Automation
results remain readable by their own caller.

# Den API MCP Exposure Policy

The MCP catalog is generated from `openapi.json`, then filtered by `policy.ts` before tools are registered.

For third-party client setup and `invalid_target` troubleshooting, see
[Connect a third-party MCP client with OAuth](../../../../../docs/mcp-client-oauth.md).

## Gateway discovery metadata

`/mcp/agent` identifies itself as **OpenWork Connect** during initialization,
including its purpose, public website, and scalable public SVG icon. Initialization
keeps critical routing and safety guidance within 2048 UTF-8 bytes. Agents read
`openwork://agent/guidance.md` for the full operating rules; those rules are retained
rather than silently truncated. App authoring details live in `build-an-app`.

The fixed connection-action and Workflow-artifact views share one HTTPS widget
origin and advertise descriptions through resource `_meta`, never resource
annotations. Invocation labels live on their tools.

`execute_capability_script` declares the schema of its structured authoring-test
result. `execute_capability` deliberately has no output schema: it forwards
heterogeneous provider results, some with structured content and some text-only.
The installed MCP server SDK rejects a successful text-only result whenever an
output schema is registered. Advertising even an unconstrained object schema
would break those existing calls; a checker should accept this optional-structured
proxy case rather than require a fabricated result shape or runtime conversion.

## One Connect tool rollout

`connectStandardTools` is off by default on cloud and self-hosted. It controls
both the full tool view below and capability-search schemas, including bounded
connection proxies. Use its existing deployment, organization and member controls
in `/admin` for rollout; the kill switch overrides every allowlist or override.
There is no separate desktop or schema switch. The retired `connectToolShapes`
and `desktopConnectStandardTools` keys are ignored; existing state for
`connectStandardTools` remains authoritative.

Off, `search_capabilities` keeps the legacy `summary`, `argumentsSchema`,
`invocation`, and API `pathParams`/`queryParams`/`bodySchema` fields. Tool schemas,
initialization instructions, and the guidance resource describe `path/query/body`
calls. On, search matches add MCP `description`/`inputSchema`/`annotations` next
to the older fields and guidance uses `execute_capability({ name, arguments })`.
Both call forms remain accepted in either state, so turning the rollout off does
not invalidate calls from cached search-tool lists.

## Full tool view

With `connectStandardTools` on, clients that search large tool lists themselves
get every connection action, Workflow, App and remote session the member may use
as its own tool instead of `search_capabilities` and `execute_capability`
(`connect-tool-view.ts`). The supported-client allowlist recognizes Claude Code
and standalone OpenCode v2 by the request's `io.modelcontextprotocol/clientInfo`.
OpenWork Desktop, Web and headless runs report OpenCode's name but hold a token
Den minted for OpenWork (`/v1/mcp/token` or a run token), so they keep
`search_capabilities` and `execute_capability`, whose search ranks better than
the engine's own. `?tools=full` or `?tools=search` overrides the choice only
while the flag is on. Unknown, missing and 2025-era clients keep the search
view unless explicitly opted in. Off always restores the search view.

OpenWork's own engine has its own rollout, `connectEngineTools`
(`engine-tool-view.ts`, docs/features/connect-engine-tools). With it on, the
engine gets the full view whatever `connectStandardTools` says, plus
`search_capabilities` and `execute_capability` for OpenWork's own operations and
skills, which have no tool of their own (search leaves out every source the
full view lists, except for an explicit connect request). Its instructions list
the member's connected services by tool-name prefix, and its tool descriptions
carry related words from Den's synonym table, because the engine's own search
ranks plain keywords.

Tools are named like their Code Mode calls (`linear.list_issues`), at most 64
characters, and run through the executor `execute_capability` uses. Only
external MCP tools advertise an output schema: the provider promises structured
results for them, while Den's own routes return text. OpenWork's role-gated API
operations stay in the search view, except the key request a connection card
names. `connection_status` shows the card for a connection that is not ready. A write that changes what an organization's
members may use sends `notifications/tools/list_changed` to its full-view streams
on the same replica; the `tools/list` cache hint (60 s, private) covers the rest.

## Slack messages from the OpenWork bot

`slack_send_as_bot` (`slack-send-as-bot.ts`, generally available without a
rollout flag) is a Den-native capability next to the Slack connection's tools: a DM
to the caller or a channel post from the OpenWork Slack app's bot, instead of
as the member (`slack_send_message`). It needs a member and `mcp:write`, so
read-only tokens never list or run it, and it is not in Code Mode scripts. Limits
(20 a day, 5 a minute, no repeat of the same text to the same place within 24
hours) are enforced in the tool. See
[docs/features/slack-send-as-bot](../../../../../docs/features/slack-send-as-bot/README.md).

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
- `Workers`

`Desktop Policies` reads require org admin; mutations require admin (the `desktop_policies.manage` permission) + Enterprise entitlement. Both are enforced in-route.

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
- `postOauthProvidersByProviderIdDisconnect`: removing a connected OAuth credential is a mutation that should stay behind explicit UI/API flows, not an agent-callable tool.
- `postV1OauthProvidersByProviderIdDisconnect`: generated OpenAPI ID for disconnecting an OAuth provider.

## Removing connections

The dashboard's `DELETE /v1/mcp-connections/{connectionId}` stays blocked
(`Authentication`), so no agent request can delete a connection. Agents
prepare one with `requestMcpConnectionRemoval`
(`POST /v1/mcp-connections/{connectionId}/removal-request`), available to all
organizations but offered only to a person's own agent, never unattended
Workflows, Automations or Apps (`usageSource: "agent"`, see `catalog-availability.ts`).
It checks the same permissions as the dashboard (`connections.delete`, or
having added the connection), requires the connection's exact
`expectedName` (409 `connection_name_mismatch`), and refuses a connection
active plugins need (409 `connection_in_use`, with `requiredBy`) unless the
user agreed to `detachFromPlugins`. It deletes nothing: it returns
`status: "confirmation_required"` and a `handoff` link to the connector page,
which opens its Remove confirmation. The person removes it there, signed in,
through the dashboard DELETE; the agent then lists connections to check.
Approval therefore never rests on a value the agent sends.

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

Agents learn App building from one owner per rule. Server instructions only
route App requests to the built-in `build-an-app` skill
(`skill://build-an-app/SKILL.md`, listed while App servers are on), which owns
the order of calls and the quality bar. `prepare_app` returns a starter wired
to the verified tools: `lookup` when every tool reads, `action` when one
changes data, `standalone` with none; the same three are resources at
`openwork://apps/starters/<pattern>.json`. `create_app`'s concise description
routes agents to `build-an-app` for the source, tool-call, approval, and caching
rules the compiler and host enforce. Add detailed rules to the skill rather
than growing the discovery payload.

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

`GET /v1/mcp-apps` lists the Apps the calling member can use in the dashboard
element shape (`connectionId` is the App id, `toolName` is `open_app`), which
the desktop offers on the personal Dashboard; a member still needs the App's
Plugin to open it.

Where `create_app` is available, Workflow-bound views are read-only:
`save_artifact_view` (create or edit), `activate_artifact_view_revision`, and
the REST save and activate routes return `legacy_view_read_only`. Existing views
keep their render, preview, run, and resource paths, and can still be retired.

Building your own Apps is on for every organization. Only
`DEN_APP_MCP_SERVERS_ENABLED` (default `true`; `false`, `0`, `off`, or `no`
turns it off for the deployment) gates it, and `GET /v1/org` reports it as the
`appMcpServers` capability. The
retired per-organization `appMcpServers` override is ignored and dropped on the
next admin capabilities write. Where it is off, an organization keeps the
previous surface: no builder tools or App servers, the original connection index
and `save_artifact_view` guidance, and writable Workflow-bound views. MCP Apps
from connected MCP servers work either way. Eval Dens default the deployment
flag to `false` so older Workflow-bound journeys keep testing that mode; the
App journeys set it to `true`.

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

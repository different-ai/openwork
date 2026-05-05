# Den API MCP Exposure Policy

The MCP catalog is generated from `openapi.json`, then filtered by `policy.ts` before tools are registered.

## Allowed Tags

Every tagged Den API product surface is allowed unless it is listed under blocked tags or blocked operation IDs:

- `API Keys`
- `Config Objects`
- `Connectors`
- `GitHub`
- `Invitations`
- `LLM Providers`
- `Marketplaces`
- `Members`
- `Organizations`
- `Plugins`
- `Roles`
- `Skill Hubs`
- `Skills`
- `Teams`
- `Users`
- `Worker Activity`
- `Worker Runtime`
- `Workers`

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

## Untagged Operations

Untagged operations are excluded by default. Today these are OAuth/MCP discovery and registration routes, for example:

- `/.well-known/oauth-authorization-server`
- `/.well-known/openid-configuration`
- `/.well-known/oauth-protected-resource`
- `/api/auth/oauth2/authorize`
- `/api/auth/oauth2/register`
- `/register`

They are required for OAuth/MCP setup, but should not appear as callable MCP tools.

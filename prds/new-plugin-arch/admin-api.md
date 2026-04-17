# New Plugin Arch Admin API

This document describes the authenticated admin/API-consumer surface for managing the new plugin architecture.

Use this for:

- OpenWork admin UI
- direct authenticated API clients
- backend route planning

Base prefix:

- `/v1/orgs/:orgId/...`

## Principles

- expose logical resources, not raw tables;
- return current projections for current-state list/detail endpoints;
- keep version history endpoints explicit;
- keep connector sync async and observable;
- keep type-specific convenience endpoints optional but available where UI clarity benefits.

Current implementation note:

- until dedicated org-capability persistence exists, create/manage-account style admin actions are gated by org owner/admin membership in the endpoint layer.

## Config objects

### List/search config objects

- `GET /v1/orgs/:orgId/config-objects`

Suggested query params:

- `type`
- `status`
- `sourceMode`
- `pluginId`
- `connectorInstanceId`
- `q`
- `limit`
- `cursor`
- `includeDeleted`

Returns one row per config object, not one row per version.

### Get one config object

- `GET /v1/orgs/:orgId/config-objects/:configObjectId`

### Create config object

- `POST /v1/orgs/:orgId/config-objects`

Suggested body shape:

```json
{
  "type": "skill",
  "sourceMode": "cloud",
  "pluginIds": ["plugin_123"],
  "input": {
    "rawSourceText": "...",
    "parserMode": "opencode"
  }
}
```

### Create a new version for an object

- `POST /v1/orgs/:orgId/config-objects/:configObjectId/versions`

Suggested body shape:

```json
{
  "input": {
    "rawSourceText": "..."
  },
  "reason": "manual edit"
}
```

### Lifecycle endpoints

- `POST /v1/orgs/:orgId/config-objects/:configObjectId/archive`
- `POST /v1/orgs/:orgId/config-objects/:configObjectId/delete`
- `POST /v1/orgs/:orgId/config-objects/:configObjectId/restore`

### Object/plugin membership endpoints

- `GET /v1/orgs/:orgId/config-objects/:configObjectId/plugins`
- `POST /v1/orgs/:orgId/config-objects/:configObjectId/plugins`
- `DELETE /v1/orgs/:orgId/config-objects/:configObjectId/plugins/:pluginId`

### Object access endpoints

- `GET /v1/orgs/:orgId/config-objects/:configObjectId/access`
- `POST /v1/orgs/:orgId/config-objects/:configObjectId/access`
- `DELETE /v1/orgs/:orgId/config-objects/:configObjectId/access/:grantId`

## Config object versions

- `GET /v1/orgs/:orgId/config-objects/:configObjectId/versions`
- `GET /v1/orgs/:orgId/config-objects/:configObjectId/versions/:versionId`
- `GET /v1/orgs/:orgId/config-objects/:configObjectId/versions/latest`
- `GET /v1/orgs/:orgId/config-objects/:configObjectId/versions/compare?from=:versionA&to=:versionB`

## Type-specific convenience endpoints

These should sit on top of the shared config-object model.

### Skills

- `GET /v1/orgs/:orgId/skills`
- `POST /v1/orgs/:orgId/skills`
- `GET /v1/orgs/:orgId/skills/:configObjectId`
- `POST /v1/orgs/:orgId/skills/:configObjectId/versions`
- `POST /v1/orgs/:orgId/skills/validate`
- `POST /v1/orgs/:orgId/skills/preview`

### Agents

- `GET /v1/orgs/:orgId/agents`
- `POST /v1/orgs/:orgId/agents`
- `GET /v1/orgs/:orgId/agents/:configObjectId`
- `POST /v1/orgs/:orgId/agents/:configObjectId/versions`
- `POST /v1/orgs/:orgId/agents/validate`

### Commands

- `GET /v1/orgs/:orgId/commands`
- `POST /v1/orgs/:orgId/commands`
- `GET /v1/orgs/:orgId/commands/:configObjectId`
- `POST /v1/orgs/:orgId/commands/:configObjectId/versions`
- `POST /v1/orgs/:orgId/commands/validate`
- `POST /v1/orgs/:orgId/commands/render-preview`

### Tools

- `GET /v1/orgs/:orgId/tools`
- `POST /v1/orgs/:orgId/tools`
- `GET /v1/orgs/:orgId/tools/:configObjectId`
- `POST /v1/orgs/:orgId/tools/:configObjectId/versions`
- `POST /v1/orgs/:orgId/tools/analyze`
- `POST /v1/orgs/:orgId/tools/validate`

### MCPs

- `GET /v1/orgs/:orgId/mcps`
- `POST /v1/orgs/:orgId/mcps`
- `GET /v1/orgs/:orgId/mcps/:configObjectId`
- `POST /v1/orgs/:orgId/mcps/:configObjectId/versions`
- `POST /v1/orgs/:orgId/mcps/validate`
- `POST /v1/orgs/:orgId/mcps/:configObjectId/test-connection`
- `POST /v1/orgs/:orgId/mcps/:configObjectId/install-check`

## Plugins

- `GET /v1/orgs/:orgId/plugins`
- `GET /v1/orgs/:orgId/plugins/:pluginId`
- `POST /v1/orgs/:orgId/plugins`
- `PATCH /v1/orgs/:orgId/plugins/:pluginId`
- `POST /v1/orgs/:orgId/plugins/:pluginId/archive`
- `POST /v1/orgs/:orgId/plugins/:pluginId/restore`

### Plugin membership endpoints

- `GET /v1/orgs/:orgId/plugins/:pluginId/config-objects`
- `POST /v1/orgs/:orgId/plugins/:pluginId/config-objects`
- `DELETE /v1/orgs/:orgId/plugins/:pluginId/config-objects/:configObjectId`
- `GET /v1/orgs/:orgId/plugins/:pluginId/resolved`

### Optional plugin release endpoints

- `GET /v1/orgs/:orgId/plugins/:pluginId/releases`
- `POST /v1/orgs/:orgId/plugins/:pluginId/releases`
- `GET /v1/orgs/:orgId/plugins/:pluginId/releases/:releaseId`

### Plugin access endpoints

- `GET /v1/orgs/:orgId/plugins/:pluginId/access`
- `POST /v1/orgs/:orgId/plugins/:pluginId/access`
- `DELETE /v1/orgs/:orgId/plugins/:pluginId/access/:grantId`

## Connector accounts

- `GET /v1/orgs/:orgId/connector-accounts`
- `POST /v1/orgs/:orgId/connector-accounts`
- `GET /v1/orgs/:orgId/connector-accounts/:connectorAccountId`
- `POST /v1/orgs/:orgId/connector-accounts/:connectorAccountId/disconnect`

## Connector instances

- `GET /v1/orgs/:orgId/connector-instances`
- `POST /v1/orgs/:orgId/connector-instances`
- `GET /v1/orgs/:orgId/connector-instances/:connectorInstanceId`
- `PATCH /v1/orgs/:orgId/connector-instances/:connectorInstanceId`
- `POST /v1/orgs/:orgId/connector-instances/:connectorInstanceId/archive`
- `POST /v1/orgs/:orgId/connector-instances/:connectorInstanceId/disable`
- `POST /v1/orgs/:orgId/connector-instances/:connectorInstanceId/enable`

### Connector instance access endpoints

- `GET /v1/orgs/:orgId/connector-instances/:connectorInstanceId/access`
- `POST /v1/orgs/:orgId/connector-instances/:connectorInstanceId/access`
- `DELETE /v1/orgs/:orgId/connector-instances/:connectorInstanceId/access/:grantId`

## Connector targets

- `GET /v1/orgs/:orgId/connector-instances/:connectorInstanceId/targets`
- `POST /v1/orgs/:orgId/connector-instances/:connectorInstanceId/targets`
- `GET /v1/orgs/:orgId/connector-targets/:connectorTargetId`
- `PATCH /v1/orgs/:orgId/connector-targets/:connectorTargetId`
- `POST /v1/orgs/:orgId/connector-targets/:connectorTargetId/resync`

Example GitHub target body:

```json
{
  "type": "github",
  "remoteId": "org/repo",
  "targetKind": "repository_branch",
  "config": {
    "repositoryId": 123456,
    "repositoryFullName": "org/repo",
    "branch": "main",
    "ref": "refs/heads/main"
  }
}
```

## Connector mappings

- `GET /v1/orgs/:orgId/connector-targets/:connectorTargetId/mappings`
- `POST /v1/orgs/:orgId/connector-targets/:connectorTargetId/mappings`
- `PATCH /v1/orgs/:orgId/connector-mappings/:connectorMappingId`
- `DELETE /v1/orgs/:orgId/connector-mappings/:connectorMappingId`
- `POST /v1/orgs/:orgId/connector-mappings/:connectorMappingId/preview`

Example mapping body:

```json
{
  "mappingKind": "path",
  "selector": "/sales/skills/**",
  "objectType": "skill",
  "pluginId": "plugin_123",
  "autoAddToPlugin": true,
  "config": {
    "parserMode": "opencode"
  }
}
```

## Connector sync events

- `GET /v1/orgs/:orgId/connector-sync-events`
- `GET /v1/orgs/:orgId/connector-sync-events/:connectorSyncEventId`
- `POST /v1/orgs/:orgId/connector-sync-events/:connectorSyncEventId/retry`

## GitHub-specific admin endpoints

- `POST /v1/orgs/:orgId/connectors/github/setup`
- `POST /v1/orgs/:orgId/connectors/github/accounts`
- `GET /v1/orgs/:orgId/connectors/github/accounts/:connectorAccountId/repositories`
- `POST /v1/orgs/:orgId/connectors/github/validate-target`

## Response conventions

List:

```json
{
  "items": [],
  "nextCursor": null
}
```

Detail:

```json
{
  "item": {}
}
```

Mutation:

```json
{
  "ok": true,
  "item": {}
}
```

Async action:

```json
{
  "ok": true,
  "queued": true,
  "job": {
    "id": "job_123"
  }
}
```

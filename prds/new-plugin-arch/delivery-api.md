# New Plugin Arch Delivery API

This document covers the future API surface for delivering plugins and config objects to end clients.

This area is still less defined than the admin API.

## Purpose

Delivery endpoints should answer:

- what plugins a user/team can access;
- what config objects are currently resolved inside a plugin;
- what content a client should install;
- what version/state a client currently has.

## Principles

- delivery should expose resolved current state, not raw history by default;
- access checks should happen at plugin/object delivery boundaries;
- delivery endpoints should be separate from admin mutation endpoints;
- clients should be able to fetch manifests before downloading content.

## Likely resources

- accessible plugins
- plugin manifests
- config-object download payloads
- client install state
- optional plugin release snapshots

## Candidate endpoints

### List accessible plugins for a client/user

- `GET /v1/orgs/:orgId/delivery/plugins`

Suggested query params:

- `teamId`
- `q`
- `limit`
- `cursor`

### Get one deliverable plugin

- `GET /v1/orgs/:orgId/delivery/plugins/:pluginId`

### Get plugin download manifest

- `GET /v1/orgs/:orgId/delivery/plugins/:pluginId/manifest`

Purpose:

- return the resolved current set of config objects and install metadata without forcing immediate download of all payloads.

Likely response shape:

```json
{
  "plugin": {
    "id": "plugin_123",
    "name": "Sales plugin"
  },
  "items": [
    {
      "configObjectId": "cfg_123",
      "type": "skill",
      "title": "mcp-arch",
      "versionId": "ver_123"
    }
  ]
}
```

### Download one plugin bundle

- `GET /v1/orgs/:orgId/delivery/plugins/:pluginId/download`

Purpose:

- provide the resolved content package for a plugin.

Open question:

- whether this should return one bundle blob, a manifest plus signed URLs, or structured JSON with embedded encrypted payloads.

### Download one config object

- `GET /v1/orgs/:orgId/delivery/config-objects/:configObjectId/download`

Purpose:

- allow targeted install/update of a single object.

### Optional release-aware delivery

If plugin releases become first-class:

- `GET /v1/orgs/:orgId/delivery/plugins/:pluginId/releases/:releaseId/manifest`
- `GET /v1/orgs/:orgId/delivery/plugins/:pluginId/releases/:releaseId/download`

## Client state endpoints

These likely matter once client sync/install flows are defined.

### Report client install state

- `POST /v1/orgs/:orgId/delivery/clients/:clientId/state`

Purpose:

- let a client report what plugins/config objects/versions are installed.

### Get client install state

- `GET /v1/orgs/:orgId/delivery/clients/:clientId/state`

### Compute client updates

- `POST /v1/orgs/:orgId/delivery/clients/:clientId/check-updates`

Purpose:

- compare installed state with accessible current state and return required updates.

## Recommended next decisions

We still need to lock down:

- rolling latest vs release snapshot delivery;
- manifest shape per config type;
- auth model for client delivery;
- how encrypted payloads are transported to clients;
- how install conflicts and local overrides are represented.

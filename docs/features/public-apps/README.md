# Publish an App publicly (`publicApps`)

- **Feature key:** `publicApps`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

An organization owner or admin who can edit an App built in OpenWork
publishes it at a public MCP URL:

```
https://<den-api>/mcp/public/apps/coffee-with-the-team
```

The last part is the App's **slug**. It defaults to one made from the App's
title, or the publisher chooses one: 3 to 48 lowercase letters, digits and
hyphens. Slugs are unique across the whole deployment, because the URL does
not name the organization. A slug stays with its App while unpublished, so an old URL never starts serving
another organization's App. Choosing a new slug retires the old URL.

Anyone can add that URL to Codex, Claude, ChatGPT or any other MCP client
without signing in to OpenWork. The server sends no OAuth challenge or
protected-resource metadata, so clients never start a sign-in. Visitors get
`open_app` and the App's UI resource. Nothing else from OpenWork is served.

Publishing pins the App's current revision. Later edits stay private until
someone publishes again, which keeps the same URL.

This first version publishes **Apps without tools** only. An App that
declares tools is refused with `public_app_has_tools`. A public App has no
signed-in person for its tools to run as, and that needs its own design.

## Routes

All three need an organization owner or admin, plus this feature. Agents
reach them through Connect like any other Den route.

- `GET /v1/public-apps`: the organization's public Apps, with their URLs.
- `PUT /v1/public-apps/:appId` with `{ "slug"?: string }`: publish, or pin
  the newest revision. The caller must also be able to edit the App. A slug
  another App uses is refused with `public_app_slug_taken`.
- `DELETE /v1/public-apps/:appId`: stop publishing right away.

## When the URL stops answering

Every request checks that:

- the App is still published;
- this feature is on for the organization;
- Apps built in OpenWork are on for the deployment;
- the App and its pinned revision still exist.

If any check fails, the visitor's client gets `This App is not available.`
Every reason reads the same to a visitor. Den logs the reason as
`public_mcp_app_refused`. Unpublishing or turning the feature off takes effect
on the next request. Publications are kept while the feature is off.

## Limits

Public requests are `POST` only, with bodies up to 64 KiB, and a visitor can
only open the App. Each request reads the publication from the database.
There is no per-visitor rate limit, so put an edge rate limit (a CDN or WAF
rule on `/mcp/public/*`) in front of den-api before publishing Apps widely.

## Try it

1. Turn `publicApps` on for your organization in `/admin`.
2. Build an App without tools (for example with `create_app`).
3. As an owner or admin, `PUT /v1/public-apps/<appId>` and copy `url`.
4. Add the URL to an MCP client that is signed out of OpenWork and call
   `open_app`.

## What to watch

- `public_mcp_app_refused` logs, by `reason`.
- `http_route` `/mcp/public/apps/:slug` in request logs.

## Code

- Den: `ee/apps/den-api/src/public-mcp-apps.ts` (publish, unpublish, the
  per-request checks), `ee/apps/den-api/src/mcp/public-app-server.ts` (the
  public MCP server) and `ee/apps/den-api/src/routes/org/public-apps.ts`.
- Database: `public_mcp_app` (`ee/packages/den-db/src/schema/public-mcp-apps.ts`).
  It stores one row per App and holds no credentials and nothing visitors send.
- Tests: `ee/apps/den-api/test/api/public-apps.api.test.ts`.

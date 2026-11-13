# Public artifacts without sign-in (`publicApps`)

> **Generally available:** `publicApps` is retired; the enabled behavior is now standard. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

- **Feature key:** `publicApps`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

Someone who can edit an artifact built in OpenWork, or their agent, marks it
public by passing `public: true` to `create_app` or `update_app`. The artifact is
then served at:

```
https://<den-api>/mcp/public/apps/<appId>
```

They can also give it a friendly name with `publicName`, such as
`coffee-with-the-team`, and the artifact is served there too:

```
https://<den-api>/mcp/public/apps/coffee-with-the-team
```

A name is 3 to 48 lowercase letters, digits and hyphens, and is unique across
the whole deployment, because the URL does not name the organization. A name
another artifact holds is refused with `public_name_taken`. Giving an artifact a new
name stops its old URL. A name stays with its artifact while the artifact is private,
so an old URL never starts serving another artifact.

Anyone can add that URL to an MCP client and open the artifact without signing in
to OpenWork. The server sends no OAuth challenge, so clients never start a
sign-in. Visitors get `open_app` and the artifact's UI. Nothing else is served.

Only an artifact **without tools** can be public. A visitor is not signed in, so
there is nobody for a tool to run as. Marking an artifact with tools public, or
adding tools to a public artifact, is refused with `public_app_has_tools`.

Visitors always see the artifact's current revision. Passing `public: false` to
`update_app` makes it private again. Leaving `public` out keeps the current
choice.

## When the URL stops answering

Every request checks that the artifact is active, its current revision is marked
public and has no tools, and this feature is on for its organization. If any
check fails the client gets `This artifact is not available.`, the same for every
reason. Turning the feature off stops every public artifact on the next request;
turning it back on brings them back.

## Search engines

Every answer at a public artifact URL is sent with `X-Robots-Tag: noindex,
nofollow, noarchive`, so search engines do not list the URL.

## Limits

Requests are `POST` only with bodies up to 64 KiB. There is no per-visitor
rate limit, so put an edge rate limit on `/mcp/public/*` before sharing
public artifacts widely.

## Try it

1. Turn `publicApps` on for your organization in `/admin`.
2. Ask an agent to build an artifact with no tools and make it public.
3. Add the public URL it returns to an MCP client that is signed out of
   OpenWork and call `open_app`.

## Code

- `ee/apps/den-api/src/mcp/public-app-server.ts`: the public MCP server.
- `ee/apps/den-api/src/mcp-apps.ts`: `requirePublishable` (the checks when an
  artifact is marked) and `loadPublicMcpApp` (the checks on every request).
- Database: `public_mcp_app_name` maps a friendly name to its artifact
  (`ee/packages/den-db/src/schema/public-mcp-app-names.ts`). Whether the artifact
  is public still comes from its current revision.
- Test: `ee/apps/den-api/test/api/public-apps.api.test.ts`.

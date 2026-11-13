# Desktop: members add their own connectors

> **Generally available:** `desktopPersonalConnectors` is retired; the enabled behavior is now standard. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

Feature key: `desktopPersonalConnectors` · Deployments: cloud and self-hosted · Default: off · Author: @benjaminshafii

## What changes

In the desktop app, **Library → Add to library → Connector → Add an MCP** is open to everyone,
but before this flag only owners and admins could finish it. A member's form sent only the server
address, so Den saved a Library item with no connector behind it. It showed **Set up**, had no
sign-in, and the agent could not use it.

With the flag on, a member's **Add an MCP** creates their own connector through
`POST /v1/mcp-connections`, the same request **My Library → Add another MCP** sends on the web:

- **Server signs in with OAuth:** each person signs in with their own account (`per_member`).
  After **Add and sign in**, the desktop opens the provider's sign-in page.
- **Server needs no sign-in:** added ready to use.
- **Server needs a key:** the member is told to ask an admin. Den refuses keys from members.

The connector is only for that member until they share it. Owners and admins keep their existing
desktop form (sign-in options, keys, shared accounts).

## Permissions

No new permission and no wider access. The desktop now uses the route Den already allows members
to use (`memberConnectionCreateDenial` in `ee/apps/den-api/src/routes/org/mcp-connections.ts`):
per-person OAuth or no sign-in, never a shared credential, key, header or OAuth app, never shared
with everyone. **Manage connections** is still required to configure a Library plugin's connector
inline (`plugin-system/store.ts`), and the admin desktop path is unchanged.

## Try it

1. Turn the flag on for an organization in `/admin`.
2. As a member in the desktop app: **Library → Add to library → Connector → Continue → Add an MCP**.
3. Enter a name and an OAuth MCP server URL, then **Add MCP**, **Continue** and **Add and sign in**.
4. Finish sign-in in the browser. The connector shows **Ready** in the Library with your account.

## Turning it off

Members see the old form again. Connectors already created stay: they are ordinary personal
connectors, also visible and removable in My Library on the web.

## What to watch

- `POST /v1/mcp-connections` 403s from members (a server type they cannot add).
- Feature usage: the desktop records a use when a member's connector is created.

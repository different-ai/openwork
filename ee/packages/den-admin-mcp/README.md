# den-admin-mcp

Read-only admin analytics MCP server for the OpenWork Den database. Ask OpenWork
things like "what's our weekly growth rate?", "show retention for the last 8
weeks", or "who at acme.test is active?" and the agent answers from real data.

> **Prefer the hosted endpoint.** den-api serves the same toolset over
> streamable HTTP at `/mcp/admin` (see `ee/apps/den-api/src/mcp/admin.ts`),
> authenticated with the desktop's first-party MCP token and gated by the
> platform-admin allowlist — no `DATABASE_URL` on client machines. In the app,
> connect "OpenWork Admin Analytics" from Settings -> Connections -> MCP
> (under Show hidden). This stdio package remains the break-glass/dev variant
> for when den-api itself is down. Keep tool payloads and
> `DEN_ADMIN_MCP_VERSION` in sync between the two; `den_admin_version` reports
> which build and transport you are talking to.

## Tools

| Tool | What it answers |
|---|---|
| `den_admin_version` | Toolset version + transport, to spot stale deploys |
| `den_overview` | Totals, new users 7d/30d, DAU/WAU/MAU, subscriptions |
| `den_growth` | Signup growth series (day/week/month) + growth rates |
| `den_retention` | Weekly signup cohorts x weeks-active retention matrix |
| `den_company_users` | Users related to a company (org match + email domain) |
| `den_users_search` | Find users by name/email, with orgs + last activity |
| `den_org_overview` | One org: members by role, invites, subscription, activity |
| `den_query` | Guarded read-only SQL escape hatch (SELECT-only, auto LIMIT) |

Activity definitions match den-api `/v1/admin/overview`: a user is active on a
day if they have a sign-in session day or a `session.active` telemetry event.

## Setup

Only `DATABASE_URL` is required. No den-api needs to run; no encryption key is
needed (analytics tables have no encrypted columns). For defense in depth,
create a read-only MySQL user:

```sql
CREATE USER 'den_readonly'@'%' IDENTIFIED BY '...';
GRANT SELECT ON openwork_den.* TO 'den_readonly'@'%';
```

## Register in OpenWork

Add to `opencode.json` (workspace) or `~/.config/opencode/opencode.jsonc`
(global), or via Settings -> Connections -> MCP in the app:

```jsonc
{
  "mcp": {
    "den-admin": {
      "type": "local",
      "command": ["node", "/path/to/ee/packages/den-admin-mcp/index.mjs"],
      "environment": { "DATABASE_URL": "mysql://den_readonly:...@host:3306/openwork_den" },
      "enabled": true
    }
  }
}
```

## Test

Boots the server over real stdio JSON-RPC and exercises every tool:

```sh
# defaults to the local dev database (docker compose mysql + seed:demo-org)
pnpm --filter @openwork-ee/den-admin-mcp test
```

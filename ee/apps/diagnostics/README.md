# OpenWork Diagnostics

OpenWork Diagnostics is a deliberately small, Vercel-native MCP compatibility
endpoint. An enterprise can allowlist one stable host, point a client at
`/mcp`, and use the authenticated dashboard to prove that requests arrived and
inspect the safely redacted request/response sequence.

It supports one active synthetic profile at a time (`generic`, `microsoft`, or
`servicenow`). Changing the profile is an environment/configuration deployment,
not an in-app multi-instance operation.

## Local development

```bash
pnpm --filter @openwork-ee/diagnostics dev
```

Open `http://localhost:3010` and use HTTP Basic authentication:

- username: `diagnostics-admin`
- password: `OpenWorkDiagnosticsLocal!`

The local MCP endpoint is `http://localhost:3010/mcp` with synthetic bearer
token `OpenWorkDiagnosticsToken!`. Local history is process-memory only.

## Vercel deployment

Create a Vercel project from this repository with **Root Directory** set to
`ee/apps/diagnostics`. Link an Upstash Redis database from the Vercel
Marketplace. Vercel injects the Redis REST URL/token; the app accepts either
the `UPSTASH_REDIS_REST_*` or `KV_REST_API_*` names.

Set these production environment variables:

| Variable | Purpose |
| --- | --- |
| `DIAGNOSTICS_ADMIN_USERNAME` | Dashboard Basic-auth username. |
| `DIAGNOSTICS_ADMIN_PASSWORD` | Dashboard password, at least 24 characters. |
| `DIAGNOSTICS_SIGNING_SECRET` | Signs stateless one-hour MCP session IDs, at least 32 characters. |
| `DIAGNOSTICS_MCP_BEARER_TOKEN` | Synthetic token customers configure in their test client, at least 24 characters. |
| `DIAGNOSTICS_PROFILE` | `generic`, `microsoft`, or `servicenow`. |
| `NEXT_PUBLIC_DIAGNOSTICS_ORIGIN` | `https://diagnostic.openwork.software`. |

Attach `diagnostic.openwork.software` in the project's Vercel **Domains**
settings, then create the CNAME value Vercel provides at the DNS provider. The
stable customer allowlist entry is the same host; the MCP URL is:

```text
https://diagnostic.openwork.software/mcp
```

Before enabling public DNS, add a Vercel Firewall rate-limit rule for `/mcp`
(for example, 120 requests per minute per source). This preserves enough room
for an MCP handshake and diagnostic calls while preventing a broken or hostile
client from continuously replacing the bounded evidence history.

The app fails closed in Vercel when a required credential or Redis setting is
missing. `/health` reports only missing variable names, never values.

## What is retained

At most 200 exchanges are retained for 24 hours. Each includes:

- receipt/completion time, duration, status, and diagnostic reference;
- method, path, query **names**, and a hash of the gateway-observed source;
- protocol-relevant header values;
- names of all other headers with their values withheld;
- structural JSON-RPC previews with credentials, codes, tokens, cookies,
  session IDs, unknown strings, and tool-argument values redacted.

Raw bodies are never stored. Redis contains only the already-redacted exchange.

## Scope boundary

This endpoint proves network allowlisting, direct synthetic Bearer
authentication, Streamable HTTP request shape, MCP initialization, protocol
headers, stateless session continuity, tool discovery, and a content-free
synthetic tool response. It does not emulate a complete Microsoft Entra or
ServiceNow OAuth authorization server and does not contact either provider.

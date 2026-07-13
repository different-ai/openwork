# OpenWork Diagnostics

OpenWork Diagnostics is a deliberately small, Vercel-native MCP compatibility
endpoint. An enterprise can allowlist one stable host, point a client at
`/mcp`, and use the authenticated dashboard to prove that requests arrived and
inspect the safely redacted request/response sequence.

It also supports a controlled Den egress diagnostic for private-cloud and
Kubernetes deployments. A workspace owner or admin starts the run in **Org
settings**. The requests originate in the Den process, so they exercise the
customer's real container DNS, proxy, TLS trust, firewall, service mesh, and
NetworkPolicy path. OpenWork support can filter the dashboard by the resulting
run ID and see the last request that reached the public service.

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

To expose the controlled run in a local Den, set:

```dotenv
DEN_DIAGNOSTICS_ORIGIN=http://localhost:3010
DEN_DIAGNOSTICS_BEARER_TOKEN=OpenWorkDiagnosticsToken!
```

The standard `pnpm dev:den` command supplies these local defaults. The browser
never submits the target or token; both are owned by the Den operator.

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
| `DIAGNOSTICS_SIGNING_SECRET` | Signs short-lived synthetic OAuth access tokens and stateless MCP session IDs, at least 32 characters. |
| `DIAGNOSTICS_MCP_BEARER_TOKEN` | Synthetic diagnostic token shared with the test Den or client, at least 24 characters. Never use a provider/customer credential. |
| `DIAGNOSTICS_PROFILE` | `generic`, `microsoft`, or `servicenow`. |
| `NEXT_PUBLIC_DIAGNOSTICS_ORIGIN` | `https://diagnostic.openwork.software`. |

Attach `diagnostic.openwork.software` in the project's Vercel **Domains**
settings, then create the CNAME value Vercel provides at the DNS provider. The
stable customer allowlist entry is the same host; the MCP URL is:

```text
https://diagnostic.openwork.software/mcp
```

Before enabling public DNS, add Vercel Firewall rate-limit rules for `/mcp`,
`/diagnostics/*`, `/oauth/token`, and `/.well-known/*` (for example, 120
requests per minute per source). This preserves enough room for a complete run
while preventing a broken or hostile client from continuously replacing the
bounded evidence history.

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

## Private-cloud diagnostic story

One run uses a UUID correlation header and stops at the first failed layer:

1. `GET /diagnostics/egress` proves public reachability.
2. `HEAD`, `OPTIONS`, and an authenticated JSON `POST` prove method and header handling.
3. A controlled `302` proves same-origin redirect handling.
4. OAuth protected-resource and authorization-server metadata prove discovery.
5. A client-secret Basic token `POST` returns a five-minute synthetic access token.
6. MCP initialize, initialized notification, tool discovery, and a content-free tool call prove protocol continuity.

Every reached endpoint returns a diagnostic reference and retains a redacted
exchange under the run ID. If Den reports DNS, TLS, connection, or timeout
failure and the public dashboard has no matching row, the request failed before
HTTP reached OpenWork. If a row exists, its response status and next missing
step narrow the issue to proxy authentication, header stripping, redirects,
OAuth, or MCP.

For a customer-hosted Den, the operator sets the same synthetic secret and the
stable public origin:

```dotenv
DEN_DIAGNOSTICS_ORIGIN=https://diagnostic.openwork.software
DEN_DIAGNOSTICS_BEARER_TOKEN=<same synthetic diagnostic token>
```

No organization ID, customer data, OAuth grant, Microsoft/ServiceNow secret,
or arbitrary destination is sent by this flow.

## Scope boundary

This endpoint proves network allowlisting, common HTTP methods, same-origin
redirects, OAuth-shaped discovery and client-secret token exchange, Streamable
HTTP request shape, MCP initialization, protocol headers, stateless session
continuity, tool discovery, and a content-free synthetic tool response. It does
not emulate a complete Microsoft Entra or ServiceNow authorization flow, does
not contact either provider, and is not a general-purpose URL scanner. The
single active profile is a diagnostic façade, not a provider clone.

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

Open `http://localhost:3010` and sign in with:

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
`ee/apps/diagnostics`. Keep **Include source files outside of the Root
Directory** enabled so Vercel can install the root pnpm workspace and the
shared `@openwork/types` package. Link an Upstash Redis database from the
Vercel Marketplace. Vercel injects the Redis REST URL/token; the app accepts
either a complete `UPSTASH_REDIS_REST_*` pair or a complete `KV_REST_API_*`
pair, but never mixes values between the two integrations.

Set these production environment variables:

| Variable | Purpose |
| --- | --- |
| `DIAGNOSTICS_ADMIN_USERNAME` | Dashboard sign-in username. |
| `DIAGNOSTICS_ADMIN_PASSWORD` | Dashboard sign-in password, at least 24 characters. |
| `DIAGNOSTICS_SIGNING_SECRET` | Signs the one-hour dashboard cookie, short-lived synthetic OAuth access tokens, and stateless MCP session IDs; at least 32 characters. |
| `DIAGNOSTICS_MCP_BEARER_TOKEN` | Synthetic diagnostic token shared with the test Den or client, at least 24 characters. Never use a provider/customer credential. |
| `DIAGNOSTICS_PROFILE` | `generic`, `microsoft`, or `servicenow`. |
| `NEXT_PUBLIC_DIAGNOSTICS_ORIGIN` | Fixed production origin, normally `https://diagnostic.openworklabs.com`. Preview deployments use Vercel's deployment-specific `VERCEL_URL` instead. |

Keep Vercel's **Automatically expose System Environment Variables** setting
enabled. Preview deployments derive their OAuth and MCP resource URLs from the
deployment-specific `VERCEL_URL`; production continues to require the fixed
`NEXT_PUBLIC_DIAGNOSTICS_ORIGIN` allowlist hostname.

Attach `diagnostic.openworklabs.com` in the project's Vercel **Domains**
settings, then create the CNAME value Vercel provides at the DNS provider. The
stable customer allowlist entry is the same host; the MCP URL is:

```text
https://diagnostic.openworklabs.com/mcp
```

Before enabling public DNS, add Vercel Firewall rate-limit rules for `/mcp`,
`/diagnostics/*`, `/oauth/token`, and `/.well-known/*` (for example, 120
requests per minute per source). Add a tighter rule for
`/api/dashboard-session` (for example, 10 attempts per minute per source) to
slow password guessing. This preserves enough room for a complete run while
preventing a broken or hostile client from continuously replacing the bounded
rolling history. Treat this as a production gate, not an optional follow-up:
publish the rules and verify an excess request receives HTTP 429 before
attaching the public hostname.

The app fails closed in Vercel when a required credential or Redis setting is
missing, the profile is invalid, Redis is not HTTPS, or application secrets are
reused. `/health` reports only configuration names, never values.

After the production deployment is promoted, verify all of the following
before sharing the allowlist hostname:

1. `GET https://diagnostic.openworklabs.com/health` returns HTTP 200 and
   `{"service":"openwork-diagnostics","status":"ok"}`.
2. The dashboard redirects to `/login` without a signed session, accepts the
   configured administrator credentials, and signs out by clearing the session.
3. The Firewall rule returns HTTP 429 when its threshold is exceeded.
4. A Den run completes all six steps, and its **Open support trace** link still
   shows 13 exchanges after unrelated requests reach the deployment.

## What is retained

The unfiltered dashboard retains the newest 200 exchanges for 24 hours. A
cryptographically authenticated Den run also gets an isolated 50-exchange
bucket for 24 hours, so unrelated public traffic cannot evict its support
trace. The run signature is verified before a request can enter that bucket;
the signature itself is never displayed. Each exchange includes:

- receipt/completion time, duration, status, and diagnostic reference;
- method, path, query **names**, and a keyed hash of the gateway-observed source;
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

For a customer-hosted Den, an organization admin enters the same synthetic
secret in **Org settings → Den egress diagnostic**. Den encrypts it and never
returns it to the browser. Den uses `https://diagnostic.openworklabs.com` by
default; set `DEN_DIAGNOSTICS_ORIGIN` only to override that fixed destination.
`DEN_DIAGNOSTICS_BEARER_TOKEN` remains an optional deployment bootstrap
fallback:

```dotenv
DEN_DIAGNOSTICS_ORIGIN=https://diagnostic.openworklabs.com
DEN_DIAGNOSTICS_BEARER_TOKEN=<same synthetic diagnostic token>
```

On Node.js 24.5 or newer, an installation that requires an outbound proxy must
also start Den with `NODE_USE_ENV_PROXY=1` and the appropriate `HTTPS_PROXY`
and `NO_PROXY` values. Use `NODE_EXTRA_CA_CERTS` (or the platform system CA
configuration) when TLS inspection requires a private trust root. These are
process-start settings, so configure them on the Den container rather than in
the browser. The diagnostic and enterprise MCP requests both use Den's native
fetch path and therefore share those process-level settings.

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

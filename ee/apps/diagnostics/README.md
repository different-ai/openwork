# OpenWork Diagnostics

OpenWork Diagnostics is a deliberately small, Vercel-native MCP compatibility
endpoint. An enterprise can allowlist one stable host, point a client at
`/mcp`, and use the authenticated dashboard to prove that requests arrived and
inspect the safely redacted request/response sequence.

For customer-facing setup and interpretation guidance, see the published
[Network diagnostics](../../../packages/docs/start-here/network-diagnostics.mdx)
page.

The authenticated **Connections** dashboard also keeps a seven-day rolling
record of metadata-only OpenWork Connect incidents. It correlates what a
desktop maintenance probe observed with the initialize, initialized, and
tools/list lifecycle requests that reached Den. Operators can filter by raw
organization ID or desktop client UUID; the portal hashes those lookup values
in memory and stores only keyed pseudonyms.

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

The Connect debug proxy is available at:

```text
http://localhost:3010/debug-proxy/local-connect-debug-proxy
```

The final path segment is the local-only access key. The control page generates
scenario URLs such as
`http://localhost:3010/via/auth-expired/local-connect-debug-proxy`. In the
desktop, enable **Settings → Advanced → Developer mode**, then paste a complete
generated URL into **Settings → Cloud → Account → Cloud control plane URL**.
The same editor is visible on the OpenWork Connect sign-in surface while signed
out. Run the standalone local MCP smoke journey with:

```bash
pnpm --filter @openwork-ee/diagnostics smoke:debug-proxy
```

The MCP catalog also contains two diagnostics-only authorization tools:

- `diagnostics_authorization_check` returns JSON-RPC `-32001` with a same-origin
  `data.connect_url` until the user opens that mock verification link. A
  successful verification lasts five minutes and survives MCP reconnects.
- `diagnostics_reset_authorization` immediately clears that state so the link
  flow can be repeated without waiting for its automatic expiry.

The state is keyed by a one-way identity derived from the already-valid
synthetic MCP bearer token. Hosted deployments keep only that derived identity
in Redis with a five-minute TTL; local development keeps it in process memory.
The mock verification page never asks for or stores provider credentials.

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
| `DIAGNOSTICS_MCP_BEARER_TOKEN` | Synthetic diagnostic and Connect-intake token shared with Den, at least 24 characters. It also keys organization/client pseudonyms; never use a provider/customer credential. |
| `DIAGNOSTICS_PROFILE` | `generic`, `microsoft`, or `servicenow`. |
| `NEXT_PUBLIC_DIAGNOSTICS_ORIGIN` | Fixed production origin, normally `https://diagnostic.openworklabs.com`. Preview deployments use Vercel's deployment-specific `VERCEL_URL` instead. |
| `DEBUG_PROXY_ACCESS_KEY` | URL-safe random value (16+ characters) required for the Connect debug proxy UI and traffic. It becomes a path segment in generated desktop-compatible URLs. |
| `DEBUG_PROXY_DEFAULT_UPSTREAM` | Default Den origin. Falls back to `https://app.openworklabs.com`; set it explicitly on the Vercel project. |
| `DEBUG_PROXY_ALLOWED_UPSTREAMS` | Comma-separated HTTPS hosts or origins that generated override links may target. The default upstream remains allowed independently. |
| `DEBUG_PROXY_SLOW_MS` | Optional Agent endpoint delay, clamped to 5,000–10,000 ms; default 7,000 ms. |
| `DEBUG_PROXY_FLAKY_WINDOW_MS` | Optional per-instance rolling window for `flaky-N`; default 60,000 ms. |

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
`/diagnostics/*`, `/api/connections/incidents`, `/oauth/token`, and `/.well-known/*` (for example, 120
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

### Connect debug proxy deployment and use

The proxy deploys with this existing diagnostics Vercel project; do not create
a second project or change the project root. After setting the variables above,
open:

```text
https://<deployment>/debug-proxy/<DEBUG_PROXY_ACCESS_KEY>
```

Choose an allowlisted upstream and copy a scenario's complete base URL. The
desktop-compatible path format is:

```text
https://<deployment>/via/<scenario>/<DEBUG_PROXY_ACCESS_KEY>[/~<encoded-upstream>]
```

This is a Den **control plane base URL**, not a manually configured MCP server
URL. Saving it signs the desktop out of the previous control plane. Sign in
again through the browser; the desktop will derive the `/api/den` API routes,
mint its short-lived MCP token, and manage the hidden `openwork-cloud` MCP
entry automatically.

Browser sign-in uses root-relative Den web assets and API calls. The first HTML
response therefore sets a ten-minute, HTTP-only routing cookie that sends those
browser requests back through the selected scenario. That cookie contains the
same access-key path already present in the generated URL, is removed before
forwarding to Den, and is cleared when the debug control page is opened. The
one-time `openwork://den-auth` handoff also has its encoded Den base URL
rewritten so the desktop exchanges the grant through the selected scenario
instead of switching back to the upstream origin.

There are two independent authorization layers:

1. `DEBUG_PROXY_ACCESS_KEY` authorizes use of this diagnostic proxy. The
   desktop-compatible URL carries it in the path; the proxy consumes it and
   never forwards it to Den.
2. Den authentication remains unchanged. Browser session cookies, the
   one-time desktop handoff grant, the Den session bearer, and the minted MCP
   bearer transit the proxy to the configured upstream. The proxy rewrites the
   minted `resource` URL to the scenario base, so the managed Agent MCP traffic
   remains proxied. Provider OAuth tokens stay encrypted in Den and are not
   copied into the desktop or engine.

Non-browser probes may omit the key path segment and instead send it in the
`x-connect-debug-proxy-key` header. The desktop cannot be assumed to add that
header, so use the generated path form for end-to-end testing.

The control page lists the expected Agent access phase, `firstFailure`, and
probe trace outcome for every scenario. The request log is a best-effort
100-entry in-memory ring per Vercel instance. It retains method, forwarded path,
scenario, applied fault, status, and header latency only. It never retains
Authorization, cookies, query values, request/response bodies, or upstream
error text. Vercel instance replacement clears the log and resets `flaky-N`
counters.

Real sign-in cookies and bearer tokens transit the proxy. Prefer a staging or
development Den in `DEBUG_PROXY_DEFAULT_UPSTREAM`; use production only for a
time-bounded investigation with an isolated access key. Treat the generated
URLs as secrets because they contain that key.

To recover the desktop after a fault scenario:

1. Change the Den base URL back to the real Den origin, or to the generated
   `default` scenario URL.
2. Apply the base URL.
3. Click **Repair and test** on the Agent access card.
4. Confirm the card reaches **Ready** and the Advanced probe trace shows a
   successful initialize and tools/list.

Before promoting a Vercel deployment, run the diagnostics test/build gate and
the standalone smoke:

```bash
pnpm --filter @openwork-ee/diagnostics test
pnpm --filter @openwork-ee/diagnostics build
pnpm --filter @openwork-ee/diagnostics smoke:debug-proxy
```

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

The Connections dashboard separately retains at most 10,000 incident
observations for seven days. Desktop reports contain only:

- timestamp, phase, outcome, browser online state, and stable random
  attempt/event identifiers;
- allowlisted DNS/TCP/TLS error class, HTTP status, retryability, duration, and
  consecutive-failure count;
- app, OpenWork server, engine, and platform versions;
- an optional server request identifier for correlation.

Den replaces the authenticated organization ID and the desktop's random
per-install client UUID with purpose-separated HMAC-SHA-256 pseudonyms before
forwarding. The central service never receives email, member identity, prompts,
messages, tokens, cookies, URLs, tool names, tool arguments, request bodies, or
response bodies. A desktop retains only undelivered metadata reports for 24
hours, capped at 500, and clears the queue and random client ID when **Share
desktop Connect diagnostics** is disabled in Settings → Preferences → Privacy.
When Agent access is degraded, Settings → Connect → Advanced diagnostics shows
that random client UUID so a support engineer can paste it into the portal;
the value is not a member identifier.

`POST /api/connections/incidents` is not dashboard-cookie authenticated because
it is a machine intake. It requires the Den-owned bearer, rejects unknown
fields and batches larger than 50, and is suitable for a separate firewall
rate limit. `GET /api/connections/incidents` and `/connections` remain protected
by the diagnostics administrator session.

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

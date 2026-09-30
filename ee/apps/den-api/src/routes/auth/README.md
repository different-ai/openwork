# Auth Routes

This folder owns authentication-related HTTP surfaces.

## Files

- `index.ts`: mounts Better Auth at `/api/auth/*` and registers auth-specific route groups
- `desktop-handoff.ts`: desktop sign-in handoff flow under `/v1/auth/desktop-handoff*`

## Current responsibilities

- forward Better Auth requests to `auth.handler(c.req.raw)`
- create short-lived desktop handoff grants
- exchange a valid handoff grant for a session token

## Expected dependencies

- Better Auth configuration from `src/auth.ts`
- shared auth/session middleware from `src/session.ts`
- request validation from `src/middleware/index.ts`

## Notes for future work

- Keep browser auth routes mounted through Better Auth unless there is a strong reason to wrap them
- Put new auth-adjacent custom endpoints in this folder, not in `me/` or `org/`

## Temporary SCIM Diagnostics

Set `SENTRY_DEBUG_ORG_IDS` to comma-separated **internal opaque organization IDs**
and `SENTRY_DEBUG_ORGS_EXPIRES_AT` to a future strict ISO 8601 timestamp, including
seconds and `Z` or a numeric timezone offset. Optional fractional seconds have
1-3 digits. Example placeholders: `org_REPLACE_ME` and
`2000-01-01T00:00:00Z` (deliberately expired; replace with a short incident window).
Do not put organization names, domains, or credentials in either setting.

Missing, malformed, empty, or expired configuration disables the feature without
failing API startup. The list is bounded to 100 IDs, each 1-128 ASCII letters,
digits, underscores, or hyphens, beginning with a letter or digit. Admission,
sampling, completion logging, and transaction export recheck configuration and
time; there is no cached allowlist or timer that can outlive the expiry.

One middleware wraps canonical `/api/auth/scim/v2/Users` and `/Groups` collection
and single-resource paths for GET, POST, PUT, PATCH, and DELETE. It looks up the
provider and verifies its stored hashed bearer token before using the stored org
ID. Invalid tokens and lookup failures fall through to the unchanged auth route.
The extra verification is not an auth gate and does not cache or replace the
handler's own verification. Account linking and SCIM response semantics are unchanged.

With the Sentry backend enabled, a verified targeted request starts a **separate
root trace**, even under an unsampled incoming parent. Its sampling rate is 1.
All other traces preserve the original `tracesSampleRate` sampling precedence:
an explicit `parentSampled` decision wins; only when it is absent do we use the
configured `SENTRY_TRACES_SAMPLE_RATE` (default 0.01). Do not substitute SDK
10.64's `inheritOrSampleWith`: it prioritizes the DSC parent sample rate and can
reverse the parent decision when upstream DSC/sample randomness is inconsistent.
This is SDK sampling, not a
guarantee against Sentry quota, ingestion, or retention limits.

The diagnostic root exports only its SDK IDs/timestamps, internal org ID, method,
resource operation, HTTP status, duration, safe outcome, and correlation fields.
`better_auth_ms` measures the Better Auth handler call for Users GET and ordinary
POST/PUT/PATCH mutations. `den_mirror_ms` measures the Den identity mirror calls
after successful mutations, including Den-owned PUT/PATCH deactivation (which
does not call Better Auth). These finite numeric fields accumulate per request
and appear in completion logs and root trace data. An unexecuted phase is absent,
not zero: rejected Better Auth requests have no mirror timing. Response parsing,
deactivation detection, and failure-record bookkeeping are not mirror timings;
they remain included in total `duration_ms`. Timing helpers pass straight through
outside an active diagnostic scope and preserve results and thrown errors.
The existing scrubber remains enabled, followed by a strict diagnostic allowlist.
Child spans (including SQL), request metadata, query/filter, bodies, users,
headers, breadcrumbs, errors, attachments, and inherited dynamic sampling baggage
are discarded. SDK 10.64 declares `traceLifecycle`'s default as `static`, and its
streaming predicate requires an explicit `stream` setting. No global lifecycle
override is set here, so existing export behavior is unchanged. This privacy
boundary sanitizes the complete transaction envelope; enabling span streaming
later requires an equivalent privacy boundary for that exporter.

Diagnostic request logs use the existing API logger at `warn`, independently of
trace sampling, respecting `SENTRY_LOG_LEVEL` (default `warn`; `error`/`off` still
suppress them). The verified opaque `organization.id` is included consistently in
private stdout/provider logs and root data for filtering. Use operator-controlled
private telemetry sinks. Other app logger calls within this opt-in scope retain
their levels (including info) but become safe activity messages with the same
safe fields/stage timings, never their raw fields/errors. The Sentry log hook drops logs if code adds scope attributes,
because SDK v10 merges those after the hook; safe stdout logs remain available.
No global info-level increase is needed.

`api_request_id` is the server-generated `req_...` ID, not an incoming header.
Cross-proxy correlation uses the **existing inbound `x-request-id`**, which Hono's
`requestId({ headerName: "" })` does not remove from `c.req.raw.headers`. Accepted
values contain 1-128 ASCII letters, digits, underscores, or hyphens. The SHA-256
of that header value is exported separately as `proxy_request_id` in the form
`sha256:<hex>`, matching den-web's hashed `request_id` value. The raw header is
never emitted and is never authentication evidence. No new header is introduced;
this implementation does not change den-web.

Responses are not cloned or consumed for diagnostics, so streaming behavior and
returned bytes are preserved. Lookup result counts and SCIM `scimType` are not
reported. Every returned 409 is only `conflict`, for Users and Groups alike.
Status alone cannot identify uniqueness failures, account-linking refusals, or
other conflict causes. The exact branch remains unobservable at this boundary;
neither the dependency nor its account-linking/security policy is modified.

### Proxy errors and incident workflow

The den-web SCIM proxy reports thrown fetch failures to Sentry as
`ScimProxyFetchFailure`, independently of trace sampling, when its Sentry backend
is enabled. This is route-scoped error reporting, not org-scoped tracing: a fetch
can fail before the API validates the connector. The event and stdout diagnostic
include a templated path, method, body size, elapsed time, hashed request ID,
allowlisted error name/cause code/failure class, and `has_expect` /
`expect_100_continue` booleans. No raw exception, headers, payload, or query is
captured. These booleans describe the forwarded headers, not the incoming request.
The proxy strips `Expect` after reading the incoming body, because Node/undici
fetch rejects the client's `100-continue` handshake header. Body bytes and
upstream responses (including 409 conflicts) are preserved.

Sentry error reports are capped at five per minute per runtime; safe stdout
diagnostics are not capped. Deployment quotas and delivery failures can also
limit Sentry visibility. Regular upstream HTTP responses, including 409, keep
their existing pass-through behavior and are not reported as fetch exceptions.

1. Deploy the API and web changes through the normal deployment process. Ensure
   each service uses `DEN_OBSERVABILITY_BACKEND=sentry` and its existing
   `SENTRY_DSN`; do not change the global trace rate for this investigation.
2. Set the allowlist and a short expiry on **den-api**, not browser/public env.
   Retain `SENTRY_LOG_LEVEL=warn` (or a more verbose existing level) to receive
   diagnostic completion logs. Remove the settings to disable early.
3. Check whether the test identity already exists before asking for one
   controlled on-demand provisioning attempt. Never blindly replay a POST after
   an ambiguous 502; it may already have committed upstream.
4. In API Sentry traces, find `SCIM diagnostic` and inspect `organization.id`,
   `scim_operation`, `http_status_code`, `better_auth_ms`, and `den_mirror_ms`.
   In logs, find `SCIM diagnostic request completed` with the same org ID.
5. For web fetch failures, find `ScimProxyFetchFailure` in Sentry or
   `den-web SCIM upstream fetch failed` in Vercel stdout. Correlate web
   `request_id` with API `proxy_request_id`: both use `sha256:<hex>`. A response's
   raw reference ID must be SHA-256 hashed locally before this search. API
   `api_request_id` is a separate server-generated identifier.
6. Verify the expiry has elapsed or remove the allowlist when done. Do not
   retain raw identity-provider payloads as incident fixtures or in this repo.

Focused checks (run serially from the workspace root):

```sh
pnpm --filter @openwork-ee/den-api test:scim-diagnostics
pnpm --filter @openwork-ee/den-web test:observability
pnpm --filter @openwork-ee/den-api exec bun test --conditions development test/observability.test.ts test/scim-token-storage.test.ts test/scim-auth-sync.test.ts
```

The diagnostic tests exercise the installed Sentry SDK with an in-memory
transport and synthetic Hono handlers; proxy tests exercise the proxy function
and sanitized Sentry event pipeline. They are not a production Entra, Vercel,
Cloudflare, or database-backed lifecycle test.

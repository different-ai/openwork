# OpenWork Cloud App (`ee/apps/den-web`)

Frontend for `app.openworklabs.com`.

## What it does

- Signs up / signs in users against Den service auth.
- Handles invited-org signup flows where the invited email stays locked and the user verifies access before joining.
- Lists and connects existing cloud workers.
- Sends users to the organization billing page for subscription management.
- Offers desktop handoff actions so users can open the generated worker directly in OpenWork or copy the connect credentials manually.
- Uses a Next.js proxy route (`/api/den/*`) to reach `api.openworklabs.com` without browser CORS issues.
- Uses a same-origin auth proxy (`/api/auth/*`) so GitHub OAuth callbacks can land on `app.openworklabs.com`.

## Current hosted user flow

1. Sign in with a standard provider or accept an org invite.
2. Create or select an organization without a billing gate.
3. Manage billing from the organization billing page.
4. Open existing workers in the desktop app with the provided deep link, or copy the URL/token into `Connect remote` manually.

## Local development

1. Install workspace deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @openwork-ee/den-web dev`
3. Open:
   `http://localhost:3005`

### Optional env vars

- `DEN_API_BASE` (server-only): upstream API base used by proxy routes. Required outside local dev wrappers.
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints when the browser request does not include one. Required outside local dev wrappers.
- `DEN_AUTH_FALLBACK_BASE` (server-only): fallback Den origin used if `DEN_API_BASE` serves an HTML/5xx error.
- `DEN_WEB_PUBLIC_ORIGIN` (server/runtime): public origin used for metadata.
- `DEN_WEB_OPENWORK_APP_CONNECT_URL` (runtime): Base URL for "Open in App" links.
  - Example: `https://openworklabs.com/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `DEN_WEB_OPENWORK_AUTH_CALLBACK_URL` (runtime): Canonical URL used for GitHub auth callback redirects.
  - this host must serve `/api/auth/*`; the included proxy route does that
- `DEN_WEB_POSTHOG_KEY` (server/runtime): PostHog project key used for Den analytics.
- `DEN_WEB_POSTHOG_HOST` (server/runtime): PostHog ingest host or same-origin proxy path.
  - default: `/ow`
  - set it to `https://us.i.posthog.com` to bypass the local proxy
- `GET /api/health` returns a shallow app health payload for container probes.

### Observability

`DEN_OBSERVABILITY_BACKEND` selects one backend at startup: `none` (default), `otel`, or `sentry`.

- `none`: no SDK initializes; den-web runtime logs are structured JSON on stdout.
- `otel`: server-only OpenTelemetry. The Next instrumentation starts the NodeSDK only when `NEXT_RUNTIME=nodejs` and exports traces, metrics, and logs over OTLP HTTP/protobuf (`*-otlp-proto` exporters). Configure with standard `OTEL_EXPORTER_OTLP_ENDPOINT`, per-signal endpoint/protocol/exporter vars, `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`, and optional `OTEL_SERVICE_NAME` (defaults to `den-web`).
- `sentry`: intended Vercel backend. Set server `SENTRY_DSN`; optional `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, and `SENTRY_DIST` tune runtime events. Browser Sentry is explicit at build time with `NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=sentry` and `NEXT_PUBLIC_SENTRY_DSN`; `NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=otel` disables browser collection because OTEL is server-only.

Direct OTLP shutdown/flush for stock `next start` and Vercel deployments is operational best-effort because the platform owns process shutdown timing. Sentry remains the recommended backend for Vercel-hosted Den Web.

Sentry wraps the Next config for browser Sentry builds (`NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=sentry`) and for explicit source-map upload builds. Source-map uploads are disabled by default; enable them with the build-only `DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS=true` flag and provide `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` as build credentials. Normal Docker/image builds do not need runtime `DEN_OBSERVABILITY_BACKEND` or `SENTRY_DSN` values. Never expose `SENTRY_AUTH_TOKEN` to the browser.

Runtime logs and telemetry scrubbing avoid request bodies, cookies, authorization headers, credentials, and target query strings. The `/api/den/*` and `/api/auth/*` upstream proxy emits one structured completion/error log per request and forwards W3C trace context so web-to-api traffic can be correlated with Next traces.

### Related Den API env vars

- `DEN_ORG_MODE`: `single_org` or `multi_org`. Blank/unset resolves to `single_org` in the implemented target state; hosted/cloud deployments should set `multi_org` explicitly.
- `DEN_SINGLE_ORG_NAME` / `DEN_SINGLE_ORG_SLUG`: singleton organization display name and stable slug for private single-org deployments.
- `DEN_SINGLE_ORG_OWNER_EMAILS`: comma-separated emails allowed to claim singleton organization ownership.
- `DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP`: whether unauthenticated users can self-serve signup into the singleton organization.
- When SSO is configured on the singleton organization, auth becomes SSO-only.
- `DEN_REQUIRE_EMAIL_VERIFICATION`: set `false` for the single-org default to avoid signup verification-code flows; hosted multi-org should set `true`.
- `DEN_MCP_CLAIM_NAMESPACE`: namespace used for MCP token claim URIs. Leave blank to use `BETTER_AUTH_URL`; set a stable value before issuing tokens if hosts may change. Use `https://openworklabs.com` to preserve the original hosted MCP claim names.
- `DEN_BOOTSTRAP_ADMIN_EMAILS`: comma-separated platform admin emails seeded by `den-api` on startup. Blank disables bootstrap admin seeding.

## Deploy on Vercel

Recommended project settings:

- Root directory: `ee/apps/den-web`
- Framework preset: Next.js
- Build command: `cd ../../.. && pnpm --filter @openwork-ee/den-web build`
- Output directory: `.next`
- Install command: `cd ../../.. && pnpm install --frozen-lockfile`

These commands should be configured in the Vercel dashboard rather than committed in `vercel.json`, so the app still builds from the monorepo root and can resolve shared workspace packages like `@openwork-ee/utils`.

Then assign custom domain:

- `app.openworklabs.com`

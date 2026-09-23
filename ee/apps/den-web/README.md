# OpenWork Cloud App (`ee/apps/den-web`)

Frontend for `app.openworklabs.com`.

## What it does

- Signs up / signs in users against Den service auth.
- Handles invited-org signup flows where the invited email stays locked and the user verifies access before joining.
- Lists and connects existing cloud workers.
- Sends users to the organization billing page for subscription management.
- Offers desktop handoff actions so users can open the generated worker directly in OpenWork or copy the connect credentials manually.
- Calls the Den API directly at the matching `api.*` origin (for example, `app.openworklabs.com` -> `api.app.openworklabs.com`), including Better Auth traffic.
- Keeps a same-origin auth proxy (`/api/auth/*`) only for compatibility with already-registered auth callbacks that still land on the web host.

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

### Styling

Den and desktop use Tailwind 4.3.3. Den uses `@tailwindcss/postcss` with Next.js;
desktop uses `@tailwindcss/vite`. Do not add the old Tailwind PostCSS plugin or
autoprefixer alongside it.

`app/globals.css` explicitly scans Den's app/components and `packages/ui/src`,
independent of the build's working directory. Add an `@source` entry when Den
starts consuming another package that contains utility classes. Theme tokens
live in `app/tailwind-theme.css`: the existing sRGB palette is retained to avoid
a visual redesign. The unlayered Den CSS and light-only color scheme are
intentional. Base overrides retain the previous border, placeholder and cursor
defaults; gradients use `/srgb` to preserve interpolation.

When bringing older UI work onto this branch, use `shadow-xs` for the old
`shadow-sm`, `rounded-sm` for the old bare `rounded`, and `outline-hidden` for
the old `outline-none` (including focus variants). Review `space-*` and `divide-*`
on lists: Tailwind 4 applies spacing/borders to preceding children instead of
following siblings. Native v4 utilities in shared packages are scanned too;
sharing theme semantics with desktop is a separate change.

Tailwind 4 requires Safari 16.4+, Chrome 111+, or Firefox 128+; see the
[Tailwind upgrade guide](https://tailwindcss.com/docs/upgrade-guide).

### Optional env vars

- `DEN_API_BASE` (server-only): upstream API base used by server-side health/readiness and compatibility auth proxy routes. Required outside local dev wrappers.
- `DEN_API_PUBLIC_URL` (server/runtime): browser-reachable Den API origin handed to clients by `/api/runtime-config` and used as the `Location` of the legacy `/api/den/*` 307 redirect. Set it whenever `DEN_API_BASE` is a container-internal URL; when unset, the redirect falls back to `DEN_API_BASE`, then `api.<web host>`.
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints when the browser request does not include one. Required outside local dev wrappers.
- `DEN_WEB_PUBLIC_ORIGIN` (server/runtime): public origin used for metadata.
- `DEN_WEB_OPENWORK_APP_CONNECT_URL` (runtime): Base URL for "Open in App" links.
  - Example: `https://openworklabs.com/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `DEN_WEB_OPENWORK_WEB_URL` (runtime): URL opened by the dashboard Web tab.
  - default: `https://web.openworklabs.com`
- `DEN_WEB_OPENWORK_AUTH_CALLBACK_URL` (runtime): Canonical URL where the app returns after auth completes.
- `NEXT_PUBLIC_POSTHOG_KEY` (public, build-time): the existing PostHog project key and primary setting. No new variable name is required. For rollout compatibility only, an unset key falls back to `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, then `DEN_WEB_POSTHOG_KEY`. An explicitly blank key disables analytics rather than falling back. There is no hardcoded key. Supply it before `next build`; runtime-only changes require a rebuild.
- Vercel variable scopes matter: Preview/Development values are not available to Production builds. Enable the existing `NEXT_PUBLIC_POSTHOG_KEY` for Production before removing the transitional `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` entry, then rebuild. No hosting settings are changed by this code.
- `NEXT_PUBLIC_POSTHOG_HOST` (public, build-time): the existing upstream setting. US/EU Cloud ingestion origins are supported; `app.posthog.com` and the US/EU UI origins are normalized to their region. Missing/blank values or `/ow` retain the US default. This controls server rewrite destinations and the SDK's UI links, never direct browser ingestion. Unsupported hosts fail enabled production builds with a value-free error; unused invalid values cannot prevent disabled preview/dev builds from starting.
- The public key is emitted only when `NODE_ENV=production`, `VERCEL_ENV=production`, and no `OPENWORK_DEV_MODE` override is active. Client initialization also requires the exact origin `https://app.openworklabs.com`. Previews, local builds and self-hosted deployments remain disabled. Auth/API URL settings do not control analytics.
- `instrumentation-client.ts` follows the [official Next.js SDK setup](https://posthog.com/docs/libraries/next-js): import the pinned `posthog-js` package and call `posthog.init` before hydration. The existing `window.posthog` analytics calls receive that same singleton. There is no inline CDN bootstrap, custom SDK queue, method replacement, or change to authentication helpers.
- The SDK core is bundled with the app. Browser analytics requests always use `/ow`; ordered Next.js rewrites forward to the region selected by `NEXT_PUBLIC_POSTHOG_HOST`. Arbitrary upstream hosts and browser-side proxy bypass are unsupported. The `/ow` sanitizer strips outgoing Cookie, Authorization, and Referer headers and does not intercept auth routes or modify browser cookies.
- SDK settings use localStorage persistence and route pageviews plus existing explicit events; autocapture, replay, surveys and automatic flags are disabled. The documented `before_send` hook removes query/fragment/userinfo from SDK URL properties and email/name from outbound event/person properties while preserving the public ingestion token. This is outbound filtering, not a guarantee that person properties never enter SDK memory or localStorage. Existing consent remains managed by the SDK; no forced opt-in or legacy-cookie cleanup is added.
- Run `pnpm run test:posthog` for client/config tests, a real SDK smoke test with all transports blocked, and the real Next.js routing fixture with loopback-only upstreams. No test sends events to PostHog.
- `GET /api/health` returns a shallow app health payload for container probes.

### Observability

`DEN_OBSERVABILITY_BACKEND` selects one backend at startup: `none` (default), `otel`, or `sentry`.

- `none`: no SDK initializes; den-web runtime logs are structured JSON on stdout.
- `otel`: server-only OpenTelemetry. The Next instrumentation starts the NodeSDK only when `NEXT_RUNTIME=nodejs` and exports traces, metrics, and logs over OTLP HTTP/protobuf (`*-otlp-proto` exporters). Configure with standard `OTEL_EXPORTER_OTLP_ENDPOINT`, per-signal endpoint/protocol/exporter vars, `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`, and optional `OTEL_SERVICE_NAME` (defaults to `den-web`).
- `sentry`: intended Vercel backend. Set server `SENTRY_DSN`; optional `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, and `SENTRY_DIST` tune runtime events. Browser Sentry is explicit at build time with `NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=sentry` and `NEXT_PUBLIC_SENTRY_DSN`; `NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=otel` disables browser collection because OTEL is server-only.

Direct OTLP shutdown/flush for stock `next start` and Vercel deployments is operational best-effort because the platform owns process shutdown timing. Sentry remains the recommended backend for Vercel-hosted Den Web.

Sentry wraps the Next config for browser Sentry builds (`NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND=sentry`) and for explicit source-map upload builds. Source-map uploads are disabled by default; enable them with the build-only `DEN_WEB_UPLOAD_SENTRY_SOURCEMAPS=true` flag and provide `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` as build credentials. Normal Docker/image builds do not need runtime `DEN_OBSERVABILITY_BACKEND` or `SENTRY_DSN` values. Never expose `SENTRY_AUTH_TOKEN` to the browser.

Runtime logs and telemetry scrubbing avoid request bodies, cookies, authorization headers, credentials, and target query strings. The compatibility `/api/den/*` route redirects legacy callers to the direct `api.*` origin; `/api/auth/*` remains an upstream proxy only for legacy auth callback compatibility and emits one structured completion/error log per request while forwarding W3C trace context.

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
- Install command: use the command committed in `vercel.json`

The filtered install includes Den Web's workspace dependency closure, so shared packages like `@openwork-ee/utils` remain available without installing unrelated native desktop and server dependencies.

Then assign custom domain:

- `app.openworklabs.com`

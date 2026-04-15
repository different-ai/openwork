# OpenWork Cloud App (`ee/apps/den-web`)

Frontend for `app.openworklabs.com`.

## What it does

- Signs up / signs in users against Den service auth.
- Handles invited-org signup flows where the invited email stays locked and the user verifies access before joining.
- Launches cloud workers via `POST /v1/workers`.
- Handles paywall responses (`402 payment_required`), routes users through Polar checkout, and only enables worker launch after purchase.
- Offers desktop handoff actions so users can open the generated worker directly in OpenWork or copy the connect credentials manually.
- Uses a Next.js proxy route (`/api/den/*`) to reach `api.openworklabs.com` without browser CORS issues.
- Uses a same-origin auth proxy (`/api/auth/*`) so GitHub OAuth callbacks can land on `app.openworklabs.com`.

## Current hosted user flow

1. Sign in with a standard provider or accept an org invite.
2. If the org requires billing, complete checkout before launching a worker.
3. Launch the worker from the cloud dashboard.
4. Open the worker in the desktop app with the provided deep link, or copy the URL/token into `Connect remote` manually.

## Local development

1. Install workspace deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @openwork-ee/den-web dev`
3. Open:
   `http://localhost:3005`

### Optional env vars

- `DEN_API_BASE` (server-only): upstream API base used by proxy route.
  - default: `https://api.openworklabs.com`
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints when the browser request does not include one.
  - default: `https://app.openworklabs.com`
- `DEN_AUTH_FALLBACK_BASE` (server-only): fallback Den origin used if `DEN_API_BASE` serves an HTML/5xx error.
  - default: `https://den-control-plane-openwork.onrender.com`
- `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL` (client): Base URL for "Open in App" links.
  - Example: `https://openworklabs.com/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL` (client): Canonical URL used for GitHub auth callback redirects.
  - default: `https://app.openworklabs.com`
  - this host must serve `/api/auth/*`; the included proxy route does that
- `NEXT_PUBLIC_POSTHOG_KEY` (client): PostHog project key used for Den analytics.
  - optional override; defaults to the same project key used by `ee/apps/landing`
- `NEXT_PUBLIC_POSTHOG_HOST` (client): PostHog ingest host or same-origin proxy path.
  - default: `/ow`
  - set it to `https://us.i.posthog.com` to bypass the local proxy

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

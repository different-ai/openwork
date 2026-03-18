# OpenWork Cloud App (`packages/web`)

Frontend for `app.openwork.software`.

## What it does

- Signs up / signs in users against Den service auth.
- Launches cloud workers via `POST /v1/workers`.
- Handles paywall responses (`402 payment_required`) and shows Polar checkout links.
- Uses a Next.js proxy route (`/api/den/*`) to reach `api.openwork.software` without browser CORS issues.
- Uses a same-origin auth proxy (`/api/auth/*`) so GitHub OAuth callbacks can land on `app.openwork.software`.

## Local development

1. Install workspace deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @different-ai/openwork-web dev`
3. Open:
   `http://localhost:3005`

### Optional env vars

- `DEN_API_BASE` (server-only): upstream API base used by proxy route.
  - default: `https://api.openwork.software`
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints when the browser request does not include one.
  - default: `https://app.openwork.software`
- `DEN_AUTH_FALLBACK_BASE` (server-only): fallback Den origin used if `DEN_API_BASE` serves an HTML/5xx error.
  - default: `https://den-control-plane-openwork.onrender.com`
- `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL` (client): Base URL for "Open in App" links.
  - Example: `https://openwork.software/app`
  - The web panel appends `/connect-remote` and injects worker URL/token params automatically.
- `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL` (client): Canonical URL used for GitHub auth callback redirects.
  - default: `https://app.openwork.software`
  - this host must serve `/api/auth/*`; the included proxy route does that
- `NEXT_PUBLIC_POSTHOG_KEY` (client): PostHog project key used for Den analytics.
  - optional override; defaults to the same project key used by `packages/landing`
- `NEXT_PUBLIC_POSTHOG_HOST` (client): PostHog ingest host or same-origin proxy path.
  - default: `/ow`
  - set it to `https://us.i.posthog.com` to bypass the local proxy
- `LOOPS_API_KEY` (server-only): Loops API key for signup contact capture.

## Deploy on Vercel

Recommended project settings:

- Root directory: `packages/web`
- Framework preset: Next.js
- Build command: `next build`
- Output directory: `.next`
- Install command: `npm install` (or `pnpm install`)

Then assign custom domain:

- `app.openwork.software`

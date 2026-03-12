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

## Local app + Den mode

To run the local `app.openwork.software` flow against a local Den service and MySQL:

1. Create a repo-root `.env.local` from the example and set a local auth secret:
   `cp .env.local.example .env.local`
2. Validate the launcher script:
   `bash -n scripts/dev-web-local.sh`
3. Validate the local MySQL compose file:
   `docker compose -f packaging/docker/docker-compose.web-local.yml config`
4. Start the local stack from the repo root:
   `pnpm dev:web-local`
5. Verify Den is healthy:
   `curl http://127.0.0.1:8788/health`
6. Verify the web app is serving:
   `curl -I http://127.0.0.1:3005`

What `pnpm dev:web-local` wires automatically:

- MySQL on `127.0.0.1:3306`
- Den on `127.0.0.1:8788`
- Web on `127.0.0.1:3005`
- `DEN_API_BASE`, `DEN_AUTH_ORIGIN`, and `DEN_AUTH_FALLBACK_BASE` pointed at the local Den service
- Den stub provisioner enabled with the secret and database URL from repo-root `.env.local`

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
- `NEXT_PUBLIC_POSTHOG_HOST` (client): PostHog host URL.
  - default: `https://us.i.posthog.com`
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

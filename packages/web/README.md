# OpenWork Cloud App (`packages/web`)

Frontend for `app.openwork.software`.

## What it does

- Signs up / signs in users against Den service auth.
- Launches cloud workers via `POST /v1/workers`.
- Handles paywall responses (`402 payment_required`) and shows Polar checkout links.
- Uses a Next.js proxy route (`/api/den/*`) to reach `api.openwork.software` without browser CORS issues.

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
- `DEN_AUTH_ORIGIN` (server-only): Origin header sent to Better Auth endpoints.
  - default: `https://den-control-plane-openwork.onrender.com`

## Deploy on Vercel

Recommended project settings:

- Root directory: `packages/web`
- Framework preset: Next.js
- Build command: `next build`
- Output directory: `.next`
- Install command: `npm install` (or `pnpm install`)

Then assign custom domain:

- `app.openwork.software`

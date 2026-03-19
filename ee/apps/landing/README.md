# OpenWork Landing (Next.js)

## Local dev

1. Install deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @openwork-ee/landing dev`

### Optional env vars

- `NEXT_PUBLIC_CAL_URL` - enterprise booking link
- `NEXT_PUBLIC_DEN_CHECKOUT_URL` - Polar checkout URL for the Den preorder CTA

## Deploy (recommended)

This app is ready for Vercel or any Node-compatible Next.js host.

### Vercel

1. Create a new Vercel project rooted at `ee/apps/landing`.
2. Build command: `pnpm --filter @openwork-ee/landing build`
3. Output: `.next`
4. Start command: `pnpm --filter @openwork-ee/landing start`

### Self-hosted

1. Build: `pnpm --filter @openwork-ee/landing build`
2. Start: `pnpm --filter @openwork-ee/landing start`

# Open In App Connect Flow

This change adds an **Open in App** connect path in the cloud web panel and makes the OpenWork app web runtime accept `http(s)://.../connect-remote` URLs with worker credentials.

## Evidence

- Remote connect URL auto-loaded into the app workspace:
  - `pr/web-open-in-app/remote-connect-autoload.png`
- Vercel-hosted OpenWork UI accepts `/connect-remote` and pre-fills worker fields:
  - `pr/web-open-in-app/vercel-openwork-ui-connect-remote.png`

## Vercel Deployments

- OpenWork UI app (Vite, `packages/app`): `https://openwork-ui-ten.vercel.app`
- OpenWork cloud panel preview (Next.js, `packages/web`): `https://openwork-o08livyb6-prologe.vercel.app`

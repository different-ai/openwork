# OpenWork Landing (Next.js)

## Local dev

1. Install deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @openwork-ee/landing dev`

### Optional env vars

- `NEXT_PUBLIC_CAL_URL` - enterprise booking link
- `EMAIL_FROM` - sender for feedback emails (for example `OpenWork <team@openworklabs.com>`)
- `RESEND_API_KEY` - Resend API key for feedback emails
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` - SMTP fallback for feedback emails when Resend is not configured
- `OPENWORK_FEEDBACK_EMAIL` - optional override for the internal feedback recipient (defaults to `team@openworklabs.com`)
- `LOOPS_API_KEY` - Loops API key for enterprise contact submissions
- `LOOPS_INTERNAL_FEEDBACK_EMAIL` - legacy feedback recipient override, used only when `OPENWORK_FEEDBACK_EMAIL` is not set
- `LANDING_FORM_ALLOWED_ORIGINS` - optional comma-separated origin allowlist for feedback/contact form posts

## Deploy (recommended)

This app is ready for Vercel or any Node-compatible Next.js host.

### Vercel

1. Create a new Vercel project rooted at `ee/apps/landing`.
2. Build command: `pnpm --filter @openwork-ee/landing build`
3. Output: `.next`
4. Start command: `pnpm --filter @openwork-ee/landing start`
5. Enable Vercel BotID for the project so protected form routes can reject automated submissions.

### Self-hosted

1. Build: `pnpm --filter @openwork-ee/landing build`
2. Start: `pnpm --filter @openwork-ee/landing start`

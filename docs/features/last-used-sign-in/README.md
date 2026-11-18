# Remember last sign-in method

Status: generally available · Deployments: cloud and self-hosted · Author: @benjaminshafii

The `lastUsedSignIn` rollout flag is retired. Remembering the last sign-in method
is always enabled; no feature lookup or operator setting is required.

## What people get

Den web's sign-in normally starts with an email step, then shows the one method
that email uses (SSO, Google, GitHub, password, or a new account).

Someone who last signed in on this browser with a
**password, Google or GitHub** skips the email step. They see every method at
once, with a **Last used** badge on the one they used:

- Continue with Google
- Continue with GitHub
- Continue with email (opens email and password in place; open by default when
  password was last used)
- **Single sign-on**, the last option, which goes back to the email step so the
  organization's SSO can be found from the email address

![Remembered sign-in, Google last used](./remembered-google.png)

![Remembered sign-in, password last used](./remembered-password.png)

People who have never signed in on the browser, or whose last sign-in was SSO,
see the email step as before.

## How it works

- After a sign-in that creates a session, Den API's Better Auth after-hook
  (`ee/apps/den-api/src/auth.ts`, `updateLastSignInCookie`) writes the
  `openwork-last-sign-in` cookie with `password`, `google` or `github`. It
  lasts 400 days (the browser maximum), is `SameSite=Lax`, `Secure` on HTTPS,
  and on the shared cookie domain when one is configured.
  - Password: `/sign-in/email`, `/sign-up/email`
  - Social: `/callback/:id` (only after the enterprise SSO check passed) and
    `/sign-in/social` with an ID token
- A real SSO sign-in (`/sso/callback/:providerId`,
  `/sso/saml2/sp/acs/:providerId`) **clears** the cookie. Admin SSO connection
  tests do not touch it.
- The cookie only names a method: no email, no token. It is not HttpOnly so
  the browser can read it; it never authorizes anything.
- Den web (`auth-panel.tsx`) reads the cookie after hydration and skips the
  email step when it contains a supported method, without requesting feature
  state. Invitations, prefilled or locked emails and single-org SSO deployments
  keep their own flow.
- Choosing a method still goes through the normal checks: a password sign-in
  for an SSO-managed email is redirected to SSO, and so is a Google or GitHub
  sign-in.

Logic and tests: `ee/apps/den-api/src/last-sign-in-method.ts`
(`test/last-sign-in-method.test.ts`) and
`ee/apps/den-web/app/(den)/_lib/last-sign-in.ts` (`last-sign-in.test.ts`).

## Availability and recovery

This behavior is built into sign-in on every deployment and no longer appears
in `/admin` › Features. Old rollout overrides and operator locks have no effect.
If the cookie is absent, invalid, cleared by SSO or expired, Den web uses the
email-first flow. People can also choose **Single sign-on** to return to that
flow without changing their remembered cookie.

Feature-service failures no longer affect cookie writes or the returning
sign-in panel. Changing this behavior requires a code change, not a rollout
switch.

## What to watch

- Password, Google and GitHub sign-ins should set the long-lived cookie only
  after a session is created. Real SSO sign-ins should expire it in both scopes;
  admin SSO connection tests must leave it alone.
- PostHog `den_auth_submitted` by `method`: returning people should reach a
  method without a `/v1/auth/login-options` or `/v1/features` lookup.

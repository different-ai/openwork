# Workbot: phone app

- Feature: `workbotMobile`
- Deployments: cloud and self-hosted; default **off**
- Owner: `reachjalil`

Members of an organization with Workbot can sign in to the OpenWork app on
iPhone and chat with Workbot there. The app lives in
[`ee/apps/mobile-ios`](../../../ee/apps/mobile-ios/README.md) and talks
only to Workbot's `/v1/workbot/...` API. Its first release is a plain text
chat: no attachments, notifications or background task controls.

## Who gets it

- Members of organizations that have both Workbot and `workbotMobile` on.
  The browser Workbot is unchanged either way.
- The app signs existing accounts in. Its sign-in page asks for an email
  first and offers no way to create an account; people still create
  accounts on the web.
- Signing in goes through Workbot and Den: the app opens `/auth/app/login`
  with its own PKCE challenge, Den returns the code to Workbot, and Workbot
  hands it to the app's verified HTTPS return address
  (`/auth/app/callback`). The app trades it at `POST /auth/app/token` for a
  sealed Workbot session it sends as a bearer token; it never holds Den
  tokens. Details: [Workbot's README](../../../ee/apps/workbot/README.md#the-phone-app).
- iOS only hands the return address to the app once Workbot serves the
  app's identity: set `WORKBOT_IOS_TEAM_ID`. Unset, the iPhone app can't
  finish signing in. `WORKBOT_ANDROID_CERT_SHA256` does the same for an
  Android app, which does not exist yet.

## How to try it

Phone sign-in needs an HTTPS Workbot deployment with `WORKBOT_IOS_TEAM_ID`
set, and a build of the app signed by that team. Turn `workbotMobile` on for
the organization in `/admin` › Features, then follow the
[app's README](../../../ee/apps/mobile-ios/README.md).

## Turning it off

Nothing is deleted. While it is off, signing in from the phone is refused
(`POST /auth/app/token` answers `403 workbot_mobile_not_enabled`), and the app
says an admin can turn it on. A phone already signed in gets the same refusal
on its next `/v1/workbot` request, while `/v1/workbot/me` still answers so the
app can say why. Browser sessions are not affected.

## What to watch

`workbot_mobile_not_enabled` answers, sign-in failures from
`POST /auth/app/token` (`sign_in_failed`, `den_unavailable`) and refreshes at
`POST /auth/app/refresh`. Rules: `ee/apps/workbot/scripts/app-auth.test.ts`.

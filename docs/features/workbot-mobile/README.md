# Workbot: phone app

- Feature: `workbotMobile`
- Deployments: cloud and self-hosted
- Default: off
- Owner: `reachjalil`

Members of an organization with Workbot can sign in to the Workbot app on
iPhone and Android and use the same chats, background tasks, files, side
chats and Calendar there. The app lives in
[`ee/apps/workbot-mobile`](../../../ee/apps/workbot-mobile/README.md) and talks
only to Workbot's `/v1/workbot/...` API.

## Who gets it

- Members of organizations that have both Workbot and `workbotMobile` on.
  The browser Workbot is unchanged either way.
- Signing in goes through Workbot and Den: the app opens `/auth/app/login`
  with its own PKCE challenge, Den returns the code to Workbot, and Workbot
  hands it to the app's verified HTTPS return address
  (`/auth/app/callback`). The app trades it at `POST /auth/app/token` for a
  sealed Workbot session it sends as a bearer token; it never holds Den
  tokens. Details: [Workbot's README](../../../ee/apps/workbot/README.md#the-phone-app).
- iOS and Android only hand the return address to the app once Workbot
  serves its identity: set `WORKBOT_IOS_TEAM_ID` and
  `WORKBOT_ANDROID_CERT_SHA256`. Unset, the phone app can't finish signing
  in.

## How to try it

Follow "Run it locally" in the
[app's README](../../../ee/apps/workbot-mobile/README.md#run-it-locally), and
turn `workbotMobile` on for the organization in `/admin` › Features.

## Turning it off

Nothing is deleted. `/v1/workbot/me` still answers so the app can say the
phone app is off, and every other `/v1/workbot` request from the app is
refused with `403 workbot_mobile_not_enabled` on its next request. Browser
sessions are not affected.

## What to watch

`workbot_mobile_not_enabled` answers, sign-in failures from
`POST /auth/app/token` (`sign_in_failed`, `den_unavailable`) and refreshes at
`POST /auth/app/refresh`. Rules: `ee/apps/workbot/scripts/auth.test.ts`.

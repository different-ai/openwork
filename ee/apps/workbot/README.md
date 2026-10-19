# Workbot

One ongoing chat per member, on its own address (`chat.openworklabs.com`). People sign in with their OpenWork
account through Den; the conversation runs on the [headless runner](../headless-runner) with kept files and a
Linux computer.

```
browser ── chat.openworklabs.com (this app: page + API) ──┬── Den (sign-in, who you are, turn tokens)
                                                          └── headless runner (the conversation)
```

- **The page** is [`@openwork-ee/workbot-ui`](../../packages/workbot-ui), built with Vite and served by this app.
- **The API** (`/v1/workbot/...`) is [`@openwork-ee/workbot-server`](../../packages/workbot-server) behind this
  app's sign-in. Every request needs a signed-in member and Den's answer that Workbot is on for their workspace.
- **Den stays the identity provider.** Workbot is Den's first-party OAuth client `openwork-workbot` (PKCE, no
  secret, no consent screen, one return address `${WORKBOT_PUBLIC_URL}/auth/callback`). Den creates it from
  `DEN_WORKBOT_URL`. The access token Workbot gets only works on Den's `/mcp/agent` resource and on
  `GET /v1/workbot/session` and `POST /v1/workbot/run-token`; it never sees the person's Den session.
- **Each turn** gets a fresh member-scoped token from `POST /v1/workbot/run-token` (at most an hour). Den refuses it
  when Workbot is off for the workspace or the membership ended.

## Sessions

Workbot keeps nothing on disk, so it runs as any number of instances. The person's Den tokens live in an HttpOnly,
`SameSite=Lax`, `__Host-` cookie, encrypted and authenticated with `WORKBOT_SESSION_SECRET` (AES-256-GCM); a sign-in
in progress (PKCE state) lives in a second, ten-minute cookie. Access tokens refresh a little before they expire,
once per refresh token: requests still carrying the previous cookie get that refresh's tokens instead of spending the
rotated token again. If two instances race on one refresh anyway, the person goes through Den's sign-in again, which
returns at once while their Den session lasts. Den is asked who the person is at most every
30 seconds, so a revoked grant or membership signs them out quickly. Changes must come from this site's own origin.
Signing out revokes the refresh token at Den.

## The phone app

The [Workbot app](../workbot-mobile) for iPhone and Android signs in through Workbot, so Den keeps one return address
and the phone never holds Den tokens:

1. The app opens `/auth/app/login` in the system's sign-in browser with its own PKCE challenge, its state and its
   return address.
2. Workbot sends the person to Den with that challenge. Den returns to Workbot's `/auth/callback`, which hands the
   code to the app's return address: `/auth/app/callback` on Workbot itself, which iOS and Android open only in the
   Workbot app they verified against `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`.
   Anyone can start a sign-in with a challenge of their own, so the code never goes to an address another app could
   claim. Private-use schemes are rejected on every deployment, including localhost; phone sign-in requires
   an HTTPS deployment with verified app links.
3. The app trades the code and its verifier at `POST /auth/app/token` for a Workbot session, encrypted with
   `WORKBOT_SESSION_SECRET` like the cookie, and sends it as `Authorization: Bearer`. When the Den tokens inside are refreshed, the response
   carries the new session in `Workbot-Session`; `POST /auth/app/refresh` renews it before it expires, and
   `POST /auth/logout` revokes it.

The phone also needs the `workbotMobile` feature. Without it, `/v1/workbot/me` says so and every other request is
refused with `workbot_mobile_not_enabled`.

## Configuration

| Variable | | |
|---|---|---|
| `WORKBOT_PUBLIC_URL` | required | Where people reach Workbot, e.g. `https://chat.openworklabs.com` |
| `WORKBOT_DEN_API_URL` | required | Den's public API, e.g. `https://api.openworklabs.com`. Sign-in is discovered from its `/mcp/agent` resource |
| `WORKBOT_DEN_WEB_URL` | sign-in origin | Den's web app, for the link back and app logos |
| `WORKBOT_RUNNER_URL`, `WORKBOT_RUNNER_TOKEN` | required | The headless runner and its service token (`HEADLESS_API_TOKEN`) |
| `WORKBOT_SESSION_SECRET` | required | ≥ 32 characters; encrypts the sign-in cookies. Changing it signs everyone out |
| `WORKBOT_IOS_TEAM_ID` | unset | The Workbot app's Apple team ID, served in `apple-app-site-association` so iOS returns sign-in to the app. Unset: the iPhone app can't finish signing in |
| `WORKBOT_ANDROID_CERT_SHA256` | unset | SHA-256 fingerprints of the Android app's signing certificates, comma-separated, served in `assetlinks.json`. Unset: the Android app can't finish signing in |
| `PORT` / `WORKBOT_PORT` | `3020` | |
| `WORKBOT_SENTRY_DSN` | unset | Optional Sentry error reports from the server: route errors, sign-in and token refresh failures, `den_unavailable`, runner unreachable or 5xx, live-event relay failures. Stable codes only, never messages, tokens or cookies. Unset sends nothing |
| `WORKBOT_SENTRY_ENVIRONMENT`, `WORKBOT_SENTRY_RELEASE` | unset, `workbot@<WORKBOT_VERSION>` | Tags on those reports |

On Den, set `DEN_WORKBOT_URL` (den-api) to the same address as `WORKBOT_PUBLIC_URL`; den-web's `/workbot` redirects
there. Then turn Workbot on per organization: the admin panel, or the `den_set_org_capability` admin tool.

## Run

```sh
pnpm dev:workbot   # Den, the runner and Workbot together; open http://localhost:3020
pnpm --filter @openwork-ee/workbot build && pnpm --filter @openwork-ee/workbot start
```

## Deploy on Render

A web service in the same region as the headless runner (it reaches the runner's private address).

| Setting | Value |
|---|---|
| Build command | `pnpm install --filter @openwork-ee/workbot... --frozen-lockfile && pnpm --dir ee/apps/workbot run build` |
| Start command | `pnpm --dir ee/apps/workbot run start` |
| Health check | `/healthz` |
| Disk | None. Scale instances freely |
| Custom domain | `chat.openworklabs.com` |

## Documents

The Documents tab mounts the reusable `@openwork/documents` workspace through
`@openwork-ee/workbot-ui`. `workbotDocuments` is off by default and also requires
Workbot. Enable it through Den's existing Features controls; there is no separate
Workbot environment switch.

Recent and My Drive use the member's real Drive API v3 connection. Missing
access offers Connect/Reconnect. Word, Excel, PowerPoint and OpenDocument files
open in tabs with OpenWork controls and a separately hosted editor engine.
Explicit saves update original uploaded files. Native Google Docs, Sheets and
Slides export into Office copies; saving creates a new file and preserves the
Google original. UTF-8 text edits save to the original; PDFs/images preview inline.
Other formats link to the original editor. This is not Google native collaboration.

The reusable package and browser UI are MIT-licensed; the server host retains
OpenWork's EE license. An all-open-source editor deployment requires a maintained
unbranded engine image (`nobrand=yes` or a source build); the default vendor image
is not the production license baseline. See the package's `THIRD_PARTY_NOTICES.md` for the boundary.

The host protects dirty tabs before navigation. Den independently checks the
feature, membership, OAuth read/write scopes and the exact Google connection.
The editor preserves unrelated file parts and refuses unsupported unsafe edits.
See `packages/documents/README.md` for the package contract, format limits,
permission requirements and concurrency boundaries.

## Workspace assistant

`workbotWorkspaceAssistant` is off by default on cloud and self-hosted installs.
With Workbot on, it adds the compact navigation drawer and floating composer to
Documents and Calendar. Documents also requires `workbotDocuments`; Calendar
retains its existing feature checks. The drawer reads recent files through the
same authenticated Drive provider as Documents.

At Send, the user can include or exclude the current view. The bounded snapshot
contains the open Drive file's ID and unsaved status, or the calendar
range, time zone and selected event/automation ID. Display titles, MIME labels and search text never enter the model prompt. It contains no document bytes or
unsaved text. Contextual turns, retries and interrupted-turn resumes use read-only MCP credentials and disable write-capable runner tools. Changes require a separate explicit request from Home without view context. Workbot reads saved content using the member's existing connected
apps and permissions; visible metadata grants no access. The snapshot remains
with that turn for transcript display, editing and retry. After a native Google
file is saved as an Office copy, context follows the confirmed copy’s file ID.

Canonical Google document links in replies offer an explicit open action in
Documents. Metadata resolves through Den again before the file opens; links
never navigate automatically. Other links keep their usual external behavior.
The Documents browser remains mounted while the user switches surfaces, keeping
local drafts intact. Turning the assistant off removes contextual actions and
rejects new context requests without unmounting an already-open editor.

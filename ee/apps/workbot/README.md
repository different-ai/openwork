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
  app's sign-in. Every request needs a signed-in member and Den's current access decision.
- **Den stays the identity provider.** Workbot is Den's first-party OAuth client `openwork-workbot` (PKCE, no
  secret, no consent screen, one return address `${WORKBOT_PUBLIC_URL}/auth/callback`). Den creates it from
  `DEN_WORKBOT_URL`. The access token Workbot gets only works on Den's `/mcp/agent` resource and on
  `GET /v1/workbot/session` and `POST /v1/workbot/run-token`; it never sees the person's Den session.
- **Each turn** gets a fresh member-scoped token from `POST /v1/workbot/run-token` (at most an hour). Den refuses it
  when membership or the required access grant is no longer valid.

## Sessions

Workbot keeps nothing on disk, so it runs as any number of instances. The person's Den tokens live in an HttpOnly,
`SameSite=Lax`, `__Host-` cookie, encrypted and authenticated with `WORKBOT_SESSION_SECRET` (AES-256-GCM); a sign-in
in progress (PKCE state) lives in a second, ten-minute cookie. Access tokens refresh a little before they expire,
once per refresh token: requests still carrying the previous cookie get that refresh's tokens instead of spending the
rotated token again. If two instances race on one refresh anyway, the person goes through Den's sign-in again, which
returns at once while their Den session lasts. Den is asked who the person is at most every
30 seconds, so a revoked grant or membership signs them out quickly. Changes must come from this site's own origin.
Signing out revokes the refresh token at Den.

## Configuration

| Variable | | |
|---|---|---|
| `WORKBOT_PUBLIC_URL` | required | Where people reach Workbot, e.g. `https://chat.openworklabs.com` |
| `WORKBOT_DEN_API_URL` | required | Den's public API, e.g. `https://api.openworklabs.com`. Sign-in is discovered from its `/mcp/agent` resource |
| `WORKBOT_DEN_WEB_URL` | sign-in origin | Den's web app, for the link back and app logos |
| `WORKBOT_RUNNER_URL`, `WORKBOT_RUNNER_TOKEN` | required | The headless runner and its service token (`HEADLESS_API_TOKEN`) |
| `WORKBOT_SESSION_SECRET` | required | ≥ 32 characters; encrypts the sign-in cookies. Changing it signs everyone out |
| `PORT` / `WORKBOT_PORT` | `3020` | |
| `WORKBOT_SENTRY_DSN` | unset | Optional Sentry error reports from the server: route errors, sign-in and token refresh failures, `den_unavailable`, runner unreachable or 5xx, live-event relay failures. Stable codes only, never messages, tokens or cookies. Unset sends nothing |
| `WORKBOT_SENTRY_ENVIRONMENT`, `WORKBOT_SENTRY_RELEASE` | unset, `workbot@<WORKBOT_VERSION>` | Tags on those reports |

On Den, set `DEN_WORKBOT_URL` (den-api) to the same address as `WORKBOT_PUBLIC_URL`; den-web's `/workbot` redirects
there. Workbot is generally available; service configuration and each member's model access are still required.

### Separate deployment domains

Workbot, Den web and Den API can use unrelated HTTPS domains. Workbot discovers
the authorization server from `WORKBOT_DEN_API_URL`; browser sign-in visits Den
and returns to Workbot, while the code exchange runs on Workbot's server. Their
browser cookies do not need a shared parent domain.

- Set `DEN_WORKBOT_URL` and `WORKBOT_PUBLIC_URL` to the same canonical Workbot
  origin. Den registers exactly `<origin>/auth/callback`. An alias or preview
  host cannot share that callback: its host-only login cookie belongs to the
  host where sign-in started. Keep this value consistent across Den replicas.
- Set Den's `DEN_BASE_URL` (and `BETTER_AUTH_URL`, if supplied) to its public web
  origin, and `DEN_API_PUBLIC_URL` to the public API origin. Configure
  `DEN_API_BASE` on den-web for its server-side API connection. Browser session
  requests use den-web's same-origin auth and browser proxies.
- Set `WORKBOT_DEN_WEB_URL` explicitly when dashboard links should use a
  different origin from the discovered issuer. It controls links, not OAuth
  discovery. `WORKBOT_DEN_API_URL` must be reachable from the Workbot server.
- These values are origins, not subpath mounts. Changing the Workbot origin
  during an in-progress sign-in or account connection requires a fresh attempt.

The focused auth test covers discovery and code exchange across three custom
domains with synthetic endpoints; it does not verify deployed DNS, TLS, ingress
or a live identity provider.

### Internal health check

`GET /internal/readiness` authenticates with the existing `WORKBOT_RUNNER_TOKEN`.
An authenticated `X-OpenWork-Den-Origin` header asks it to compare the expected Den
origin with its configuration, without returning either URL. The versioned
response contains configuration facts only; it does not test sign-in, a model
completion or delivery. It has no effect on public `/healthz` liveness checks.
See [diagnostics](../../../docs/diagnostics.md).

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

When the person explicitly asks Workbot to open or show a document, Workbot can
request it with `open_document` (message turns only, including read-only
contextual ones; never tasks or reports). The runner records only a request.
The page follows it once, only for a message sent from that page and only if
the person is still on the view they sent it from; reloads, history and
retries never replay an earlier request. Under the reply, Workbot says
"Opening in Documents…", then "Opened in Documents", "Couldn't open this
document" (Den refused or failed), or "Not opened, because you moved on" with
an Open action. While a document opens, the view context names nothing, so a
message sent meanwhile never references the previous document.
The Documents browser remains mounted while the user switches surfaces, keeping
local drafts intact. Turning the assistant off removes contextual actions and
rejects new context requests without unmounting an already-open editor.

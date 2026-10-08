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

## Apps

Where Workbot's Apps are on (the `workbotApps` feature), an App a tool result opens shows inside the reply: Apps built in OpenWork and Apps from connected MCP servers. Den stays the authority. Workbot's server reads the App's page from the connection that opened it and runs only that connection's tools, as the person, with a short-lived token Den mints only for this (`POST /v1/workbot/app-token`); the token never reaches the browser or the runner. A tool that isn't read-only runs only right after the person's click in the App. The page runs each App in the MCP Apps sandbox this app serves at `/mcp-apps/sandbox.html` (the proxy the desktop app and Den's gateway serve), framed without same-origin access, under the policy the App declared.

The runner keeps each App's launch and result with the conversation (its `apps` setting), so an App opens the same way after a reload, and what an App tells the model (`ui/update-model-context`) reaches the model from its next step. A message an App sends as the person (`ui/message`), or a link it opens, needs their gesture in that App, once per gesture.

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

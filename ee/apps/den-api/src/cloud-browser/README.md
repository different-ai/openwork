# Cloud browser

A real browser for headless agent runs (Slack replies, cloud Automations,
Workbot) when no connection covers the task, with a hand-off so the person
signs in themselves and the sign-in is remembered.

Built on `@openwork-ee/cloud-browser` (`ee/packages/cloud-browser`): one
persistent, private browser box per organization member (a Daytona sandbox in
production), driven by stateless DevTools calls so any Den replica can serve
any call.

## Files

- `service.ts`: the deployment's browser (`DEN_CLOUD_BROWSER_PROVIDER`), the
  per-organization `cloudBrowser` capability, and the Den Web `/browser` link.
- `mcp-tools.ts`: `browser_open`, `browser_observe`, `browser_act`,
  `browser_navigate`, `browser_handoff` on `/mcp/agent`, registered only for
  headless-run tokens in organizations with the capability.
- `routes.ts`: the person's live view and take-over input, used by Den Web.

## Routes (member-scoped, never MCP operations)

- `GET /v1/cloud-browser`: available, running, active tab address and title. Starts nothing.
- `GET /v1/cloud-browser/screen`: the active tab as a JPEG. Starts nothing; 409 when not running.
- `POST /v1/cloud-browser/input`: the person's clicks, wheel, text and keys, in order.
- `POST /v1/cloud-browser/done`: keeps the sign-in (session cookies become persistent).

DevTools URLs and preview tokens never leave Den.

## Turning it on

1. Push a snapshot: `scripts/create-daytona-cloud-browser-snapshot.sh`.
2. Set `DEN_CLOUD_BROWSER_PROVIDER=daytona` and
   `DEN_CLOUD_BROWSER_DAYTONA_SNAPSHOT` (see `.env.example`).
3. Enable "Cloud browser" for the organization in /admin → Capabilities.

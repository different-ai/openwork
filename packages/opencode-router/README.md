# opencode-router

Simple Slack + Telegram bridge + directory router for a running `opencode` server.

Runtime requirement: Bun 1.3+ (`bun --version`).

## Install + Run

One-command install (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/opencode-router/install.sh | bash
```

Install from npm:

```bash
npm install -g opencode-router
```

Quick run without global install:

```bash
npx --yes opencode-router --help
```

Then configure identities and start.

1) One-command setup (installs deps, builds, creates `.env` if missing):

```bash
pnpm -C packages/opencode-router setup
```

2) (Optional) Fill in `packages/opencode-router/.env` (see `.env.example`).

Required:
- `OPENCODE_URL`
- `OPENCODE_DIRECTORY`

Recommended:
- `OPENCODE_SERVER_USERNAME`
- `OPENCODE_SERVER_PASSWORD`

3) Run the router:

```bash
opencode-router start
```

## Telegram

Telegram support is configured via identities. You can either:
- Use env vars for a single bot: `TELEGRAM_BOT_TOKEN=...`
  - Or add multiple bots to the config file (`opencode-router.json`) using the CLI:

```bash
opencode-router telegram add <token> --id default
opencode-router telegram list
```

Important for direct sends and bindings:
- Telegram targets must use numeric `chat_id` values.
- `@username` values are not valid direct `peerId` targets for router sends.
- If a user has not started a chat with the bot yet, Telegram may return `chat not found`.
- Private Telegram identities can require first-chat pairing with `/pair <code>` before commands are accepted.

## Slack (Socket Mode)

Slack support uses Socket Mode and replies in threads when @mentioned in channels.

1) Create a Slack app.
2) Enable Socket Mode and generate an app token (`xapp-...`).
3) Add bot token scopes:
   - `chat:write`
   - `app_mentions:read`
   - `im:history`
4) Subscribe to events (bot events):
   - `app_mention`
   - `message.im`
5) Set env vars (or save via `opencode-router slack add ...`):
    - `SLACK_BOT_TOKEN=xoxb-...`
    - `SLACK_APP_TOKEN=xapp-...`
    - `SLACK_ENABLED=true`

To add multiple Slack apps:

```bash
opencode-router slack add <xoxb> <xapp> --id default
opencode-router slack list
```

## Identity-Scoped Routing

The router routes messages based on `(channel, identityId, peerId) -> directory` bindings.

```bash
opencode-router bindings set --channel telegram --identity default --peer <chatId> --dir /path/to/workdir
opencode-router bindings list
```

## Health Server (Local HTTP)

The router can expose a small local HTTP server for health/config and simple message dispatch.

- `OPENCODE_ROUTER_HEALTH_PORT` controls the port (OpenWork defaults to a random free port when using `openwork`).
- `PORT` is also accepted as a convenience if the above are unset.
- `OPENCODE_ROUTER_HEALTH_HOST` controls bind host (default: `127.0.0.1`).

Send a message to all peers bound to a directory:

```bash
curl -sS "http://127.0.0.1:${OPENCODE_ROUTER_HEALTH_PORT:-3005}/send" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"telegram","directory":"/path/to/workdir","text":"hello"}'
```

## Commands

```bash
opencode-router start
opencode-router status

opencode-router telegram list
opencode-router telegram add <token> --id default

opencode-router slack list
opencode-router slack add <xoxb> <xapp> --id default

opencode-router bindings list
opencode-router bindings set --channel telegram --identity default --peer <chatId> --dir /path/to/workdir
```

## Defaults

- SQLite at `~/.openwork/opencode-router/opencode-router.db` unless overridden.
- Config stored at `~/.openwork/opencode-router/opencode-router.json` (created by `opencode-router` or `pnpm -C packages/opencode-router setup`).
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Tests

`test:smoke` requires a running `opencode` server (default: `http://127.0.0.1:4096`).

```bash
opencode serve --port 4096 --hostname 127.0.0.1
pnpm -C packages/opencode-router test:smoke
```

Other test suites:

```bash
pnpm -C packages/opencode-router test:unit
pnpm -C packages/opencode-router test:cli
pnpm -C packages/opencode-router test:npx
```

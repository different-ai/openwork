# OpenCode Router (formerly Owpenbot)

Simple Slack + Telegram bridge + directory router for a running OpenCode server.

## Install + Run

One-command install (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh | bash
```

Or install from npm (package name is still `owpenwork`):

```bash
npm install -g owpenwork
```

Quick run without install (runs the legacy `owpenwork` alias):

```bash
npx owpenwork
```

Then follow the guided setup (choose what to configure, start).

1) One-command setup (installs deps, builds, creates `.env` if missing):

```bash
pnpm -C packages/owpenbot setup
```

2) (Optional) Fill in `packages/owpenbot/.env` (see `.env.example`).

Required:
- `OPENCODE_URL`
- `OPENCODE_DIRECTORY`

Recommended:
- `OPENCODE_SERVER_USERNAME`
- `OPENCODE_SERVER_PASSWORD`

3) Run the router:

```bash
opencode-router

# (legacy aliases)
owpenwork
owpenbot
```

## Telegram

Telegram support is configured via identities. You can either:
- Use env vars for a single bot: `TELEGRAM_BOT_TOKEN=...`
- Or add multiple bots to the config file (`owpenbot.json`) using the CLI:

```bash
opencode-router telegram add <token> --id default
opencode-router telegram list
```

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

- `OPENCODE_ROUTER_HEALTH_PORT` or `OWPENBOT_HEALTH_PORT` controls the port (OpenWork defaults to a random free port when using `openwrk`).
- `PORT` is also accepted as a convenience if the above are unset.
- `OWPENBOT_HEALTH_HOST` controls bind host (default: `127.0.0.1`).

Send a message to all peers bound to a directory:

```bash
curl -sS "http://127.0.0.1:${OWPENBOT_HEALTH_PORT:-3005}/send" \
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

- SQLite at `~/.openwork/owpenbot/owpenbot.db` unless overridden.
- Config stored at `~/.openwork/owpenbot/owpenbot.json` (created by `owpenwork` or `owpenwork setup`).
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Tests

```bash
pnpm -C packages/owpenbot test:unit
pnpm -C packages/owpenbot test:smoke
pnpm -C packages/owpenbot test:cli
pnpm -C packages/owpenbot test:npx
```

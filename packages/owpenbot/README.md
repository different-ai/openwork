# Owpenbot

Simple Slack + Telegram bridge for a running OpenCode server.

## Install + Run

One-command install (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh | bash
```

Or install from npm:

```bash
npm install -g owpenwork
```

Quick run without install:

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

3) Run owpenwork:

```bash
owpenwork
```

## Telegram

Telegram support is configured via identities. You can either:
- Use env vars for a single bot: `TELEGRAM_BOT_TOKEN=...`
- Or add multiple bots to the config file (`owpenbot.json`) using the CLI:

```bash
owpenbot telegram add <token> --id default
owpenbot telegram list
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
5) Set env vars (or save via `owpenbot slack add ...`):
    - `SLACK_BOT_TOKEN=xoxb-...`
    - `SLACK_APP_TOKEN=xapp-...`
    - `SLACK_ENABLED=true`

To add multiple Slack apps:

```bash
owpenbot slack add <xoxb> <xapp> --id default
owpenbot slack list
```

## Identity-Scoped Routing

Owpenbot routes messages based on `(channel, identityId, peerId) -> directory` bindings.

```bash
owpenbot bindings set --channel telegram --identity default --peer <chatId> --dir /path/to/workdir
owpenbot bindings list
```

## Health Server (Local HTTP)

Owpenbot can expose a small local HTTP server for health/config and simple message dispatch.

- `OWPENBOT_HEALTH_PORT` controls the port (OpenWork defaults to a random free port when using `openwrk`).
- `OWPENBOT_HEALTH_HOST` controls bind host (default: `127.0.0.1`).

Send a message to all peers bound to a directory:

```bash
curl -sS "http://127.0.0.1:${OWPENBOT_HEALTH_PORT:-3005}/send" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"telegram","directory":"/path/to/workdir","text":"hello"}'
```

## Commands

```bash
owpenbot start
owpenbot status

owpenbot telegram list
owpenbot telegram add <token> --id default

owpenbot slack list
owpenbot slack add <xoxb> <xapp> --id default

owpenbot bindings list
owpenbot bindings set --channel telegram --identity default --peer <chatId> --dir /path/to/workdir
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

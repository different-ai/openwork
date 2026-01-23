# Owpenbot

Simple WhatsApp bridge for a running OpenCode server. Telegram support exists but is not yet E2E tested.

## Install + Run (WhatsApp)

One-command install (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh | bash
```

Then follow the printed next steps (edit `.env`, pair WhatsApp, start the bridge).

1) One-command setup (installs deps, builds, creates `.env` if missing):

```bash
pnpm -C packages/owpenbot setup
```

2) Fill in `packages/owpenbot/.env` (see `.env.example`).

Required:
- `OPENCODE_URL`
- `OPENCODE_DIRECTORY`
- `WHATSAPP_AUTH_DIR`

Recommended:
- `OPENCODE_SERVER_USERNAME`
- `OPENCODE_SERVER_PASSWORD`

3) Pair WhatsApp (first time only):

```bash
pnpm -C packages/owpenbot whatsapp:login
```

4) Launch the bridge:

```bash
pnpm -C packages/owpenbot start
```

5) Pair a user with the bot:

- Run `pnpm -C packages/owpenbot pairing-code` to get the code.
- Send a WhatsApp message containing the code (e.g. `123456 hello`).
- You should receive an OpenCode response in the same chat.

## Usage Flows

### One-person flow (personal testing)

Use your own WhatsApp account as the bot and test from a second number you control.

1) Pair WhatsApp using your personal number (`whatsapp:login`).
2) Send the pairing code from a second number (SIM/eSIM or another phone).
3) Chat from that second number to receive OpenCode replies.

Note: WhatsApp’s “message yourself” thread is not reliable for bot testing.

### Two-person flow (dedicated bot)

Use a separate WhatsApp number as the bot account so it stays independent from your personal chat history.

1) Create a new WhatsApp account for the dedicated number.
2) Pair that account with `whatsapp:login`.
3) Share the pairing code with the person who should use the bot.
4) Optionally pre-allowlist specific numbers with `ALLOW_FROM_WHATSAPP=`.

## Telegram (Untested)

Telegram support is wired but not E2E tested yet. To try it:
- Set `TELEGRAM_BOT_TOKEN`.
- Optionally set `TELEGRAM_ENABLED=true`.

## Commands

```bash
pnpm -C packages/owpenbot start
pnpm -C packages/owpenbot whatsapp:login
pnpm -C packages/owpenbot pairing-code
```

## Defaults

- SQLite at `~/.owpenbot/owpenbot.db` unless overridden.
- Allowlist is enforced by default; a pairing code is generated if not provided.
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Tests

```bash
pnpm -C packages/owpenbot test:unit
pnpm -C packages/owpenbot test:smoke
```

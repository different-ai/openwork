# Owpenbot

Simple WhatsApp bridge for a running OpenCode server. Telegram support exists but is not yet E2E tested.

## Install + Run (WhatsApp)

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

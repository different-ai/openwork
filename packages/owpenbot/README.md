# Owpenbot

Simple WhatsApp + Telegram bridge for a running OpenCode server.

## Quick Start

1) One-command setup (installs deps, builds, creates `.env` if missing):

```bash
pnpm -C packages/owpenbot setup
```

2) Fill in `packages/owpenbot/.env` (see `.env.example`).

3) Pair WhatsApp (first time only):

```bash
pnpm -C packages/owpenbot whatsapp:login
```

4) Launch the bridge:

```bash
pnpm -C packages/owpenbot start
```

## Commands

```bash
owpenbot start
owpenbot whatsapp login
owpenbot pairing-code
```

## Environment

Required:
- `OPENCODE_URL`
- `OPENCODE_DIRECTORY`
- `TELEGRAM_BOT_TOKEN`
- `WHATSAPP_AUTH_DIR`

Recommended:
- `OPENCODE_SERVER_USERNAME`
- `OPENCODE_SERVER_PASSWORD`

Defaults:
- Uses SQLite at `~/.owpenbot/owpenbot.db` unless overridden.
- Allowlist is enforced by default; a pairing code is generated if not provided.
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Tests

```bash
pnpm -C packages/owpenbot test:unit
pnpm -C packages/owpenbot test:smoke
```

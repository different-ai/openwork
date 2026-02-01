# Owpenbot

Simple WhatsApp bridge for a running OpenCode server. Telegram support exists but is not yet E2E tested.

## Install + Run (WhatsApp)

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

Then follow the guided setup (choose what to configure, link WhatsApp, start).

1) One-command setup (installs deps, builds, creates `.env` if missing):

```bash
pnpm -C packages/owpenbot setup
```

2) (Optional) Fill in `packages/owpenbot/.env` (see `.env.example`).

Required:
- `OPENCODE_URL`
- `OPENCODE_DIRECTORY`
- `WHATSAPP_AUTH_DIR`

Recommended:
- `OPENCODE_SERVER_USERNAME`
- `OPENCODE_SERVER_PASSWORD`

3) Run owpenwork and follow the guided setup:

```bash
owpenwork
```

Owpenwork keeps the WhatsApp session alive once connected.

6) Pair a user with the bot (only if DM policy is pairing):

- Run `owpenwork pairing list` to view pending codes.
- Approve a code: `owpenwork pairing approve <code>`.
- The user can then message again to receive OpenCode replies.

## Usage Flows

### One-person flow (personal testing)

Use your own WhatsApp account as the bot and test from a second number you control.

1) Run `owpenwork` and choose “personal number.”
2) Scan the QR when prompted.
3) Message yourself or from a second number; your number is already allowlisted.

Note: WhatsApp’s “message yourself” thread is not reliable for bot testing.

### Two-person flow (dedicated bot)

Use a separate WhatsApp number as the bot account so it stays independent from your personal chat history.

1) Create a new WhatsApp account for the dedicated number.
2) Run `owpenwork` and choose “dedicated number.”
3) Scan the QR when prompted.
4) If DM policy is pairing, approve codes with `owpenwork pairing approve <code>`.

## Telegram (Untested)

Telegram support is wired but not E2E tested yet. To try it:
- Run `owpenwork login telegram --token <token>`.
- Or set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ENABLED=true`.

## Commands

```bash
owpenwork
owpenwork --non-interactive
owpenwork login whatsapp
owpenwork login telegram --token <token>
owpenwork pairing list
owpenwork pairing approve <code>
owpenwork status
owpenwork doctor --reset
```

## Defaults

- SQLite at `~/.owpenbot/owpenbot.db` unless overridden.
- Config stored at `~/.owpenbot/owpenbot.json` (created by `owpenwork` or `owpenwork setup`).
- DM policy defaults to `pairing` unless changed in setup.
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Tests

```bash
pnpm -C packages/owpenbot test:unit
pnpm -C packages/owpenbot test:smoke
pnpm -C packages/owpenbot test:cli
pnpm -C packages/owpenbot test:npx
```

# Owpenbot

Simple WhatsApp bridge for a running OpenCode server. Telegram support exists but is not yet E2E tested.

## Install + Run (WhatsApp)

One-command install (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh | bash
```

Then follow the printed next steps (run `owpenbot setup`, link WhatsApp, start the bridge).

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

3) Run setup (writes `~/.owpenbot/owpenbot.json`):

```bash
owpenbot setup
```

4) Link WhatsApp (QR):

```bash
owpenbot whatsapp login
```

5) Start the bridge:

```bash
owpenbot start
```

Owpenbot keeps the WhatsApp session alive once connected.

6) Pair a user with the bot (only if DM policy is pairing):

- Run `owpenbot pairing list` to view pending codes.
- Approve a code: `owpenbot pairing approve <code>`.
- The user can then message again to receive OpenCode replies.

## Usage Flows

### One-person flow (personal testing)

Use your own WhatsApp account as the bot and test from a second number you control.

1) Run `owpenbot setup` and choose “personal number.”
2) Run `owpenbot whatsapp login` to scan the QR.
3) Message yourself or from a second number; your number is already allowlisted.

Note: WhatsApp’s “message yourself” thread is not reliable for bot testing.

### Two-person flow (dedicated bot)

Use a separate WhatsApp number as the bot account so it stays independent from your personal chat history.

1) Create a new WhatsApp account for the dedicated number.
2) Run `owpenbot setup` and choose “dedicated number.”
3) Run `owpenbot whatsapp login` to scan the QR.
4) If DM policy is pairing, approve codes with `owpenbot pairing approve <code>`.

## Telegram (Untested)

Telegram support is wired but not E2E tested yet. To try it:
- Set `TELEGRAM_BOT_TOKEN`.
- Optionally set `TELEGRAM_ENABLED=true`.

## Commands

```bash
owpenbot setup
owpenbot whatsapp login
owpenbot start
owpenbot pairing list
owpenbot pairing approve <code>
owpenbot status
```

## Defaults

- SQLite at `~/.owpenbot/owpenbot.db` unless overridden.
- Config stored at `~/.owpenbot/owpenbot.json` (created by `owpenbot setup`).
- DM policy defaults to `pairing` unless changed in setup.
- Group chats are disabled unless `GROUPS_ENABLED=true`.

## Tests

```bash
pnpm -C packages/owpenbot test:unit
pnpm -C packages/owpenbot test:smoke
```

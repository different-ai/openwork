# Owpenbot

Simple WhatsApp bridge for a running OpenCode server. Telegram support exists but is not yet E2E tested.

## Install + Run (WhatsApp)

### Safer installer usage

Instead of piping a remote script directly into `bash`, download and inspect the installer first:

```bash
curl -fsSL https://raw.githubusercontent.com/different-ai/openwork/dev/packages/owpenbot/install.sh -o owpenbot-install.sh
# Review owpenbot-install.sh in your editor, then:
bash owpenbot-install.sh
```

The installer will:

- Clone/update this repo into `~/.owpenbot/openwork` by default.
- Run `pnpm install` at the repo root.
- Build the Owpenbot package.
- Create `packages/owpenbot/.env` if it doesn’t exist.
- Install an `owpenbot` shim into `~/.local/bin` (or your configured `OWPENBOT_BIN_DIR`).

Then follow the printed next steps (edit `.env`, run `owpenbot`).

### Manual setup from source

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

Security recommendations:
- Point `OPENCODE_DIRECTORY` at a **dedicated workspace** for Owpenbot, not your entire home directory.
- Keep `PERMISSION_MODE=deny` unless you fully understand the implications (see below).

3) Run the bridge:

```bash
owpenbot
```

Owpenbot prints a QR code if WhatsApp is not paired and keeps the session alive once connected.

5) Pair a user with the bot:

- Run `pnpm -C packages/owpenbot pairing-code` to get the code.
- Send a WhatsApp message containing the code (e.g. `123456 hello`).
- You should receive an OpenCode response in the same chat.

## Usage Flows

### One-person flow (personal testing)

Use your own WhatsApp account as the bot and test from a second number you control.

1) Pair WhatsApp using your personal number (just run `owpenbot` to show the QR).
2) Send the pairing code from a second number (SIM/eSIM or another phone).
3) Chat from that second number to receive OpenCode replies.

Note: WhatsApp’s “message yourself” thread is not reliable for bot testing.

### Two-person flow (dedicated bot)

Use a separate WhatsApp number as the bot account so it stays independent from your personal chat history.

1) Create a new WhatsApp account for the dedicated number.
2) Pair that account by running `owpenbot` and scanning the QR.
3) Share the pairing code with the person who should use the bot.
4) Optionally pre-allowlist specific numbers with `ALLOW_FROM_WHATSAPP=`.

## Telegram (Untested)

Telegram support is wired but not E2E tested yet. To try it:
- Set `TELEGRAM_BOT_TOKEN`.
- Optionally set `TELEGRAM_ENABLED=true`.

## Security & Permissions

Owpenbot sits on top of a single OpenCode workspace and can exercise its tools on behalf of chat users. Configuration choices matter.

### Permission mode

Owpenbot uses a simple permission mode:

- `PERMISSION_MODE=deny` (default)
  - Sessions are created with a blanket deny rule (`*/* -> deny`).
  - Any `permission.asked` events from OpenCode are auto-rejected.
  - This is the safest default and is recommended for most deployments.
- `PERMISSION_MODE=readonly`
  - Sessions are created with a **read-only ruleset**:
    - Non-destructive tools such as `read`, `list`, `glob`, `grep`, `websearch`, and `codesearch` are allowed.
    - Risky tools are explicitly denied, including:
      - `bash`
      - `edit` (covers `edit`, `write`, `patch`, `multiedit`)
      - `task` (subagents)
      - `todowrite`
      - `external_directory`
      - `webfetch`
  - Permission prompts (if any still occur) are auto-rejected.
  - This is a good fit for “review-only” or “read-only assistant” use cases in a scoped workspace.
- `PERMISSION_MODE=allow`
  - Sessions are created with a blanket allow rule (`*/* -> allow`).
  - Any permission prompts from OpenCode are auto-approved with `"always"`.
  - Paired users effectively get full workspace tool access (filesystem, shell, plugins, MCPs) as exposed by your OpenCode config.

**Strongly recommended:**

- Keep `PERMISSION_MODE=deny` for most deployments.
- Prefer `PERMISSION_MODE=readonly` over `allow` when you only need read/list/search capabilities.
- If you set `PERMISSION_MODE=allow`, ensure:
  - You are using a **dedicated, limited-scope workspace** for Owpenbot, and
  - You are comfortable with users in that chat having tool-level access.
- Never run Owpenbot with `PERMISSION_MODE=allow` pointed at `$HOME` or other broad directories.

### Pairing code and allowlist

- The pairing code is a 6-digit numeric code stored in SQLite.
- By default, it is rotated when it is older than roughly 24 hours at process startup. You can override it explicitly by setting `PAIRING_CODE` in the environment.
- The code is **not** sent back to unpaired users in chat; treat it as a shared secret and distribute it out-of-band (for example, via `pnpm -C packages/owpenbot pairing-code`).
- A simple in-memory rate limiter for unpaired peers reduces brute-force attempts.
- Use `ALLOW_FROM`, `ALLOW_FROM_TELEGRAM`, and `ALLOW_FROM_WHATSAPP` to restrict which peers or phone numbers can talk to the bot.

### Health server

Owpenbot can expose a simple health endpoint when `OWPENBOT_HEALTH_PORT` is set.

Current behavior:

- The health server listens on `127.0.0.1` only.
- It reports:
  - OpenCode URL and health status,
  - Detected engine version (if available),
  - Enabled channels (WhatsApp/Telegram).

To expose this remotely, prefer an explicit tunnel or port-forward (e.g. `ssh -L`) instead of binding directly to a network interface.

## Commands

```bash
owpenbot
pnpm -C packages/owpenbot pairing-code
```

## Defaults

- SQLite at `~/.owpenbot/owpenbot.db` unless overridden.
- Allowlist is enforced by default; a pairing code is generated if not provided.
- Group chats are disabled unless `GROUPS_ENABLED=true`.
- Health server (if enabled via `OWPENBOT_HEALTH_PORT`) binds to `127.0.0.1`.

## Tests

```bash
pnpm -C packages/owpenbot test:unit
pnpm -C packages/owpenbot test:smoke
```

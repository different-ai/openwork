---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create or update a skill that extends Claude with specialized knowledge, workflows, or tool integrations.
license: Complete terms in LICENSE.txt
---

# OpenCode Skill Template

> Disclaimer: This is a living template.

This document formalizes how to design and implement OpenCode skills in this repo so they are:

- **Portable** (shareable across machines/users)
- **Reconstructable** (can recreate required local state)
- **Self-building** (can bootstrap config/state and keep itself up to date)
- **Credential-safe** (no secrets in git; graceful first-time setup)

---

## Target Operating Model (WIP)

The intended long-term workflow:

1. Run OpenCode in a Docker container.
2. Use a skills package manager to:
   - Push skills from this repo
   - Let other users (e.g. family) pull the same skills

**Key constraint:** skills must be able to **self-bootstrap** their local state and credentials, because "pulling a skill" should not require manual repo surgery.

---

## Definitions

- **Skill**: A folder under `.opencode/skill/<skill-name>/` primarily anchored by `SKILL.md`.
- **Portable bundle (tracked)**: Files safe to commit and share.
- **Local overlay (untracked)**: Per-user/per-machine state and secrets (gitignored).

A good skill clearly separates these.

---

## Folder Layout (Preferred)

Collocated scaffold (no `src/`):

```
.opencode/skill/<skill-name>/
├── SKILL.md                    # Required. Human-readable + copy/paste commands.
├── .skill.config.example       # Tracked. Declares required env vars.
├── .skill.config               # Gitignored. Actual credentials.
├── load-env.ts                 # Tracked. Validates env vars; exports config.
├── client.ts                   # Tracked. Request helper (fetch wrapper).
├── first-call.ts               # Tracked. Minimal "does auth work?" check.
├── openapi.json                # Optional. Tracked API spec when available.
├── <thing>.example.json        # Optional. Tracked template for local state.
├── <thing>.json                # Optional. Gitignored generated local state.
└── scripts/                    # Optional. Tracked reusable scripts.
    ├── bootstrap.ts            # Optional. Creates/validates local overlay.
    └── <action>.ts             # Optional. Deterministic helpers.
```

Notes:

- If a skill does not need credentials, you can omit `.skill.config*` and `load-env.ts`.
- If a skill needs local configuration/state, include an `*.example.*` template and treat the real file as local overlay.
- Prefer putting runnable helpers under `scripts/` so they stay collocated and discoverable.
- Prefer **TypeScript scripts runnable with `bun`** (repo convention).

---

## Naming Rules

- Folder name is kebab-case: `^[a-z0-9]+(-[a-z0-9]+)*$`.
- `SKILL.md` frontmatter `name` matches folder name.
- `description` is one line and task-oriented.

---

## Non-Negotiables (Safety + Portability)

### Never commit secrets

Tracked files must never contain:

- API keys / tokens
- Passwords
- Session cookies
- User-specific IDs that should remain private

If it's sensitive, it goes in the local overlay (`.skill.config`, `*.json`, OS keychain, Bitwarden).

### Always provide a first-time path

Every credentialed skill needs:

- A quick "credential check" command
- A first-time setup section that tells the user exactly what to gather and where to put it
- A minimal verification call

### Prefer standards and stable APIs

- Use official REST APIs when available.
- Use browser automation only as a fallback.

---

## Credential Strategy (Multi-User Friendly)

### Primary: per-skill `.skill.config`

- Store credentials in `.opencode/skill/<skill-name>/.skill.config` (gitignored).
- Document required variables in `.skill.config.example`.
- Prefer this name over plain `.env` to avoid collisions with repo-root `.env` files.

Recommended `SKILL.md` snippet:

```bash
# Always run commands from the skill folder
cd .opencode/skill/<skill-name>

# Load credentials
source .skill.config
```

### Optional: Bitwarden or OS keychain

If you expect multiple users or frequent rotation, document a Bitwarden-based setup.

Rule of thumb:

- **Local `.skill.config`**: fastest and simplest.
- **Bitwarden**: best when credentials must be shared across machines/users without committing.

---

## Local State & "Self-Building" Skills

A self-building skill can:

- Detect missing local state (e.g. `telegram-chats.json`, `torrent-sources.json`).
- Create it from an `*.example.json` template.
- Guide the user to fill in required values.
- Validate the result.

### Pattern: tracked example + gitignored real file

- Tracked: `thing.example.json` (safe defaults)
- Local: `thing.json` (customized per environment)

This pattern is already used by:

- Telegram: `telegram-chats.example.json` -> `telegram-chats.json`
- qBittorrent: `torrent-sources.example.json` -> `torrent-sources.json`

### Pattern: bootstrap script

If the skill is expected to run end-to-end often, include a bootstrap script (tracked) that ensures the local overlay exists.

Preferred location: `.opencode/skill/<skill-name>/scripts/bootstrap.ts`.

Example responsibilities for `scripts/bootstrap.ts`:

- If `.skill.config` missing, print clear "Blocked" instructions (don't guess secrets).
- If `*.json` missing, copy from `*.example.json`.
- Validate required fields exist.
- Print next command(s) to run.

You can invoke it with:

```bash
bun .opencode/skill/<skill-name>/scripts/bootstrap.ts
```

---

## "Self-Improving" Skills

Skills should improve after real usage:

- If a command fails and you learn the correct syntax, update `SKILL.md` immediately.
- If an API returns surprising response codes or formats, document it.
- If a workflow repeats twice, consider adding a small script (`*.ts`) to make it deterministic.

Keep the updates portable:

- Update **templates** and docs in git.
- Keep user-specific values in local overlay.

---

## SKILL.md Required Sections (Recommended)

Use the following order and headings. This keeps skills consistent across the repo.

1. Frontmatter

```yaml
---
name: <skill-name>
description: <one-line description>
---
```

2. Credential Check

- A short command that prints whether config exists.
- Never prints full secrets (truncate tokens).

3. Environment Setup

- Where `.skill.config` lives.
- Example variables.

4. State / Config Files (if applicable)

- Which files are tracked templates vs local overlays.
- Exact copy commands.

5. Quick Usage

- Copy/paste-ready commands for 80% use cases.

6. Common Gotchas

- "Why it fails" + "how to fix".

7. First-Time Setup (If Not Configured)

- "What you need from the user" list.
- Step-by-step UI instructions if needed.
- "Test it works" command.

8. API Reference (optional)

- Endpoints, methods, meanings.

---

## Minimal `.skill.config.example`

Keep it short and declarative:

```bash
# <Skill Name>
# Base URL (include scheme)
SKILL_URL=

# Token or key
SKILL_TOKEN=
```

---

## Minimal `load-env.ts` (Template)

Use this pattern for strict validation and ergonomic usage in scripts.

```ts
// .opencode/skill/<skill-name>/load-env.ts

import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";

loadDotenv({ path: resolve(import.meta.dir, ".skill.config") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const SKILL_URL = requireEnv("SKILL_URL");
export const SKILL_TOKEN = requireEnv("SKILL_TOKEN");
```

Notes:

- If you don't want to hard-fail, print guidance and exit with a clear error.
- Don't auto-create `.skill.config` with secrets; only create `.skill.config` from `.skill.config.example` with blanks.

---

## Minimal `first-call.ts` (Template)

This should be the smallest possible auth/health check.

```ts
import { SKILL_TOKEN, SKILL_URL } from "./load-env";

const res = await fetch(`${SKILL_URL}/health`, {
  headers: { Authorization: `Bearer ${SKILL_TOKEN}` },
});

if (!res.ok) {
  throw new Error(`Auth check failed: ${res.status} ${await res.text()}`);
}

console.log("OK");
```

---

## Docker Considerations (So Skills Stay Portable)

When running OpenCode in Docker, keep the same split:

- Portable bundle: committed files inside the repo.
- Local overlay:
  - Bind-mount per-user secret/config files, or
  - Provide env vars via Docker runtime, or
  - Use secret managers outside git.

**Do not design a skill that requires editing tracked files to run.**

---

## Skill Authoring Checklist

Before calling a skill "done":

- `SKILL.md` contains a working "Credential Check" and "First-Time Setup".
- Any state/config has an `*.example.*` tracked template.
- All copy/paste commands are correct and tested.
- Nothing tracked contains secrets.
- There is a minimal "verification" call (`first-call.ts` or curl).
- The skill can be pulled into a fresh machine and bootstrapped with minimal steps.

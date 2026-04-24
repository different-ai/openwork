# Environment variables UI

Closes #1436.

## Why

Agentic workflows pull in secrets from every direction — LLM provider keys,
ElevenLabs for TTS, Gemini / Nano Banana for images, GitHub tokens for repo
automation, cloud project IDs, corporate proxies and CA certs. Skills and
MCPs in a workspace assume those values exist in the process environment.

Today the only way to get them there is to edit shell rc files and launch
OpenWork from a terminal, which:

- **Breaks entirely on Linux GUI launches** (`.bashrc` isn't sourced) — the
  concrete user report in #1436.
- **Is invisible friction for non-technical teammates** (the "Susan" persona
  called out in `AGENTS.md`).
- Has no masking, no audit trail, no reserved-keys guardrail.

This PR adds a first-class **Settings → Environment** pane. Credentials go
in once, and every child OpenWork spawns — OpenCode, the OpenWork server,
opencode-router, and any MCP or plugin those three launch — inherits them
via OS process environment.

Boundaries vs. adjacent features:

- Not a replacement for OpenCode's native `provider auth` flow, which owns
  credentials for LLM providers OpenCode directly supports (stored in
  `auth.json`). Users should keep using that for model keys where possible.
- Not a replacement for Den's cloud `LLM Providers` push, which owns
  org-wide distribution for signed-in users. On remote workspaces, the pane
  shows a read-only hint and does not fetch or display local env values.
- This fills the OSS / local-machine path for every other service skills
  and MCPs call into — ElevenLabs, Gemini image APIs, GitHub, Notion,
  LangSmith / OTEL exporters, proxy + CA-cert config, and so on.

## Storage

Deterministic path, identical across every loader:

| OS | Path |
| --- | --- |
| Linux / macOS | `~/.config/openwork/env.json` |
| Windows | `%APPDATA%\openwork\env.json` |

Override via `OPENWORK_ENV_STORE` (mirrors `OPENWORK_TOKEN_STORE`). The file
is written with `0o600` perms on POSIX.

Shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": 1714000000000,
  "variables": [
    { "key": "ANTHROPIC_API_KEY", "value": "sk-ant-...", "updatedAt": 1714000000000 }
  ]
}
```

## Server

`EnvService` at `apps/server/src/env-file.ts` — mirrors the `TokenService`
pattern. Three desktop-host-token routes on the OpenWork server, so remote
owner/collaborator/viewer clients and OpenCode tools are structurally unable to
reach them:

- `GET /env` → `{ items: [{ key, value, updatedAt }] }` (values raw; the UI masks presentationally)
- `PUT /env` → single entry `{ key, value }` or batch `{ entries: [...] }`
- `DELETE /env/:key`

## Shell spawn injection

Same file, four loaders that agree byte-for-byte on path + reserved-keys policy:

| Host | File | Integration point |
| --- | --- | --- |
| Tauri (Rust) | `apps/desktop/src-tauri/src/env_file.rs` | merged into 4 spawn sites alongside `bun_env_overrides()` |
| Electron (Node) | inline in `apps/desktop/electron/runtime.mjs` | single `buildChildEnv()` helper |
| Orchestrator (TS) | inline in `apps/orchestrator/src/cli.ts` | single `buildSpawnEnv()` helper |
| Server injection helper | `EnvService.readForInjection()` | reserved by consumers that want to reuse the TS reader |

Merge order on every host: **user env first, process env / caller env wins.**
This matches the Linux-GUI case (no shell env → user env fills in) and never
lets the user shadow wiring the shell has already set.

Reserved-keys policy: **any key starting with `OPENWORK_` or `OPENCODE_`** is
refused at write time and stripped at read time. Defends against a
hand-edited `env.json` that tries to shadow auth credentials.

## UI

`apps/app/src/react-app/domains/settings/pages/environment-view.tsx` —
self-contained React pane registered as a **global** settings tab (user-level
data, not workspace-scoped). Drops into the existing settings shell with one
line in each of `types.ts`, `settings-page.tsx`, `settings-route.tsx`.

- Table with masked values (`ab••••yz`), reveal/hide toggle per row, add/edit
  modal, delete-with-confirm.
- Client-side key validation mirrors the server (`^[A-Za-z_][A-Za-z0-9_]*$`)
  + reserved-prefix check.
- Remote workspaces show a read-only hint and do not list local env values.

## Reload semantics

Env vars are fixed in a process's environment at spawn time. The existing
"reload required" popup only triggers OpenCode's `/instance/dispose`, which
does not respawn the OpenCode child. So the pane does NOT hook into that
popup. Instead, after a successful write it surfaces:

> "Saved. Quit and relaunch OpenWork for changes to take effect."

via the existing `setConfigActionStatus` channel. Honest and correct.

## i18n

All strings live under the `settings.environment.*` and
`settings.tab_*_environment` namespaces. Full translations in `en.ts`,
`zh.ts`, `ja.ts`. Other locales (`vi`, `pt-BR`, `th`, `fr`, `ca`, `es`) fall
back to English via the existing `t()` runtime (`i18n/index.ts:109-113`), so
nothing ships as raw keys.

## Tests

| Layer | File | What |
| --- | --- | --- |
| Server unit | `apps/server/src/env-file.test.ts` | 12 tests — path resolution, validation, reserved keys, perms, round-trip, tampered-file defense |
| Server HTTP e2e | `apps/server/src/env-routes.e2e.test.ts` | 11 tests — auth 401, owner-bearer rejection, CORS PUT preflight, PUT/GET round-trip, batch PUT, invalid key 400, reserved key 400, DELETE missing/found, restart persistence |
| Tauri Rust unit | `apps/desktop/src-tauri/src/env_file.rs` | 4 tests — missing file, malformed JSON, well-formed load, reserved-key strip |

Bun picks up `*.e2e.test.ts` automatically — no CI wiring change.

## Verification ran

```
pnpm install                                       # ok
pnpm --filter openwork-server test                 # 104 pass, 0 fail
bun test ./src/env-file.test.ts ./src/env-routes.e2e.test.ts # 23 pass, 0 fail
pnpm --filter openwork-server typecheck            # clean
pnpm --filter openwork-server build:bin            # ok (orchestrator-hosted runs)
pnpm --filter openwork-orchestrator typecheck      # clean
pnpm --filter @openwork/app typecheck              # clean
pnpm typecheck                                     # clean (sdk:generate + app)
pnpm test:e2e                                      # ok
pnpm build:ui                                      # ok (production Vite; large chunk warning unchanged)
cargo check                            (src-tauri) # ok
cargo test --lib env_file              (src-tauri) # 4 pass, 0 fail
node --check apps/desktop/electron/runtime.mjs     # ok
git diff --check                                   # clean
```

## Non-goals (follow-ups)

- OS keychain storage (`PRINCIPLES.md` line 29). JSON + `0o600` matches the
  existing `tokens.ts` precedent and keeps the Rust reader trivial (no
  keychain FFI). A follow-up PR can migrate values into the keychain while
  leaving the JSON file as a manifest of key names + timestamps.
- Per-workspace scoping. The issue asks for user-level; workspace overrides
  are a separate feature.
- Cloud push for MCP keys — owned by the Den / LLM Providers team.

# Open Coworker

A standalone desktop app for persistent AI coworkers, powered by the OpenWork
platform. Open Coworker is a second product client, not a second platform: it
assembles existing OpenWork primitives into a coworker-centric experience and
adds no new database concepts.

## What a coworker is

```
~/.config/openwork/coworkers/<slug>/   ← via @openwork/paths openworkConfigDir()
├── AGENTS.md          coworker contract: conduct + memory maintenance duties
├── opencode.json      instructions: soul.md, memory/working.md, memory/index.md
├── coworker.md        app-owned profile, workspace id, model + reasoning preference
├── local-responsibilities.json  local schedule and run state
├── soul.md            stable identity, loaded every turn
├── memory/
│   ├── working.md     active memory the coworker itself edits while working
│   ├── index.md       always-loaded map of long-term memories
│   └── long-term/     durable Markdown memories, read on demand
└── workspace/         the coworker's working area
```

The coworker directory is registered as an ordinary OpenWork workspace, so:

- **Threads are native sessions** in that workspace, created and driven through
  `@openwork/headless-threads` against the embedded server's workspace-scoped
  engine proxy. A thread made here opens in the OpenWork app unchanged.
- **Identity and memory ride the engine's existing instruction loading**
  (`AGENTS.md` + `opencode.json` `instructions`); the coworker maintains
  `memory/working.md` with ordinary file tools. No memory backend.
- **Responsibilities have two explicit placements.** OpenWork Cloud is the
  recommended always-on lane and keeps using native Den Automations, pinned to
  the coworker's workspace and associated in `coworker.md`. This Mac is a
  local-first lane: schedules reuse `@openwork/automations` occurrence rules,
  persist beside the coworker, and create native OpenWork threads through
  `@openwork/headless-threads`. Local responsibilities run while Open Coworker
  is available and recover at most one missed occurrence after relaunch; they
  do not pretend to be always-on Cloud work.
- **Skills and MCP** come for free from the same engine configuration layering
  the OpenWork desktop uses.

## Architecture

- `electron/main.mjs` — standalone shell (own app id/userData; single
  instance). Boots the same `apps/server` embedded bundle the OpenWork desktop
  uses (`startEmbeddedServer`, managed OpenCode engine), against its own
  registry file `~/.config/openwork/coworker-server.json`, so both apps run
  side by side. Open Coworker never requires the OpenWork desktop process.
- `electron/coworkers.mjs` — the filesystem coworker store (pure Node,
  unit-tested).
- `src/` — Vite + React + Tailwind renderer: coworkers rail, coworker home
  (Work / Responsibilities / Memory), account connection, first-run choice,
  and connected-model selection.
- `src/lib/den.ts` — narrow Den client typed by `@openwork/types/automations`
  (sign-in handoff exchange + automations), resolving the API origin with the
  same deterministic rule as the OpenWork desktop (`api.<host>` for hosted
  OpenWork Cloud, `/api/den` proxy path for self-hosted Dens). Promoting the
  desktop's full Den client into a shared package is the designated follow-up
  extraction.

OpenWork Cloud is strongly recommended, but no longer required. First run
offers the same Den desktop sign-in handoff (open OpenWork in the browser,
copy the sign-in link, paste it here) or a local path with no account. Cloud
adds always-on responsibilities and shared organization settings; local use
keeps identity, memory, model preference, schedules, and thread execution on
this Mac.

## Review / develop

```bash
pnpm --filter openwork-server build        # once: the embedded platform bundle
pnpm --filter @openwork/coworker dev       # Vite + Electron (builds server bundle if missing)
pnpm --filter @openwork/coworker test      # store + platform integration tests (node --test)
pnpm --filter @openwork/coworker typecheck
pnpm --filter @openwork/coworker build     # renderer bundle
```

First run: choose OpenWork Cloud or local mode, create a coworker, pick its
model, then give it work. Identity and memory are plain files under
`~/.config/openwork/coworkers/`. A discreet OpenWork control in the bottom-left
rail keeps account and engine settings available without taking space from the
thread. The same panel reads the active engine's connected-provider catalog so
OpenWork model and provider changes stay visible without a second settings store.
Existing or manually copied coworker directories are registered as native
OpenWork workspaces automatically when the app loads them; the manual prepare
action is retained only as recovery when registration fails.

The managed engine binary resolves from `OPENWORK_OPENCODE_BIN` or `opencode`
on PATH during development; packaged sidecar distribution follows the desktop
app's pattern and is not wired yet.

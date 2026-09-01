# Work Bot

A standalone desktop app for persistent AI workers, powered by the OpenWork
platform. Work Bot is a second product client, not a second platform: it
assembles existing OpenWork primitives into a worker-centric experience and
adds no new database concepts.

## What a worker is

```
~/.config/openwork/bots/<slug>/   ← via @openwork/paths openworkConfigDir()
├── AGENTS.md          worker contract: conduct + memory maintenance duties
├── opencode.json      instructions: soul.md, memory/working.md, memory/index.md
├── bot.md             app-owned config: name, mission, workspaceId, automation ids
├── soul.md            stable identity, loaded every turn
├── memory/
│   ├── working.md     active memory the worker itself edits while working
│   ├── index.md       always-loaded map of long-term memories
│   └── long-term/     durable Markdown memories, read on demand
└── workspace/         the worker's working area
```

The bot directory is registered as an ordinary OpenWork workspace, so:

- **Threads are native sessions** in that workspace, created and driven through
  `@openwork/headless-threads` against the embedded server's workspace-scoped
  engine proxy. A thread made here opens in the OpenWork app unchanged.
- **Identity and memory ride the engine's existing instruction loading**
  (`AGENTS.md` + `opencode.json` `instructions`); the worker maintains
  `memory/working.md` with ordinary file tools. No memory backend.
- **Responsibilities are Den Automations** presented worker-first. The
  bot ⇄ automation association lives in `bot.md` (and the automation's existing
  pinned `workspaceId`) — the Automations schema never learns about bots.
  Placement is honest about where files live: cloud-placement responsibilities
  keep running with the app closed but execute in OpenWork Cloud, away from
  the local bot directory. Duties that must touch the bot's own files (for
  example memory consolidation) need desktop placement — Work Bot hosting the
  existing desktop-runner protocol — or a bot home inside a cloud
  workspace. That is the deliberate next slice, not an accident.
- **Skills and MCP** come for free from the same engine configuration layering
  the OpenWork desktop uses.

## Architecture

- `electron/main.mjs` — standalone shell (own app id/userData; single
  instance). Boots the same `apps/server` embedded bundle the OpenWork desktop
  uses (`startEmbeddedServer`, managed OpenCode engine), against its own
  registry file `~/.config/openwork/workbot-server.json`, so both apps run side
  by side. Work Bot never requires the OpenWork desktop process.
- `electron/bots.mjs` — the filesystem bot store (pure Node, unit-tested).
- `src/` — Vite + React + Tailwind renderer: workers rail, worker home
  (Work / Responsibilities / Memory), Den sign-in gate.
- `src/lib/den.ts` — narrow Den client typed by `@openwork/types/automations`
  (sign-in handoff exchange + automations). Promoting the desktop's full Den
  client into a shared package is the designated follow-up extraction.

Work Bot requires the OpenWork Cloud connection as a product rule (workers,
schedules, and runs outlive the desktop session). Sign-in reuses the Den
desktop handoff: open Den in the browser, copy the sign-in link, paste it in.
`WORKBOT_ALLOW_OFFLINE=1` exists for development only.

## Develop

```bash
pnpm --filter @openwork/workbot dev        # builds server bundle if missing, Vite + Electron
pnpm --filter @openwork/workbot test       # bot store unit tests (node --test)
pnpm --filter @openwork/workbot typecheck
pnpm --filter @openwork/workbot build      # renderer bundle
```

The managed engine binary resolves from `OPENWORK_OPENCODE_BIN` or `opencode`
on PATH during development; packaged sidecar distribution follows the desktop
app's pattern and is not wired yet.

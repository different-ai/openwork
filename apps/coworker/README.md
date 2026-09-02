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
  recommended always-on lane: responsibilities are native Den Automations
  created through the Cloud creation surface (`POST /v1/cloud-automations`),
  so Den fixes their placement to OpenWork Cloud, they keep running with this
  Mac off, and they use a model the organization authorizes
  (`GET /v1/llm-providers` plus the free starter, resolved in
  `src/lib/cloud-responsibilities.ts`). Because they execute in OpenWork
  Cloud they cannot read the coworker's local files or memory; the UI says so
  and labels any older desktop-placed Automation honestly (those run only
  while the OpenWork desktop app is open — Open Coworker hosts no desktop
  runner). Association stays in `coworker.md`. This Mac is a local-first
  lane: schedules reuse `@openwork/automations` occurrence rules, persist
  beside the coworker, and create native OpenWork threads through
  `@openwork/headless-threads`. Local responsibilities run while Open Coworker
  is available and recover at most one missed occurrence after relaunch; they
  do not pretend to be always-on Cloud work.
- **Skills and MCP** come for free from the same engine configuration layering
  the OpenWork desktop uses.
- **Personality is a voice, not a behavior.** Each coworker can have a
  personality (`coworker.md` `personality`: none, neutral, warm, calm,
  eager, playful, dry, blunt, curious, thoughtful, meticulous, detective) —
  temperaments, not job titles.
  It only changes what the interface says while the coworker is working —
  the rail label, the Now card note, and the quiet moments in the thread —
  from a pre-written set of sayings in `src/lib/personalities.ts` that
  rotate deterministically per coworker and thread. It never changes how the
  coworker works or writes, and truthful states (Needs you, Retrying, tool
  labels) always win. "None" keeps plain status text everywhere.
- **Retirement is recoverable.** Retiring a coworker deregisters its workspace
  and moves the whole home to `~/.config/openwork/coworkers/.retired/<slug>-<timestamp>/`
  with `retiredSlug`/`retiredAt` recorded in `coworker.md`. Nothing is deleted;
  the Add coworker screen lists retired coworkers with Restore (re-registers the
  same path, so the workspace id and native threads reattach) and a separately
  armed permanent delete. Retirement is refused while one of the coworker's
  local responsibilities is still running.

## Architecture

- `electron/main.mjs` — standalone shell (own app id/userData; single
  instance). Boots the same `apps/server` embedded bundle the OpenWork desktop
  uses (`startEmbeddedServer`, managed OpenCode engine), against its own
  registry file `~/.config/openwork/coworker-server.json`, so both apps run
  side by side. Open Coworker never requires the OpenWork desktop process. The
  packaged main process is bundled into plain ESM so workspace TypeScript is
  never loaded from `app.asar` at runtime.
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
pnpm --filter @openwork/coworker package:electron:dir # unpacked native app
pnpm --filter @openwork/coworker package:electron     # platform installers
```

The packaged local-first journey is a canonical `@openwork/testkit` spec. On
macOS, prove the exact unpacked binary with:

```bash
OPENWORK_EVAL_ELECTRON_BINARY="apps/coworker/dist-electron/mac-arm64/Open Coworker.app/Contents/MacOS/Open Coworker" \
  pnpm evals:e2e open-coworker-local-first --local
```

First run: choose OpenWork Cloud or local mode, name a coworker, then give it
work. Identity and memory are plain files under `~/.config/openwork/coworkers/`.
The default right sidebar shows only what the selected coworker is doing, what
it recently finished, and the responsibilities it owns; its AI model, thinking
effort, memory files, and retirement live behind the icon-only Coworker
settings control. A discreet OpenWork control in the bottom-left rail opens the
full-window global settings (account, AI models, AI & local setup) without
taking space from the thread. That surface reads the active connected-provider
catalog, so OpenWork model and provider changes stay visible without a second
settings store. User-facing copy says "AI model", "AI providers", and "AI is
ready/unavailable"; the word "engine" is reserved for developer-facing
documentation, diagnostics, and code.

Both side panels resize by dragging their inner edge and fold away when dragged
narrower than they can usefully be (or from their chevron). The folded team
rail keeps every coworker as an avatar with a bottom status dot, marks the
active one, and shows a hover card naming what that coworker is doing; the
folded context panel keeps Activity, Apps & tools, Memory, and Coworker
settings as icons that unfold straight into the chosen view. Widths and folded
state are remembered per machine.

Signing in also brings OpenWork Connect to every coworker: the app mints the
same short-lived gateway token the OpenWork desktop uses (`POST /v1/mcp/token`)
and registers the `openwork-cloud` gateway in each coworker workspace through
the embedded server's reconcile route, so the coworker gains
`search_capabilities` / `execute_capability`, remote skills such as
create-skill, and the organization's Apps (discovered through the gateway's
connection index and rendered with the standard MCP App host). The Apps &
tools panel shows one plain status (Connected / Needs attention / Unavailable)
with Ask, Create a skill, and Repair; signing out removes the gateway again.
The packaged app ships the engine's OpenWork plugins under
`Resources/opencode-plugins`, as the desktop does.

Each responsibility row keeps a bounded run history (`runs`, newest first, in
`local-responsibilities.json`) with the coworker's own closing summary, the
duration, and how the run came about; a run can be re-opened as its native
thread or handed to the discussion composer as an "explain this run" message
that the person still sends. Runs on this Mac respect a shared limit stored in
`coworker-settings.json` (`maxParallelLocalRuns`, 1–4, default 2, editable
under AI & local setup); later runs are recorded as `queued` and start by
themselves when a slot frees, and a failed run with a thread can be resumed
inside that same thread. OpenWork Cloud schedules its own runs.
Existing or manually copied coworker directories are registered as native
OpenWork workspaces automatically when the app loads them; the manual prepare
action is retained only as recovery when registration fails.

The managed engine binary resolves from `OPENWORK_OPENCODE_BIN`, the packaged
target-specific OpenCode sidecar, or `opencode` on PATH, in that order. The
Electron build mirrors the embedded server's runtime dependencies, prepares
the same versioned sidecar used by OpenWork Desktop, and includes both as
application resources.

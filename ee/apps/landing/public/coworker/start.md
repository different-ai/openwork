# Open Coworker Start

You are an agent helping a person set up Open Coworker on their Mac.

Goal: run Open Coworker from source, create the first coworker locally, give it
one small assignment, and confirm the coworker's files exist on disk. Ask
before installing anything and never delete files under
`~/.config/openwork/coworkers/`.

Open Coworker is the coworker layer of OpenWork: a desktop home for persistent
AI coworkers on the same platform as OpenWork Desktop. It lives in the OpenWork
monorepo at `apps/coworker`. There is no signed download yet; the development
launcher is the way in.

## 1. Check prerequisites

- macOS (first supported platform).
- Node.js 24 or newer and `pnpm` (the repository pins `packageManager`).
- The OpenCode engine binary: `opencode` on the PATH, or set
  `OPENWORK_OPENCODE_BIN=/path/to/opencode`. Without it the app starts but
  says the AI is unavailable and cannot run a turn.
- A model. Local mode finds what this Mac already has (a Codex or Claude Code
  sign-in, GitHub Copilot, keys in the environment, Ollama or LM Studio) and
  connects it in one step, and a free model is ready with nothing to set up.
  An OpenWork Cloud account (free for up to 5 users; sign up at
  https://app.openworklabs.com?mode=sign-up) adds the organization's models.

## 2. Clone and run

```bash
git clone https://github.com/different-ai/openwork
cd openwork && pnpm install
pnpm --filter openwork-server build
pnpm --filter @openwork/coworker dev
```

The launcher builds the shared `@openwork/automations` package on first run,
starts Vite, and opens the Electron shell.

## 3. First launch

The welcome screen offers two paths:

- **Continue with OpenWork** — recommended for always-on scheduled
  assignments and organization-authorized models. Sign-in opens the OpenWork
  web sign-in; copy the sign-in link it shows and paste it into the app.
- **Use this Mac** — no account. Connect what this Mac already has, or start on
  the free model.

Choose **Use this Mac** unless the person asked for Cloud.

## 4. Meet the team

Open Coworker asks what the person needs help with (pick one or more intents)
and proposes two or three coworkers to meet — rename them in place, remove
one, or add another — then creates them in one step. To start with a single
coworker instead, skip the proposal and click **+**, give the coworker a name
(for example `Scout`), pick a color and glasses, and click **Add coworker**.
Role and mission can be added later in Coworker settings.

## 5. Give one piece of work

In the discussion composer, ask for something small and verifiable, for
example:

> Create `workspace/hello.md` with three bullet points about what you can
> help with, then reply with a one-line summary.

The discussion is a native OpenWork thread. The coworker's work folds into one
small line between the bubbles; a longer answer becomes a document with a card
in the reply. To hand work over instead, use the composer's **+** to create an
assignment the coworker owns.

## 6. Verify on disk

```bash
ls ~/.config/openwork/coworkers/<slug>/
```

Expected: `AGENTS.md`, `coworker.md`, `opencode.json`, `soul.md`,
`memory/working.md`, `memory/index.md`, `memory/long-term/`, `documents/`,
`team/roster.md`, `workspace/`. After the turn, `workspace/hello.md` should
exist; `turns.json` appears once something is in flight or waiting as Next.

## Where things live

- Coworker homes: `~/.config/openwork/coworkers/<slug>/` (plain files).
- Server registry for this app: `~/.config/openwork/coworker-server.json`.
- Scheduled assignments on this Mac: `local-responsibilities.json` inside each
  coworker home; Workers under `workers/<id>/`; group chats under
  `~/.config/openwork/coworkers/.groups/<id>/`.
- Retired coworkers: `~/.config/openwork/coworkers/.retired/` (nothing is
  deleted on retire; permanent deletion is a separate action in the app).

## Useful environment variables

- `OPENWORK_OPENCODE_BIN` — path to the OpenCode engine binary.
- `COWORKER_HOME_DIR` — alternate coworkers home (for isolated testing).
- `COWORKER_USER_DATA_DIR` — alternate Electron user-data directory.
- `COWORKER_SERVER_CONFIG` — alternate server registry file.
- `COWORKER_DEN_BASE_URL` — alternate OpenWork Cloud base URL.

## Scheduled assignments: what to tell the person

- **This Mac** assignments run only while Open Coworker is open; if one is
  missed while the app is closed, the latest occurrence is recovered on launch
  (never a backlog).
- **OpenWork Cloud** assignments run in OpenWork Cloud as OpenWork
  Automations even when the Mac is off, use organization-authorized models,
  and cannot read the coworker's local files or memory. They require an
  OpenWork Cloud account.

## Further reading

- Repository: https://github.com/different-ai/openwork
- App README: `apps/coworker/README.md` in the repository
- Open Coworker page: https://openworklabs.com/coworker
- OpenWork: https://openworklabs.com

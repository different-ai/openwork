# Open Coworker Start

You are an agent helping a person set up Open Coworker on their Mac.

Goal: run Open Coworker from source, create the first coworker locally, give it
one small assignment, and confirm the coworker's files exist on disk. Ask
before installing anything and never delete files under
`~/.config/openwork/coworkers/`.

Open Coworker is a desktop home for persistent AI coworkers built on the
OpenWork platform. It lives in the OpenWork monorepo at `apps/coworker`. There
is no packaged download yet; the development launcher is the way in.

## 1. Check prerequisites

- macOS (first supported platform).
- Node.js 24 or newer and `pnpm` (the repository pins `packageManager`).
- The OpenCode engine binary: `opencode` on the PATH, or set
  `OPENWORK_OPENCODE_BIN=/path/to/opencode`. Without it the app starts but
  shows "Engine offline" and cannot run assignments.
- At least one model provider configured for OpenCode, or an OpenWork Cloud
  account (free for up to 5 users; sign up at
  https://app.openworklabs.com?mode=sign-up).

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

- **Start locally** — no account. Coworkers and local responsibilities run
  through the embedded OpenWork engine while the app is open.
- **Connect OpenWork Cloud** — recommended for always-on responsibilities and
  organization-authorized models. Sign-in opens the OpenWork web sign-in;
  copy the sign-in link it shows and paste it into the app.

Choose **Start locally** unless the person asked for Cloud.

## 4. Create a coworker

Click **+**, give the coworker a name (for example `Scout`), pick a color and
glasses, and click **Add coworker**. Optionally choose a model from providers
connected to the engine, then **Finish setup**. Role and mission are optional
and can be added later in Settings.

## 5. Give one assignment

In the composer, assign something small and verifiable, for example:

> Create `workspace/hello.md` with three bullet points about what you can
> help with, then reply with a one-line summary.

The assignment becomes a native OpenWork thread. Tool steps appear inside the
thread; the reply reads like a receipt.

## 6. Verify on disk

```bash
ls ~/.config/openwork/coworkers/<slug>/
```

Expected: `AGENTS.md`, `coworker.md`, `opencode.json`, `soul.md`,
`memory/working.md`, `memory/index.md`, `memory/long-term/`, `workspace/`.
After the assignment, `workspace/hello.md` should exist and
`memory/working.md` should have changed.

## Where things live

- Coworker homes: `~/.config/openwork/coworkers/<slug>/` (plain files).
- Server registry for this app: `~/.config/openwork/coworker-server.json`.
- Local responsibilities: `local-responsibilities.json` inside each coworker
  home.
- Retired coworkers: `~/.config/openwork/coworkers/.retired/` (nothing is
  deleted on retire; permanent deletion is a separate action in the app).

## Useful environment variables

- `OPENWORK_OPENCODE_BIN` — path to the OpenCode engine binary.
- `COWORKER_HOME_DIR` — alternate coworkers home (for isolated testing).
- `COWORKER_USER_DATA_DIR` — alternate Electron user-data directory.
- `COWORKER_SERVER_CONFIG` — alternate server registry file.
- `COWORKER_DEN_BASE_URL` — alternate OpenWork Cloud base URL.

## Responsibilities: what to tell the person

- **This Mac** responsibilities run only while Open Coworker is open; if one
  is missed while the app is closed, the latest occurrence is recovered on
  launch (never a backlog).
- **OpenWork Cloud** responsibilities run in OpenWork Cloud even when the Mac
  is off, use organization-authorized models, and cannot read the coworker's
  local files or memory. They require an OpenWork Cloud account.

## Further reading

- Repository: https://github.com/different-ai/openwork
- App README: `apps/coworker/README.md` in the repository
- OpenWork: https://openworklabs.com

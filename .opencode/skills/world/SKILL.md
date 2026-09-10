---
name: world
description: Boot, list, reopen, update or stop a local web or Daytona world targeting any PR, branch, tag or commit. Use when the user wants a runnable environment or preview with a usable disposable test login.
---

# World

A **world** defines the environment and services; a **Git ref** defines the
version. A **stage** identifies one instance, not a branch or an update request.
Use existing repository launchers. Run lifecycle commands from the owning
checkout and record its absolute path. Never reset unrelated worlds, use an
installed production profile, or load production secrets for a disposable world.

## Select and pin the version

Honor the requested surface, place and ref. Default an unspecified version to
freshly fetched `origin/dev` and report the resolved SHA. For a PR number, fetch
its head (not the merge ref); for a branch/tag, fetch that exact ref. For example,
run these as separate commands from the source repository:

```sh
git fetch origin refs/pull/<number>/head
git rev-parse --verify 'FETCH_HEAD^{commit}'
```

For a branch use `git fetch origin refs/heads/<branch>`; for a tag use
`git fetch origin refs/tags/<tag>`, then the same `rev-parse`. For a supplied
commit, resolve it with `git rev-parse --verify '<commit>^{commit}'` (fetch it
first if absent). Keep the full 40-character SHA, not a mutable name. Verify
access/review before executing that version's scripts. A missing launcher on an
older ref is a limitation to report, not permission to substitute another SHA.

Local source runs from an isolated worktree at that SHA. Verify the parent
directory exists, choose a new path, then:

```sh
git worktree add --detach <new-world-worktree> <full-sha>
```

Run subsequent commands with that worktree as their working directory. Check
`git rev-parse HEAD` and `git status --short`; a dirty checkout is not an exact
SHA preview. Use Node 24+ and the repository's pnpm version; install dependencies
with `pnpm install --frozen-lockfile` when needed.

## Choose the environment

| Request | Existing entry point | Account behavior |
| --- | --- | --- |
| Local OpenWork browser UI and server | `pnpm world up dev-headless --stage <stage> --place local --detach` | Owner bearer wired into UI; no seeded Den username/password |
| All-in-one local Den development | `pnpm dev:web-local` (alias of `pnpm dev:den`) | No account seeding; use signup or an explicitly prepared disposable account |
| Isolated Den web on Daytona | `preview-den`, `--place daytona` | `team`, `restricted`, `workspace` seed an owner; `fresh` leaves signup |
| Real Linux Electron on Daytona | `preview-desktop`, `--place daytona` | See scenarios and release restrictions in [Daytona reference](daytona.md) |

### Local web

`worlds/dev-headless.ts` launches Vite and `openwork-server` together, with
worktree-local config/session state and health checks. Open the actual `webUrl`
output, not an assumed port. Its private runtime manifest is
`tmp/dev-headless-web.json`. The runtime is single-instance per checkout:
different stages alone do not isolate its fixed `tmp/` state. Use separate
worktrees for simultaneous versions. It has no preview lifetime timer; stop it
explicitly when finished. See [headless documentation](../../../README.md#headless-web-no-electron).

### Existing all-in-one Den launcher

`package.json` maps `dev:web-local` → `dev:den` → `scripts/dev-local.mjs`.
It loads `.env.dev`, starts MySQL/Redis if unavailable, pushes the database
schema, then supervises Den API, inference and Den web through Turbo. It runs
in the foreground; Ctrl-C stops its child processes and removes only the Docker
services it started. This command is not a staged `world` receipt.

Its Docker project is fixed (`openwork-den-local`) and reachable databases are
reused. A new worktree or different web ports does not isolate that data. Before
launching, verify the selected database/Redis are disposable and belong to this
task; do not schema-push into an unrelated running stack. Use the Daytona flow
when an isolated seeded Den world is required and local isolation is unavailable.
Port overrides include `DEN_API_PORT`, `DEN_WEB_PORT` and `INFERENCE_PORT`.
It neither launches the OpenWork browser UI nor creates a user. To pair it with
headless web, set `OPENWORK_DEV_DEN_PROXY_TARGET` to the actual local Den web
origin when launching `dev-headless`. Follow the README's copy/paste sign-in
handoff. Do not confuse a database password or bearer token with a Den login.

### Daytona

Read [daytona.md](daytona.md) for the full existing launch, scenario, update,
release and teardown instructions. Set `OPENWORK_EVAL_REF=<full-pushed-sha>`
on the launch command; Daytona must be able to fetch it. There is no generic
`world --ref` flag. The driver executes from the local checkout; remote source
uses `OPENWORK_EVAL_REF`. Record both identities if they differ. Do not apply
that variable as a supposed version selector for local `dev-headless`.

## Inspect, reopen and verify

Before launching or adopting an instance:

```sh
pnpm world list
pnpm world outputs <world> --stage <stage> --json
```

Compare the owning checkout, world, stage, place, recorded SHA/scenario and any
release version/distribution/digest with the request. Local headless outputs
do not record a source SHA: verify the owning worktree's HEAD and clean state.
Reopen the output URL only on an exact match. `world up` adopts running receipts
before evaluating new arguments, so new flags do not update an existing world.
For a mismatch use a new stage (and a new worktree for local headless), or reset
the exact instance only when the user requested it.

Wait for readiness, then check the returned web URL responds and the intended
screen opens. For seeded Den, verify sign-in with the actual account. Report
any unverified check rather than claiming readiness. Open in the available
embedded browser or provide the URL if none is available. A launch is not test
evidence; use `run-tests` when asked to verify behavior.

## Private login handoff

For seeded Daytona scenarios, the owner-only receipt contains `outputs.email`
and `outputs.password` as strings, with secrecy recorded in `outputMeta`. Its
default location is `evals/results/.worlds/scripts/<world>--<stage>.json` in the
launch checkout; `OPENWORK_WORLD_SNAPSHOT_DIR` can override the directory.
Use the actual receipt path printed at launch. Default `world outputs` masks
secret values; read only the needed fields privately, not a wholesale
`outputs --reveal` dump. Never invent credentials or reuse a production account.

In the **private user conversation**, hand over directly usable disposable
credentials: login URL, **Username/email: actual seeded email**,
**Password: actual seeded password**, plus scenario, pinned SHA and expiry.
Do this even if the browser is already signed in so the user can reopen it.
Do not leave placeholders or merely say “credentials are in the receipt”.
Only share credentials verified to belong to this disposable world. Public
PRs, issues, logs, screenshots and committed fixtures must omit credential
values; when the destination is public, give the private receipt location and
request a private handoff instead. Never include host/API/provider tokens.

For `fresh`/`blank`, say “no seeded account; start at signup.” For headless-only,
say “local bearer-authenticated UI; no Den account seeded.” If a local disposable
account was actually created, use its verified creation record; the all-in-one
launcher has no generated credential receipt. A missing password is a blocker
to credential handoff, not a reason to fabricate one or reset unrelated users.

## Lifecycle and final handoff

```sh
pnpm world attach <world> --stage <stage>
pnpm world down <world> --stage <stage>
```

Use `attach` for live progress/logs. For local version changes, create another
exact-SHA worktree and launch there. For Daytona frontend-only updates use the
existing helper in [daytona.md](daytona.md); API/schema/main-process changes
need a fresh instance. A reset deletes that preview's data; require the user's
reset intent and target only its exact world/stage. Do not use broad cleanup or
purge commands. Report URL, world/stage, worktree, SHA, scenario, readiness,
expiry (or “until stopped”), exact stop command and the private login handoff.

# Composing script worlds

A script world is a disposable, reproducible environment driven by `pnpm world`.
The building blocks are `server()` (Den), `app()` (Electron), `appWeb()`,
seeding helpers, and `hold()` (lifetime and outputs). Use `AsyncDisposableStack`
to own resources so stopping the world tears them down in reverse order.

## What lives here

`worlds/` holds only the recipes people start by hand for everyday preview,
dev, or demo work. Names follow `<lifecycle>-<surface>`:

- `preview-` is disposable: built from a pushed commit (or this checkout
  locally), isolated, available on remote placements, and deleted when it expires.
- `dev-` runs this working tree locally and keeps its state between runs.
- `live-` runs source against your installed production state and needs an
  explicit `--allow-shared-state`.

| World | What you get |
|---|---|
| `preview-desktop` | The desktop app alone: no Den, organization, or account. Local, Daytona, Daytona Windows (published releases), Freestyle. |
| `preview-den` | Den alone (web, API, database): no desktop. |
| `preview-full` | Den plus a desktop wired to it, seeded with `fresh`, `team`, `restricted`, or `workspace`. |
| `preview-app-web` | The web app plus the server it needs (local, private Daytona URL, Freestyle). |
| `acme-web` | The seeded Acme demo stack: Den, AI Gateway, and the web app. |
| `preview-workbot` | Workbot with Den sign-in and the headless runner: the seeded Acme org, Workbot turned on. `-- --calendar` adds the owner's seeded Automations, the calendar mock and a desktop on the Calendar. |
| `dev-app-web` | Your working tree as the local server plus web app (`pnpm dev:headless-web`). |
| `live-desktop`, `live-app-web` | Source desktop or web app on your installed production state. |

A world that exists for one test, doc, or example lives next to it and runs by
path, for example `pnpm world up ./evals/worlds/infra/remote-session.ts`. If
nothing uses a world any more, delete it. Old names fail with a pointer to their
replacement (`RENAMED_WORLDS` in `packages/world/src/loader.ts`).

```sh
pnpm world help preview-desktop --json
pnpm world list --json
pnpm world plan preview-desktop --place daytona --stage example
pnpm world up preview-desktop --place daytona --stage example \
  --source desktop=release:0.18.52/enterprise --seed blank --detach
pnpm world outputs preview-desktop --stage example --json
pnpm world down preview-desktop --stage example
```

`world help <name> --json` is the discovery contract for agents: each target's
seeds and sources, what an omitted `--source` means, the login or key each
placement needs with its fix, and example commands by intent. For the maintained
previews this comes from `packages/world/src/catalog.ts`, which `world up` also
uses to compose `--source`/`--seed`; tests keep it in step with the scripts and
parse every example. Requirements are preflight checks marked `blocking` (a
Daytona identity the CLI accepts, `FREESTYLE_API_KEY`): `world plan --place <place>` reports
them without creating anything, and `world up` refuses to start while one is
unmet. Health badges such as docker or mysql only warn.

What `plan` and `up` print besides the checks:

- **Identity.** The Daytona check passes with who the world will run as, e.g.
  `using the API key in this command's environment (DAYTONA_API_KEY)` or
  `using your Daytona browser login, organization "..."`. It warns (⚠, never
  blocks) on a personal organization, and on a `DAYTONA_API_KEY` that the CLI
  ignores because `DAYTONA_API_URL` is unset. It reads only non-secret fields of
  the CLI profile (`DAYTONA_CONFIG_DIR`, else the OS config directory).
- **Source.** `source  <short sha> (origin/dev) <subject>` names the commit a
  remote world builds (`plan` resolves `origin/dev` with `git ls-remote`).
- **Drift note.** The driver and recipes run from this checkout, not from that
  commit. When this checkout's world recipes differ from it, a `note` line says
  so and prints a worktree command for running from that commit instead.
- **Failure diagnoses.** A failed `up` appends `hint:` lines for recognised
  provider failures (Daytona organization memory limit, rejected credentials,
  CLI/API version mismatch), each with its fix
  (`diagnoseWorldFailure` in `evals/packages/env/src/world-requirements.ts`).

`--place` selects who runs it (`local`, `daytona`, or `freestyle`); `--os`
selects the guest OS. `preview-desktop --place freestyle` runs the signed-out
`fresh` Linux desktop snapshot from a pushed commit (`--source desktop=ref:dev`
by default); other scenarios and releases are refused before a VM is created.
Local uses this computer's OS, Freestyle offers Linux, and Daytona offers Linux
or Windows. Daytona Windows supports only `preview-desktop` with
`--source desktop=release:<x.y.z>/<distribution> --seed blank`. Only the listed
`supportedTargets` are advertised; a custom script without a declaration can
run locally but fails closed remotely.

`--source` and `--seed` are **opt-in**. `preview-desktop` accepts a `desktop`
source (a pushed SHA or ref, a published release, or `local`) and the `fresh`
or `blank` seed. `preview-den` accepts a `den` source, and `preview-full` a `den`
source; both take one of the `fresh`, `team`, `restricted`, or `workspace`
seeds. `preview-app-web` and `acme-web` accept one default SHA/ref source on
Daytona or Freestyle, mapped to the existing `--ref` input or the Daytona Den
ref. Other worlds reject these flags rather than silently ignoring them. Source
refs resolve to immutable Git SHAs before adopting a running stage. Published
releases need an exact version and `public`, `cloud`, or `enterprise`
distribution. The CLI fingerprints the resolved source and seed with the rest
of the invocation. Daytona scripts that use `resolvePlace()` also pin an omitted
source to the current `origin/dev` commit before adoption rather than silently
reusing an older branch tip.

## App settings

`--env KEY` selects a nonsecret value from your shell. The CLI rejects
credential-like names, and the value is part of the reuse check. Desktop
previews on local and Daytona also pass the selected keys to the app, so one
flag turns on an app setting on either placement:

```sh
OPENWORK_ENGINE_V2_PREVIEW=1 pnpm world up preview-desktop --place daytona \
  --env OPENWORK_ENGINE_V2_PREVIEW --stage v2-check --detach
```

The selected keys appear in the `appEnv` output. Freestyle refuses `--env` for
desktops: its snapshot starts the app while the snapshot is built, so a
launch-time setting could not reach it.

Eval and world desktops start with `OPENWORK_AUTOMATION_RUNNER=off`, so they
never claim Automation runs or remote-session commands, even when signed in to
a real account (`live-desktop` always is). `--env` cannot turn it back on; a
spec or world opts in in code with `env: { OPENWORK_AUTOMATION_RUNNER: "on" }`,
as `preview-full` does for its own disposable Den.

## Writing a world

In a script, declare a one-line summary and the supported targets as literals
so discovery can read them **without importing or running** your script:

```ts
export const summary = "Den plus a seeded demo organization for connector testing.";
export const supportedTargets = ["local/host", "daytona/linux"];
```

Use a double-quoted string for `summary`; `world help` and `world list --json`
show it next to the world's name.

Do not advertise a target until its provisioning and teardown actually work.
For a new composition, export a `boot(stack, place)` function for reuse in tests
and other scripts, then have `main()` resolve the place and call `hold()`.
Do not use raw infrastructure IDs, customer data, or production credentials
in world definitions or seed fixtures.

Note: most of `evals/worlds/` contains test fixtures with a different lifecycle
(`spec.world(...)`); those are not script worlds. The `*.world.ts` files and
`evals/worlds/infra/` there are script worlds run by path.

## Current boundaries

- Review-app PR launches still use the Freestyle snapshot/VM API directly;
  `world up preview-app-web --place freestyle` uses the same provider path, but
  the review service does not call the local world CLI. Freestyle snapshot
  kinds keep their build names (`app-web`, `acme-web`, `desktop`, `workbot`).
- Daytona Windows published desktop previews use an owned, private VM, verify
  the installer digest, launch in the interactive user session, and check the
  private viewer and CDP. They do not run source builds or seed Den identity.
  Use `--lifetime 0-1410` after `--` (0 means until stopped); the VM has an
  additional 30-minute startup allowance and a provider-side TTL so a crashed
  driver cannot leave an unbounded VM.
- Script worlds can compose the named preview scenario seeds; arbitrary seed
  functions, provider-side expiry after driver crashes, and fully independent
  desktop/Den source checkouts are not implemented.

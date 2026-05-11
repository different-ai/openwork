# OpenWork Architecture

## Design principle: Predictable > Clever

OpenWork optimizes for **predictability** over "clever" auto-detection. Users should be able to form a correct mental model of what will happen.

Guidelines:

- Prefer **explicit configuration** (a single setting or env var) over heuristics.
- Auto-detection is acceptable as a convenience, but must be:
  - explainable (we can tell the user what we tried)
  - overrideable (one obvious escape hatch)
  - safe (no surprising side effects)
- When a prerequisite is missing, surface the **exact failing check** and a concrete next step.

### Example: Docker-backed sandboxes (desktop)

When enabling Docker-backed sandbox mode, prefer an explicit, single-path override for the Docker client binary:

- `OPENWORK_DOCKER_BIN` (absolute path to `docker`)

This keeps behavior predictable across environments where GUI apps do not inherit shell PATH (common on macOS).

Auto-detection can exist as a convenience, but should be tiered and explainable:

1. Honor `OPENWORK_DOCKER_BIN` if set.
2. Try the process PATH.
3. On macOS, try the login PATH from `/usr/libexec/path_helper`.
4. Last-resort: try well-known locations (Homebrew, Docker Desktop bundle) and validate the binary exists.

The readiness check should be a clear, single command (e.g. `docker info`) and the UI should show the exact error output when it fails.

## Minimal use of Tauri
We move most of the functionality to the openwork server which interfaces mostly with FS and proxies to opencode.



## Filesystem mutation policy

OpenWork should route filesystem mutations through the OpenWork server whenever possible.

Why:

- the server is the one place that can apply the same behavior for both local and remote workspaces
- server-routed writes keep permission checks, approvals, audit trails, and reload events consistent
- Tauri-only filesystem mutations only work in desktop host mode and break parity with remote execution

Guidelines:

- Any UI feature that changes workspace files or config should call an OpenWork server endpoint first.
- Local Tauri filesystem commands are a host-mode fallback, not the primary product surface.
- If a feature cannot yet write through the OpenWork server, treat that as an architecture gap and close it before depending on direct local writes.
- Reads can fall back locally when necessary, but writes should be designed around the OpenWork server path.

## Agent authority map

When OpenWork is edited from `openwork-enterprise`, architecture and runtime behavior should be sourced from this document.

| Entry point | Role | Architecture authority |
| --- | --- | --- |
| `openwork-enterprise/AGENTS.md` | OpenWork Factory multi-repo orchestration | Defers OpenWork runtime flow, server-vs-shell ownership, and filesystem mutation behavior to `_repos/openwork/ARCHITECTURE.md`. |
| `openwork-enterprise/.opencode/agents/openwork-surgeon.md` | Surgical fix agent for `_repos/openwork` | Uses `_repos/openwork/ARCHITECTURE.md` as the runtime and architecture source of truth before changing product behavior. |
| `_repos/openwork/AGENTS.md` | Product vocabulary, audience, and repo-local development guidance | Refers to `ARCHITECTURE.md` for runtime flow, server ownership, and architectural boundaries. |
| Skills / commands / agents that mutate workspace state | Capability layer on top of the product runtime | Should assume the OpenWork server path is canonical for workspace creation, config writes, `.opencode/` mutation, and reload signaling. |

### Agent access to server-owned behavior

Agents, skills, and commands should model the following as OpenWork server behavior first:

- workspace creation and initialization
- writes to `.opencode/`, `opencode.json`, and `opencode.jsonc`
- OpenWork workspace config writes (`.opencode/openwork.json`)
- share-bundle publish/fetch flows for supported OpenWork capability bundles such as skills
- reload event generation after config or capability changes
- other filesystem-backed capability changes that must work across desktop host mode and remote clients

Tauri or other native shell behavior remains the fallback or shell boundary for:

- file and folder picking
- reveal/open-in-OS affordances
- updater and window management
- host-side process supervision and native runtime bootstrapping

If an agent needs one of the server-owned behaviors above and only a Tauri path exists, treat that as an architecture gap to close rather than a parallel capability surface to preserve.

## Release channels

OpenWork desktop ships through two release channels:

- **Stable** (default, all platforms): versioned builds produced by the `Release App` workflow. Each tag `vX.Y.Z` publishes signed, notarized Tauri bundles plus a `latest.json` updater manifest at `https://github.com/different-ai/openwork/releases/latest/download/latest.json`; when Electron publishing is enabled, the same release also carries signed, notarized Electron macOS assets plus `latest-mac.yml` at `https://github.com/different-ai/openwork/releases/latest/download/latest-mac.yml`.
- **Alpha** (macOS arm64 only, rolling): every merge to `dev` publishes signed, notarized Tauri and Electron builds to the rolling GitHub release tagged `alpha-macos-latest`. The Tauri alpha updater manifest lives at `https://github.com/different-ai/openwork/releases/download/alpha-macos-latest/latest.json`; Electron alpha assets include `latest-mac.yml` at `https://github.com/different-ai/openwork/releases/download/alpha-macos-latest/latest-mac.yml` on the same release.

Guidelines:

- The Tauri alpha channel is an opt-in preference (`LocalPreferences.releaseChannel`). The normal Updates toggle is rendered only when `isTauriRuntime()` and `isMacPlatform()` both resolve true; other platforms silently fall back to stable even if the stored preference says `"alpha"`.
- The Electron alpha channel is Debug-only during the migration window. Migrated Electron users can switch feeds from Settings → Debug → Electron alpha channel; the normal Updates page stays on the selected Electron feed and defaults to stable.
- Alpha builds advertise the next patch version plus an `-alpha.<runNumber>+<sha>` prerelease suffix. That keeps semver ordering `stable < alpha.1 < alpha.2 < next stable` so alpha users migrate forward cleanly when the next stable ships.
- Alpha and stable share the same Tauri updater signing keypair so an installed stable can upgrade into alpha and vice versa without re-installing manually.
- Apple signing and notarization are required on both channels; `alpha-macos-aarch64.yml` fails closed unless `MACOS_NOTARIZE=true`, and the `Release App` Electron job reuses the same Tauri Apple signing/notary secrets.
- The alpha workflow is the source of truth for the alpha channel's CI contract. Treat `.github/workflows/alpha-macos-aarch64.yml`, `apps/app/src/app/lib/release-channels.ts`, and this document as one coupled unit.

Code references:

- Workflow: `.github/workflows/alpha-macos-aarch64.yml`
- Endpoint resolution: `apps/app/src/app/lib/release-channels.ts`
- Electron alpha resolver: `apps/app/src/app/lib/electron-alpha.ts`
- Preference plumbing: `apps/app/src/react-app/kernel/local-provider.tsx`, `apps/app/src/react-app/domains/settings/pages/updates-view.tsx`, `apps/app/src/react-app/domains/settings/pages/debug-view.tsx`
- Stable workflow (reference): `.github/workflows/release-macos-aarch64.yml`

## Reload-required flow

OpenWork uses a single reload-required flow for changes that only take effect when OpenCode restarts.

Key pieces:

- `createSystemState()` owns the raw queued-reload state.
- `reloadPending()` means a reload is currently queued for the active workspace.
- `markReloadRequired(reason, trigger)` queues the reload and records the source that caused it.
- `app.tsx` exposes `reloadRequired(...sources)` as a small helper for UI filtering. It is used to decide whether the shared reload popup should show for a given trigger type.

Use this flow when a change mutates startup-loaded OpenCode inputs, for example:

- `opencode.json`
- `.opencode/skills/**`
- `.opencode/agents/**`
- `.opencode/commands/**`
- MCP definitions or plugin lists that OpenCode only loads at startup

Do not invent a separate reload banner per feature. New UI that needs restart semantics should:

1. perform the config or filesystem mutation
2. call `markReloadRequired(...)`
3. rely on the shared reload popup to explain and execute the restart path

Current examples that should use this shared flow include MCP changes, auto context compaction, default model changes, authorized folder updates, plugin changes, and other `opencode.json` writes.

When the desktop shell asks the OpenWork server to manage OpenCode, the managed
OpenCode process starts from a shell-owned local workdir under app data instead
of the user's selected workspace. Workspace-specific file access still flows
through the OpenWork server and `x-opencode-directory`, but startup no longer
depends on opening a project `opencode.json` from slow cloud-synced folders such
as iCloud Drive.

## opencode primitives
how to pick the right extension abstraction for 
@opencode

opencode has a lot of extensibility options:
mcp / plugins / skills / bash / agents / commands

- mcp
use when you need authenticated third-party flows (oauth) and want to expose that safely to end users
good fit when "auth + capability surface" is the product boundary
downside: you're limited to whatever surface area the server exposes

- bash / raw cli
use only for the most advanced users or internal power workflows
highest risk, easiest to get out of hand (context creep + permission creep + footguns)
great for power users and prototyping, terrifying as a default for non-tech users

- plugins
use when you need real tools in code and want to scope permissions around them
good middle ground: safer than raw cli, more flexible than mcp, reusable and testable
basically "guardrails + capability packaging"

- skills
use when you want reliable plain-english patterns that shape behavior
best for repeatability and making workflows legible
pro tip: pair skills with plugins or cli (i literally embed skills inside plugins right now and expose commands like get_skills / retrieve)

- agents
use when you need to create tasks that are executed by different models than the main one and might have some extra context to find skills or interact with mcps.

- commands 
`/` commands that trigger tools

These are all opencode primitives you can read the docs to find out exactly how to set them up.

## Core Concepts of OpenWork

- uses all these primitives
- uses native OpenCode commands for reusable flows (markdown files in `.opencode/commands`)
- adds a new abstraction "workspace" is a project folder and a simple .json file that includes a list of opencode primitives that map perfectly to an opencode workdir (not fully implemented)
  - openwork can open a workpace.json and decide where to populate a folder with thse settings (not implemented today

## Repository/component map

- `/apps/app/`: OpenWork app UI (desktop/mobile/web client experience layer).
- `/apps/desktop/`: Tauri desktop shell that hosts the app UI and manages native process lifecycles.
- `/apps/server/`: OpenWork server (API/control layer consumed by the app).
- `/apps/orchestrator/`: OpenWork orchestrator CLI/daemon. In `start`/`serve` host mode it manages OpenWork server + OpenCode; in daemon mode it manages worker/sandbox lifecycle.
- `/apps/share/`: share-link publisher service for OpenWork bundle imports.
- `/ee/apps/landing/`: OpenWork landing page surfaces.
- `/ee/apps/den-web/`: Den web UI for sign-in, worker creation, and future user-management flows.
- `/ee/apps/den-api/`: Den control plane API (formerly `/ee/apps/den-controller/`) that provisions/spins up worker runtimes.
- `/ee/apps/den-worker-proxy/`: proxy layer that keeps Daytona API keys server-side, refreshes signed worker preview URLs, and forwards worker traffic so users do not manage provider keys directly.
- `/ee/apps/den-worker-runtime/`: worker runtime packaging (including Docker/runtime artifacts) deployed to Daytona sandboxes.

## Core Architecture

OpenWork is a client experience that consumes OpenWork server surfaces.

### Provider-neutral app control surface

OpenWork app control mode is owned by the UI runtime. The app exposes a
provider-neutral action registry through `window.__openworkControl` so external
controllers can inspect the current route, discover visible/safe actions, and
request an action by ID without depending on DOM scraping or a specific model
provider.

Guidelines:

- The app owns visible, screen-local state: which actions are available, which
  element should be spotlighted, and how actions are choreographed so users can
  see control happen.
- Controllers such as MCP bridges, test harnesses, or optional external drivers should
  call the app control surface instead of reaching into app internals.
- Provider/API secrets and privileged filesystem or server mutations remain
  server-owned; the app control surface should route those through OpenWork
  server APIs rather than adding provider-specific behavior to the UI.
- Raw screenshot or coordinate-based control is a fallback for uninstrumented
  surfaces, not the default architecture.

### MCP UI Control profile

OpenWork should standardize external app control through MCP where possible. The
app-local `window.__openworkControl` registry remains the source of current UI
affordances, but public integrations should expose those affordances as MCP
tools that follow `docs/mcp-ui-control-profile.md`:

- `ui.snapshot` for current semantic app state
- `ui.list_actions` for currently available action metadata and input schemas
- `ui.execute_action` for running one semantic action by ID

Standalone control clients such as HandsFree should be MCP clients first: they
can connect to any configured MCP server and call generic MCP tools. OpenWork's
local UI bridge is an implementation detail behind the OpenWork MCP surface.

OpenWork supports two product runtime modes for users:

- desktop
- web/cloud (also usable from mobile clients)

OpenWork therefore has two runtime connection modes:

### Mode A - Desktop

- OpenWork runs on a desktop/laptop and can host OpenWork server surfaces locally.
- The OpenCode server runs on loopback (default `127.0.0.1:4096`).
- The OpenWork server also defaults to loopback-only access. Remote sharing is an explicit opt-in that rebinds the OpenWork server to `0.0.0.0` while keeping OpenCode on loopback.
- OpenWork UI connects via the official SDK and listens to events.
- OpenWork server is the local API/control layer for this mode and owns the managed OpenCode child lifecycle.

### Mode B - Web/Cloud (can be mobile)

- User signs in to hosted OpenWork web/app surfaces (including mobile browser/client access).
- User launches a cloud worker from hosted control plane.
- OpenWork returns remote connect credentials (`/w/ws_*` URL + access token).
- User connects from OpenWork app using `Add a worker` -> `Connect remote`.

This model keeps the user experience consistent across self-hosted and hosted paths while preserving OpenCode parity.

### Mode A composition (Tauri shell + local services)

- `/apps/app/` runs as the product UI; on desktop it is hosted inside `/apps/desktop/` (Tauri webview).
- `/apps/desktop/` exposes native commands (`engine_*`, `orchestrator_*`, `openwork_server_*`) to start/stop local services and report status to the UI.
- `/apps/desktop/` is also the source of truth for desktop bootstrap config that must survive updates, including Den server targeting and forced-sign-in startup behavior. The shell reads a predictable external `desktop-bootstrap.json` from the host config directory (or `OPENWORK_DESKTOP_BOOTSTRAP_PATH` when explicitly overridden). Default production builds require Den sign-in when no external bootstrap file exists; dev launches stay opt-in. Default builds consume that file when present; custom builds seed or overwrite it when their bundled bootstrap differs from the standard default.
- Desktop host runtime is server-managed: the shell starts OpenWork server with managed OpenCode enabled, and the UI consumes OpenWork server APIs.
- OpenWork server (`/apps/server/`) is the API surface consumed by the UI; it proxies OpenCode routes for the active workspace.
- Desktop-launched OpenCode credentials are always random, per-launch values generated by OpenWork. OpenCode stays on loopback and is intended to be reached through OpenWork server rather than exposed directly.

```text
/apps/app UI
    |
    v
/apps/desktop (Tauri shell)
    |
    +--> /apps/server (OpenWork API + proxy surface)
               |
               +--> OpenCode
```

### Mode B composition (Web/Cloud services)

- `/ee/apps/den-web/` is the hosted web control surface (sign-in, worker create, upcoming user management).
- `/ee/apps/den-api/` (formerly `/ee/apps/den-controller/`) is the cloud control plane API (auth/session + worker CRUD + provisioning orchestration).
- Desktop org runtime config is fetched from Den after sign-in and is treated as server-owned runtime policy. It is stored per organization in Den (`organization.desktop_app_restrictions`) as sparse negative restriction flags (for example `blockZenModel`) and managed from the cloud org settings UI, while install/bootstrap config remains shell-owned in the external bootstrap file and only contains base URL, optional API base URL, and the `forceSignin` startup flag.
- Daytona-backed workers mount a single shared provider volume and isolate each worker's persistent data by subpaths (`workers/<workerId>/workspace` and `workers/<workerId>/data`) rather than creating dedicated provider volumes per worker.
- `/ee/apps/den-worker-runtime/` defines the runtime packaging and boot path used inside cloud workers (including Docker/snapshot artifacts and `openwork serve` startup assumptions).
- `/ee/apps/den-worker-proxy/` fronts Daytona worker preview URLs, refreshes signed links with provider credentials, and proxies traffic to the worker runtime.
- The OpenWork app (desktop or mobile client) connects to worker OpenWork server surfaces via URL + token (`/w/ws_*` when available).

```text
/ee/apps/den-web
    |
    v
/ee/apps/den-api (formerly /ee/apps/den-controller)
    |
    +--> Daytona/Render provisioning
    |        |
    |        v
    |      /ee/apps/den-worker-runtime -> openwork serve + OpenCode
    |
    +--> /ee/apps/den-worker-proxy (signed preview + proxy)

OpenWork app/mobile client
    -> Connect remote (URL + token)
    -> worker OpenWork server surface
```

## Messaging Bridge

OpenWork no longer starts or proxies an app-owned local messaging bridge in the desktop host runtime. Messaging surfaces must be provided by an external server/worker surface rather than Tauri, Electron, or OpenWork server launching a local `opencode-router` child.

Terminology clarification:

- `selected workspace` is a UI concept: the workspace the user is currently viewing and where compose/config actions should target.
- `runtime active workspace` is a backend concept: the workspace the local server/orchestrator currently reports as active.
- `watched workspace` is the desktop-host/runtime concept for which workspace root local file watching is currently attached to.
- These states must be treated separately. UI selection can change without implying that the backend has switched roots yet.
- In practice, `selected workspace` and `runtime active workspace` often converge once the user sends work, but they are allowed to diverge briefly while the UI is browsing another workspace.

Desktop local OpenWork server ports:

- Desktop-hosted local OpenWork server instances do not assume a fixed `8787` port.
- Each workspace gets a persistent preferred localhost port in the `48000-51000` range.
- On restart, desktop tries to reuse that workspace's saved port first.
- If that port is unavailable, desktop picks another free port in the same range and avoids ports already reserved by other known workspaces.

```text
Shared-root case

router root: /Users/me/projects

  /Users/me/projects/a   OK
  /Users/me/projects/b   OK
  /Users/me/projects/c   OK

Unrelated-root case

router root: /Users/me/projects/a

  /Users/me/projects/a   OK
  /Users/me/other/b      rejected
  /tmp/c                 rejected
```

This is intentional for now: predictable scoping beats clever cross-root auto-routing.

## Cloud Worker Connect Flow (Canonical)

1. Authenticate in OpenWork Cloud control surface.
2. Create or select a Den organization without billing gates.
3. Launch a shared cloud workspace/worker (with checkout/paywall when the hosted shared-workspace gate is enabled).
4. Wait for provisioning and health.
5. Generate/retrieve connect credentials.
6. Connect in OpenWork app via deep link or manual URL + token.

Technical note:

- Default connect URL should be workspace-scoped (`/w/ws_*`) when available.
- Technical diagnostics (host URL, worker ID, raw logs) should be progressive disclosure, not default UI.

## Web Parity + Filesystem Actions

The browser runtime cannot read or write arbitrary local files. Any feature that:

- reads skills/commands/plugins from `.opencode/`
- edits `SKILL.md` / command templates / `opencode.json`
- opens folders / reveals paths

must be routed through a host-side service.

In OpenWork, the long-term direction is:

- Use the OpenWork server (`/apps/server/`) as the single API surface for filesystem-backed operations.
- Treat Tauri-only file operations as an implementation detail / convenience fallback, not a separate feature set.

This ensures the same UI flows work on desktop, mobile, and web clients, with approvals and auditing handled centrally.

## OpenCode Integration (Exact SDK + APIs)

OpenWork uses the official JavaScript/TypeScript SDK:

- Package: `@opencode-ai/sdk/v2` (UI should import `@opencode-ai/sdk/v2/client` to avoid Node-only server code)
- Purpose: type-safe client generated from OpenAPI spec

### Engine Lifecycle

#### Start server + client (Host mode)

Use `createOpencode()` to launch the OpenCode server and create a client.

```ts
import { createOpencode } from "@opencode-ai/sdk/v2";

const opencode = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  timeout: 5000,
  config: {
    model: "anthropic/claude-3-5-sonnet-20241022",
  },
});

const { client } = opencode;
// opencode.server.url is available
```

#### Connect to an existing server (Client mode)

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
  directory: "/path/to/project",
});
```

### Health + Version

- `client.global.health()`
  - Used for startup checks, compatibility warnings, and diagnostics.

### Event Streaming (Real-time UI)

OpenWork must be real-time. It subscribes to SSE events:

- `client.event.subscribe()`

The UI uses these events to drive:

- streaming assistant responses
- step-level tool execution timeline
- permission prompts
- session lifecycle changes

### Sessions (Primary Primitive)

OpenWork maps a "Task Run" to an OpenCode **Session**.

Core methods:

- `client.session.create()`
- `client.session.list()`
- `client.session.get()`
- `client.session.messages()`
- `client.session.prompt()`
- `client.session.abort()`
- `client.session.summarize()`

### Files + Search

OpenWork's file browser and "what changed" UI are powered by:

- `client.find.text()`
- `client.find.files()`
- `client.find.symbols()`
- `client.file.read()`
- `client.file.status()`

### Permissions

OpenWork must surface permission requests clearly and respond explicitly.

- Permission response API:
  - `client.permission.reply({ requestID, reply })` (where `reply` is `once` | `always` | `reject`)

OpenWork UI should:

1. Show what is being requested (scope + reason).
2. Provide choices (allow once / allow for session / deny).
3. Post the response to the server.
4. Record the decision in the run's audit log.

### Config + Providers

OpenWork's settings pages use:

- `client.config.get()`
- `client.config.providers()`
- `client.auth.set()` (optional flow to store keys)

### Extensibility - Skills + Plugins

OpenWork exposes two extension surfaces:

1. **Skills**
   - Installed into `.opencode/skills/*`.
   - Skills can be imported from local directories or installed from curated lists.

2. **Plugins (OpenCode)**
   - Plugins are configured via `opencode.json` in the workspace.
   - The format is the same as OpenCode CLI uses today.
   - OpenWork should show plugin status and instructions; a native plugin manager is planned.

### Engine reload (config refresh)

- OpenWork server exposes `POST /workspace/:id/engine/reload`.
- It calls OpenCode `POST /instance/dispose` with the workspace directory to force a config re-read.
- Use after skills/plugins/MCP/config edits; reloads can interrupt active sessions.
- Reload requests follow OpenWork server approval rules.

### Skill Registry (Current + Future)

- Today, OpenWork only supports **curated lists + manual sources**.
- Future goals:
  - in-app registry search
  - curated list sync (e.g. Awesome Claude Skills)
  - frictionless publishing without signup

## Projects + Path

- `client.project.list()` / `client.project.current()`
- `client.path.get()`

OpenWork conceptually treats "workspace" as the current project/path.

## Optional TUI Control (Advanced)

The SDK exposes `client.tui.*` methods. OpenWork can optionally provide a "Developer Mode" screen to:

- append/submit prompt
- open help/sessions/themes/models
- show toast

This is optional and not required for non-technical MVP.

## Folder Authorization Model

OpenWork enforces folder access through **two layers**:

1. **OpenWork UI authorization**
   - user explicitly selects allowed folders via native picker
   - OpenWork remembers allowed roots per profile

2. **OpenCode server permissions**
   - OpenCode requests permissions as needed
   - OpenWork intercepts requests via events and displays them

Rules:

- Default deny for anything outside allowed roots.
- "Allow once" never expands persistent scope.
- "Allow for session" applies only to the session ID.
- "Always allow" (if offered) must be explicit and reversible.

## Open Questions

- Best packaging strategy for Host mode engine (bundled vs user-installed Node/runtime).
- Best remote transport for mobile client (LAN only vs optional tunnel).

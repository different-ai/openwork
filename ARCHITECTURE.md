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

## Core Architecture

OpenWork is a client experience that consumes OpenWork server surfaces.

Historically, users reached OpenWork server capabilities in two ways:

- a running desktop OpenWork app acting as host
- a running `openwork-orchestrator` (CLI host)

Now there is a third, first-class path: hosted OpenWork Cloud workers.

OpenWork therefore has three runtime connection modes:

### Mode A - Host (Desktop/Server)

- OpenWork runs on a desktop/laptop and **starts** OpenCode locally.
- The OpenCode server runs on loopback (default `127.0.0.1:4096`).
- OpenWork UI connects via the official SDK and listens to events.

### Mode B - Client (Desktop/Mobile)

- OpenWork runs on iOS/Android as a **remote controller**.
- It connects to an already-running OpenCode server hosted by a trusted device.
- Pairing uses a QR code / one-time token and a secure transport (LAN or tunneled).

### Mode C - Hosted OpenWork Cloud

- User signs in to hosted OpenWork web/app surfaces.
- User launches a cloud worker from hosted control plane.
- OpenWork returns remote connect credentials (`/w/ws_*` URL + access token).
- User connects from OpenWork app using `Add a worker` -> `Connect remote`.

This model keeps the user experience consistent across self-hosted and hosted paths while preserving OpenCode parity.

## OpenCode Router (Messaging Bridge)

OpenWork can expose a workspace through Slack and Telegram via `opencode-router`.

- `opencode-router` is a local bridge that receives messages from messaging adapters and forwards them into OpenCode sessions.
- The core routing key is `(channel, identityId, peerId) -> directory`.
- Bindings and sessions are persisted locally so a chat can continue against the same workspace directory.
- The router keeps one OpenCode client per directory and one event subscription per active directory.

### Runtime shape

```text
Telegram bot / Slack app
          |
          v
+---------------------------+
| adapter per identity      |
| (telegram/slack, id)      |
+---------------------------+
          |
          v
 (channel, identityId, peerId)
          |
          v
+---------------------------+
| router state              |
| - bindings                |
| - sessions                |
| - identity defaults       |
+---------------------------+
          |
          v
+---------------------------+
| directory resolution      |
| binding -> session ->     |
| identity dir -> default   |
+---------------------------+
          |
          v
+---------------------------+
| OpenCode client per dir   |
+---------------------------+
          |
          v
   OpenCode session.prompt
          |
          v
 reply back to same chat
```

### Directory scoping

OpenWork optimizes for a predictable routing boundary.

- The router starts with a single workspace root (`serve <path>` or `OPENCODE_DIRECTORY`).
- Routed directories may be absolute or relative, but they must stay inside that root.
- Relative chat commands like `/dir foo/bar` resolve against the router root.
- Directories outside the root are rejected instead of silently accepted.

This keeps the mental model simple: one router instance owns one root, and chat routing stays inside that tree.

### Local HTTP control plane

The router exposes a small local HTTP API for host-side configuration and dispatch:

- `/health`
- `/identities/telegram`
- `/identities/slack`
- `/bindings`
- `/send`

OpenWork server proxies `/opencode-router/*` and `/w/:id/opencode-router/*` to that local router API.

### Workspace-scoped behavior in OpenWork

OpenWork server treats messaging identities as workspace-scoped.

- Each workspace maps to a normalized router identity id.
- When the app/server upserts a Telegram or Slack identity for a workspace, it also persists that workspace path as the identity default directory.
- Binding and send APIs are filtered through that workspace identity, so the UI talks about "this workspace" even though the underlying router can track multiple directories.

```text
Client UI / phone / web
          |
          v
+---------------------------+
| OpenWork server           |
| /workspace/:id/...        |
| /w/:id/opencode-router/*  |
+---------------------------+
          |
          | workspace-scoped identity id
          | workspace.path as default dir
          v
+---------------------------+
| local opencode-router     |
| HTTP control plane        |
+---------------------------+
          |
          v
+---------------------------+
| OpenCode                  |
+---------------------------+
```

### CLI mental model

```text
opencode-router serve /root/workspaces

message arrives
  -> lookup (channel, identityId, peerId)
  -> resolve directory
  -> ensure directory is under /root/workspaces
  -> reuse/create OpenCode session for that directory
  -> stream reply back to Slack or Telegram
```

### Multiple workspaces: what works today

There are two layers here, and they matter:

1. The router core can multiplex multiple directories.
2. The current desktop embedding still runs a single router child process with a single root.

```text
Current desktop shape

workspace A ----\
workspace B -----+--> OpenWork server knows all workspaces
workspace C ----/

                   but desktop starts one router child
                   with one configured root

                 +-------------------------------+
                 | opencode-router               |
                 | root: active workspace        |
                 | clients: many dirs under root |
                 +-------------------------------+
```

Practical consequences:

- If multiple workspaces live under one shared parent root, one router can serve them all.
- If workspaces live in unrelated roots, directories outside the active router root are rejected.
- OpenWork server is already multi-workspace aware.
- Desktop router management is still effectively single-root at a time.

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
2. Launch worker (with checkout/paywall when needed).
3. Wait for provisioning and health.
4. Generate/retrieve connect credentials.
5. Connect in OpenWork app via deep link or manual URL + token.

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

- Use the OpenWork server (`packages/server`) as the single API surface for filesystem-backed operations.
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

1. **Skills (OpenPackage)**
   - Installed into `.opencode/skills/*`.
   - OpenWork can run `opkg install` to pull packages from the registry or GitHub.

2. **Plugins (OpenCode)**
   - Plugins are configured via `opencode.json` in the workspace.
   - The format is the same as OpenCode CLI uses today.
   - OpenWork should show plugin status and instructions; a native plugin manager is planned.

### Engine reload (config refresh)

- OpenWork server exposes `POST /workspace/:id/engine/reload`.
- It calls OpenCode `POST /instance/dispose` with the workspace directory to force a config re-read.
- Use after skills/plugins/MCP/config edits; reloads can interrupt active sessions.
- Reload requests follow OpenWork server approval rules.

### OpenPackage Registry (Current + Future)

- Today, OpenWork only supports **curated lists + manual sources**.
- Publishing to the official registry currently requires authentication (`opkg push` + `opkg configure`).
- Future goals:
  - in-app registry search
  - curated list sync (e.g. Awesome Claude Skills)
  - frictionless publishing without signup (pending registry changes)

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
- Scheduling API surface (native in OpenCode server vs OpenWork-managed scheduler).

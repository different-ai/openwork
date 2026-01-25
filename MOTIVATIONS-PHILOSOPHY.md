# OpenWork Motivations and Philosophy


- OpenCode is the **engine**.
- OpenWork is the **experience**: onboarding, safety, permissions, progress, artifacts, and a premium-feeling UI.

OpenWork competes directly with Anthropic’s Cowork conceptually, but stays open, local-first, and standards-based.

- Work with **only the folders the user authorizes**.
- Treat **plugins + skills + commands + mcp** as the primary extensibility system. These are native to OpenCode and OpenWork must be a thin layer on top of them. They're mostly fs based:

## opencode primitives
how to pick the right extension abstraction for 
@opencode


opencode has a lot of extensibility options:
mcp / plugins / skills / bash / agents / commands

- mcp
use when you need authenticated third-party flows (oauth) and want to expose that safely to end users
good fit when “auth + capability surface” is the product boundary
downside: you’re limited to whatever surface area the server exposes

- bash / raw cli
use only for the most advanced users or internal power workflows
highest risk, easiest to get out of hand (context creep + permission creep + footguns)
great for power users and prototyping, terrifying as a default for non-tech users

- plugins
use when you need real tools in code and want to scope permissions around them
good middle ground: safer than raw cli, more flexible than mcp, reusable and testable
basically “guardrails + capability packaging”

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
- adds a new abstraction "workspace" is a project fodler and a simple .json file that includes a list of opencode primitives that map perfectly to an opencode workdir (not fully implemented)
  - openwork can open a workpace.json and decide where to populate a folder with thse settings (not implemented today


## Non-Goals

- Replacing OpenCode’s CLI/TUI.
- Creating bespoke “magic” capabilities that don’t map to OpenCode APIs.

## Target Users

> Bob the IT guy.
Bob might already use opencode, he can setup agents and workflows and share them with his team. The only thing he needs is a way to share this. The way he does is by using OpenWork and creating "workpaces".

> Susan in accounting

Susan in accounting doesn't use opencode. She certaintly doesn't paly aorund to create workflow create agents. She wants something that works.
Openwork should be given to give her a good taste of what she can do. 
We should also eventually guide ther to:
- creating her own skills
- adding custom MCP / login into mcp oauth servers through ui)
- adding skills from a list of skills
- adding plugins from a list of plugins
- create her own commands




1. **knowledge worker**: “Do this for me” workflows with guardrails.
2. **Mobile-first user**: start/monitor tasks from phone.
3. **Power user**: wants UI parity + speed + inspection.
4. **Admin/host**: manages a shared machine + profiles.

## Success Metrics

- < 5 minutes to first successful task on fresh install.
- > 80% task success without terminal fallback.
- Permission prompts understood/accepted (low confusion + low deny-by-accident).
- UI performance: 60fps; <100ms interaction latency; no jank.

## Principles

- **Parity**: UI actions map to OpenCode server APIs.
- **Transparency**: plans, steps, tool calls, permissions are visible.
- **Least privilege**: only user-authorized folders + explicit approvals.
- **Prompt is the workflow**: product logic lives in prompts, rules, and skills.
- **Graceful degradation**: if access is missing, guide the user.

---

## Core Architecture

OpenWork is a Tauri application with two runtime modes:

### Mode A — Host (Desktop/Server)

- OpenWork runs on a desktop/laptop and **starts** OpenCode locally.
- The OpenCode server runs on loopback (default `127.0.0.1:4096`).
- OpenWork UI connects via the official SDK and listens to events.

### Mode B — Client (Desktop/Mobile)

- OpenWork runs on iOS/Android as a **remote controller**.
- It connects to an already-running OpenCode server hosted by a trusted device.
- Pairing uses a QR code / one-time token and a secure transport (LAN or tunneled).

This split makes mobile “first-class” without requiring the full engine to run on-device.

---

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

OpenWork maps a “Task Run” to an OpenCode **Session**.

Core methods:

- `client.session.create()`
- `client.session.list()`
- `client.session.get()`
- `client.session.messages()`
- `client.session.prompt()`
- `client.session.abort()`
- `client.session.summarize()`

### Files + Search

OpenWork’s file browser and “what changed” UI are powered by:

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
4. Record the decision in the run’s audit log.

### Config + Providers

OpenWork’s settings pages use:

- `client.config.get()`
- `client.config.providers()`
- `client.auth.set()` (optional flow to store keys)

### Extensibility — Skills + Plugins

OpenWork exposes two extension surfaces:

1. **Skills (OpenPackage)**
   - Installed into `.opencode/skills/*`.
   - OpenWork can run `opkg install` to pull packages from the registry or GitHub.

2. **Plugins (OpenCode)**
   - Plugins are configured via `opencode.json` in the workspace.
   - The format is the same as OpenCode CLI uses today.
   - OpenWork should show plugin status and instructions; a native plugin manager is planned.

### OpenPackage Registry (Current + Future)

- Today, OpenWork only supports **curated lists + manual sources**.
- Publishing to the official registry currently requires authentication (`opkg push` + `opkg configure`).
- Future goals:
  - in-app registry search
  - curated list sync (e.g. Awesome Claude Skills)
  - frictionless publishing without signup (pending registry changes)


## When it comes to design

use the design from ./design.ts that is your core reference for building the entire ui

### Projects + Path

- `client.project.list()` / `client.project.current()`
- `client.path.get()`

OpenWork conceptually treats “workspace” as the current project/path.

### Optional TUI Control (Advanced)

The SDK exposes `client.tui.*` methods. OpenWork can optionally provide a “Developer Mode” screen to:

- append/submit prompt
- open help/sessions/themes/models
- show toast

This is optional and not required for non-technical MVP.

---

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
- “Allow once” never expands persistent scope.
- “Allow for session” applies only to the session ID.
- “Always allow” (if offered) must be explicit and reversible.

---

## Product Primitives (What OpenWork Exposes)

OpenWork must feel like “OpenCode, but for everyone.”

### 1) Tasks

- A Task = a user-described outcome.
- A Run = an OpenCode session + event stream.

### 2) Plans / Todo Lists

OpenWork provides a first-class plan UI:

- Plan is generated before execution (editable).
- Plan is updated during execution (step status + timestamps).
- Plan is stored as a structured artifact attached to the session (JSON) so it’s reconstructable.

Implementation detail:

- The plan is represented in OpenCode as structured `parts` (or a dedicated “plan message”) and mirrored in OpenWork.

### 3) Steps

- Each tool call becomes a step row with:
  - tool name
  - arguments summary
  - permission state
  - start/end time
  - output preview

### 4) Artifacts

Artifacts are user-visible outputs:

- files created/modified
- generated documents/spreadsheets/presentations
- exported logs and summaries

OpenWork lists artifacts per run and supports open/share/download.

### 5) Audit Log

Every run provides an exportable audit log:

- prompts
- plan
- tool calls
- permission decisions
- outputs

---

## UI/UX Requirements (Slick as a Core Goal)

### Design Targets

- premium, calm, high-contrast
- subtle motion, springy transitions
- zero “developer vibes” in default mode

### Performance Targets

- 60fps animations
- <100ms input-to-feedback
- no blocking spinners (always show progress state)

### Mobile-first Interaction

- bottom navigation
- swipe gestures (dismiss, approve, cancel)
- haptics for major events
- adaptive layouts (phone/tablet)

### Accessibility

- WCAG 2.1 AA
- reduced motion mode
- screen-reader labels for steps + permissions

---

## Functional Requirements

### Onboarding

- Host vs Client selection
- workspace selection (Host)
- connect to host (Client)
- provider/model setup
- first-run “hello world” task

### Task Execution

- create task
- plan preview and edit
- run with streaming updates
- pause/resume/cancel
- show artifacts and summaries

### Permissions

- clear prompts with “why”
- allow once/session
- audit of decisions

### Commands

- save a task as a command
- arguments + quick run

### Scheduling (Future)

- schedule command runs
- notify on completion

---

## User Flow Map (Exhaustive)

### 0. Install & Launch

1. User installs OpenWork.
2. App launches.
3. App shows “Choose mode: Host / Client”.
4. Host: start local OpenCode via SDK.
5. Client: connect flow to an existing host.

### 1. First-Run Onboarding (Host)

1. Welcome + safety overview.
2. Workspace folder selection.
3. Allowed folders selection (can be multiple).
4. Provider/model configuration.
5. `global.health()` check.
6. Run a test session using `session.create()` + `session.prompt()`.
7. Success + sample commands.

### 2. Pairing Onboarding (Client / Mobile)

1. User selects “Client”.
2. UI explains it connects to a trusted host.
3. User scans QR code shown on host device.
4. Client verifies connection with `global.health()`.
5. Client can now list sessions and monitor runs.

### 3. Runtime Health & Recovery

1. UI pings `global.health()`.
2. If unhealthy:
   - Host: attempt restart via `createOpencode()`.
   - Client: show reconnect + diagnostics.

### 4. Quick Task Flow

1. User types goal.
2. OpenWork generates plan (structured).
3. User approves.
4. Create session: `session.create()`.
5. Send prompt: `session.prompt()`.
6. Subscribe to events: `event.subscribe()`.
7. Render streaming output + steps.
8. Show artifacts.

### 5. Guided Task Flow

1. Wizard collects goal, constraints, outputs.
2. Plan preview with “risky step” highlights.
3. Run execution with progress UI.

### 6. File-Driven Task Flow

1. User attaches files.
2. OpenWork injects context into session.
3. Execute prompt.

### 7. Permissions Flow (Any)

1. Event indicates permission request.
2. UI modal shows request.
3. User chooses allow/deny.
4. UI calls `client.permission.reply({ requestID, reply })`.
5. Run continues or fails gracefully.

### 8. Cancel / Abort

1. User clicks “Stop”.
2. UI calls `client.session.abort({ sessionID })`.
3. UI marks run stopped.

### 9. Summarize

1. User taps “Summarize”.
2. UI calls `client.session.summarize({ sessionID })`.
3. Summary displayed as an artifact.

### 10. Run History

1. UI calls `session.list()`.
2. Tap a session to load `session.messages()`.
3. UI reconstructs plan and steps.

### 11. File Explorer + Search

1. User searches: `find.text()`.
2. Open file: `file.read()`.
3. Show changed files: `file.status()`.

### 12. Commands

1. Save a plan + prompt as a command.
2. Re-run command creates a new session.

### 13. Multi-user (Future)

- separate profiles
- separate allowed folders
- separate providers/keys

---

## Security & Privacy

- Local-first by default.
- No secrets in git.
- Use OS keychain for credentials.
- Clear, explicit permissions.
- Exportable audit logs.

---

## Open Questions

- Best packaging strategy for Host mode engine (bundled vs user-installed Node/runtime).
- Best remote transport for mobile client (LAN only vs optional tunnel).
- Scheduling API surface (native in OpenCode server vs OpenWork-managed scheduler).

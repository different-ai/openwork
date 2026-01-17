# OpenWork Product Requirements Document (PRD)

## Summary

OpenWork is an open-source **native GUI** (Tauri) that makes OpenCode feel like a polished consumer app for non-technical people.

- OpenCode is the **engine**.
- OpenWork is the **experience**: onboarding, safety, permissions, progress, artifacts, and a premium-feeling UI.

OpenWork competes directly with Anthropic’s Cowork conceptually, but stays open, local-first, and standards-based.

## Goals

- Deliver a **premium, extremely slick** user experience (desktop + mobile).
- Make OpenCode usable without a terminal.
- Launch/attach to an OpenCode instance automatically when OpenWork starts.
- Expose OpenCode primitives (sessions, messages, tools, permissions, files) in a non-technical UI.
- Provide long-running tasks with resumability.
- Provide explicit, understandable permissions and auditing.
- Work with **only the folders the user authorizes**.
- Treat **plugins + skills** as the primary extensibility system.

## Non-Goals

- Replacing OpenCode’s CLI/TUI.
- Shipping a hosted SaaS in v1.
- Creating bespoke “magic” capabilities that don’t map to OpenCode APIs.

## Target Users

1. **Non-technical knowledge worker**: “Do this for me” workflows with guardrails.
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

### Mode A — Host (Desktop)

- OpenWork runs on a desktop/laptop and **starts** OpenCode locally.
- The OpenCode server runs on loopback (default `127.0.0.1:4096`).
- OpenWork UI connects via the official SDK and listens to events.

### Mode B — Client (Mobile)

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
   - Installed into `.opencode/skill/*`.
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

### Templates

- save a task as template
- variables + quick run

### Scheduling (Future)

- schedule template runs
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
7. Success + sample templates.

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

### 12. Templates

1. Save a plan + prompt as a template.
2. Re-run template creates a new session.

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

---

## Milestones

### v0.1 — Engine + Client

- Host mode: start OpenCode via `createOpencode()`.
- Client mode: connect via `createOpencodeClient()`.
- Health screen + basic sessions list.

### v0.2 — Full Run Loop

- create session
- send prompt
- stream events
- display step timeline
- permission prompts

### v0.3 — Premium UX

- micro-interactions and animations
- mobile layouts + gestures
- templates

### v1.0 — Public Open Source Release

- strong onboarding
- multi-device pairing
- audit/export
- docs + examples

---

## UI/UX Cleaning PRD (Cowork-inspired Session View)

### Summary

Align the session experience with the Cowork-style reference so OpenWork feels calm, friendly, and non-technical by default, while preserving transparency through opt-in details.

### Target Users

- Non-technical operators who want outcomes rather than logs
- Knowledge workers who prefer simple status cues over verbose diagnostics

### Goals

- Replace multi-block technical chatter with a single, collapsible "View steps" per assistant response batch
- Provide a clear, minimal progress indicator that communicates task state at a glance
- Surface artifacts and context in a structured, approachable sidebar
- Preserve an approachable, consumer-grade visual tone

### Non-Goals

- Changing engine behavior or SDK event formats
- Adding new backend data sources beyond existing session/todo/context signals

### Experience Requirements

#### Left Sidebar (Persistent)

- Show tabs (Chat / Cowork / Code)
- Primary action: New task
- Recents list (session titles)
- User profile + plan/footer area

#### Center Feed (Primary Narrative)

- User text appears in short, clean bubbles
- Assistant text appears as narrative with clear spacing
- Non-text parts (reasoning/tool/output) are grouped into a single collapsible "View steps" section
- Collapsed by default; expanded reveals step items

#### Right Sidebar (Context)

- Section 1: Progress (horizontal step dots with checkmarks)
- Section 2: Artifacts (file list with action affordance)
- Section 3: Context (selected folders + working files)
- Each section is collapsible with a small caret

### Information Hierarchy

- Default view emphasizes human-readable outcomes
- Technical detail is opt-in via "View steps"
- Artifacts are promoted above raw tool output

### Functional Requirements

1) Steps grouping
- Group consecutive non-text parts into a single "steps" block
- Render a single toggle: "View steps"
- Expanded content uses a tidy list style (icon + short label)

2) Progress indicator
- Convert todos into a horizontal sequence
- Completed = checkmark, pending = empty circle
- Add helper text: "Steps will show as the task unfolds."

3) Artifacts
- Render created files as cards in the feed
- Mirror artifacts in sidebar list with Open/Reveal action

4) Context surface
- Show selected folders (authorized roots)
- Show working files (from active run context)

### Visual/Interaction Guidelines

- Reduce density; increase whitespace and line height
- Avoid raw JSON or log blocks in default view
- Use soft borders and subtle separators
- Keep typography calm and legible; avoid aggressive contrast blocks

### Data + State Requirements

- Derived grouping of message parts into text vs steps
- Artifact list state, synced to session events
- Context list state (authorized folders + working files)

### Acceptance Criteria

- A single assistant response shows at most one "View steps" block
- No raw tool output appears unless expanded
- Progress, artifacts, and context appear in the right sidebar
- Session view matches the three-column layout and calm tone

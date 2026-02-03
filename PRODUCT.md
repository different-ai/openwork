# OpenWork Product

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



1. **knowledge worker**: "Do this for me" workflows with guardrails.
2. **Mobile-first user**: start/monitor tasks from phone.
3. **Power user**: wants UI parity + speed + inspection.
4. **Admin/host**: manages a shared machine + profiles.

## Success Metrics

- < 5 minutes to first successful task on fresh install.
- > 80% task success without terminal fallback.
- Permission prompts understood/accepted (low confusion + low deny-by-accident).
- UI performance: 60fps; <100ms interaction latency; no jank.

## Product Primitives (What OpenWork Exposes)

OpenWork must feel like "OpenCode, but for everyone."

### 1) Tasks

- A Task = a user-described outcome.
- A Run = an OpenCode session + event stream.

### 2) Plans / Todo Lists

OpenWork provides a first-class plan UI:

- Plan is generated before execution (editable).
- Plan is updated during execution (step status + timestamps).
- Plan is stored as a structured artifact attached to the session (JSON) so it's reconstructable.

Implementation detail:

- The plan is represented in OpenCode as structured `parts` (or a dedicated "plan message") and mirrored in OpenWork.

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

## UI/UX Requirements (Slick as a Core Goal)

### Design Targets

- premium, calm, high-contrast
- subtle motion, springy transitions
- zero "developer vibes" in default mode

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

## Design Reference

use the design from ./design.ts that is your core reference for building the entire ui

## Functional Requirements

### Onboarding

- Host vs Client selection
- workspace selection (Host)
- connect to host (Client)
- provider/model setup
- first-run "hello world" task

### Task Execution

- create task
- plan preview and edit
- run with streaming updates
- pause/resume/cancel
- show artifacts and summaries

### Permissions

- clear prompts with "why"
- allow once/session
- audit of decisions

### Commands

- save a task as a command
- arguments + quick run

### Scheduling (Future)

- schedule command runs
- notify on completion

## User Flow Map (Exhaustive)

### 0. Install & Launch

1. User installs OpenWork.
2. App launches.
3. App shows "Choose mode: Host / Client".
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

1. User selects "Client".
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
2. Plan preview with "risky step" highlights.
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

1. User clicks "Stop".
2. UI calls `client.session.abort({ sessionID })`.
3. UI marks run stopped.

### 9. Summarize

1. User taps "Summarize".
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

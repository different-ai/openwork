# Web-Only Mode + Resilient Workspaces PRD

## Summary
Enable OpenWork to run fully in a browser without the Tauri shell, extract shared UI components for web views, and make core flows resilient when no working directory is available. This PRD defines the product shape, user experience, and architectural shifts required to maintain parity with OpenCode primitives while expanding access to web and mobile environments.

## Goals
- Deliver a web-only runtime that does not require the Tauri browser.
- Extract shared UI components so views are reusable across web and desktop.
- Allow users to start tasks without a working directory and recover when one is missing.
- Preserve safety, permissions, and transparency standards from the desktop experience.
- Keep UX premium, calm, and mobile-friendly.

## Non-goals
- Replace the Tauri desktop app.
- Build a full web IDE or generalized file manager.
- Enable fully offline execution without a host or engine.
- Add new compute backends beyond OpenCode.

## Definitions
- **Web-only mode**: OpenWork runs in a standard browser, with no Tauri shell.
- **Host**: A trusted device running OpenCode that can execute tasks and stream events.
- **Workspace**: The authorized folder or project context for tasks.
- **No-workspace mode**: Tasks that run without an attached workspace, using minimal context.

## Guiding principles
- Parity with OpenCode primitives (sessions, events, permissions, artifacts).
- Least-privilege access with explicit user intent.
- Calm, clear UX with minimal jargon.
- Graceful degradation when access or connectivity is missing.
- Single codepath for UI, with platform-specific adapters.

## Current state / problem
- OpenWork is tightly coupled to Tauri runtime expectations, limiting web-only execution.
- Several UI components assume local filesystem access and a working directory.
- When a working directory is missing, flows break or block instead of degrading.
- Component reuse across web and desktop is limited by platform-specific dependencies.

## Proposal
### 1) Web-only runtime
- Introduce a browser runtime mode that connects to an OpenCode host via a secure bridge.
- Detect runtime capabilities at launch (web-only, web+host, desktop).
- Gate features and show capability badges based on runtime.

### 2) Shared component extraction
- Create a platform-agnostic UI layer for:
  - task composer
  - session timeline
  - permissions prompts
  - artifacts list
  - templates and history views
- Move platform bindings (filesystem, IPC, process control) to adapters.

### 3) No-workspace resilience
- Support task creation without a workspace.
- Only require a workspace when tasks explicitly need filesystem access.
- Provide fallback options:
  - connect a workspace later
  - use a sample workspace
  - run in view-only mode

### 4) Safety and permissions in web-only mode
- Default to read-only or no-file access in the browser.
- Require explicit approval for host connections and workspace access.
- Provide clear “why” explanations for permission requests.

## UX / flows
### Entry (web-only)
1. User opens OpenWork in browser.
2. Runtime banner indicates “Web Mode”.
3. User chooses:
   - Connect to a host
   - Continue without workspace
4. App lands in a task-ready home view with clear status.

### No-workspace task flow
1. User starts a task without workspace.
2. UI shows a “limited context” tag with explanation.
3. If the task requires files, prompt to attach or connect workspace.
4. Task continues or is paused until workspace is provided.

### Host connection flow
1. User selects “Connect to host.”
2. QR / token flow establishes secure connection.
3. Health check runs (global.health).
4. User can access sessions and run tasks.

### Permission flow
1. Permission request appears with context and scope.
2. Options: allow once, allow for session, deny.
3. Audit log records decision.

## Data / storage
- Web-only mode stores UI state + session metadata in IndexedDB.
- Full session history can be synced from host when connected.
- Artifacts remain on host unless explicitly exported or shared.
- Clear messaging on where data lives (browser vs host).

## Migration
- Introduce runtime detection without breaking desktop defaults.
- Add adapter interfaces and migrate components incrementally.
- Keep desktop experience unchanged while enabling web-only parity.

## Acceptance criteria
1. OpenWork runs in a browser with no Tauri dependencies.
2. Core task flow works without a workspace, with clear limitations.
3. Users can connect to a host and run sessions end-to-end.
4. Components render identically across web and desktop for shared views.
5. Permission prompts and audit logs work in web-only mode.
6. No-workspace paths never hard-block; they guide users forward.

## Open questions
1. Should the host bridge be LAN-only or allow optional tunneling?
2. How is authentication handled for shared or public web clients?
3. What is the minimal task set that must support no-workspace mode?
4. How should large artifacts be exported in web-only mode?
5. What is the best fallback when host is unreachable mid-session?

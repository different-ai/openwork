# PRD — Folder-Scoped Workspaces (JIT) + Starter Workspace (OpenWork)

## Summary

OpenWork currently asks users to pick a folder at app start (Host onboarding) and pre-authorize access up front. This is safe, but it’s the wrong moment: users just want to try the product and start a task.

This PRD reframes “workspace” around **OpenCode primitives**:

- **Primary primitive: folders.** A workspace is a folder.
- **Workspace scope is already defined by OpenCode’s project model**:
  - Plugins/MCP live in project `opencode.json`
  - Skills live in project `.opencode/skill`
  - The OpenCode client already accepts a `directory` (folder) to scope project behavior

### What changes

1. **Just-in-time (JIT) workspace selection**: pick a workspace when you start work (new session / first prompt / run template), not at app launch.
2. **Starter Workspace**: OpenWork ships/creates a “ready-to-run” default folder-workspace so new users can start immediately.
3. **Workspace templates**: creating a workspace is “choose a folder + apply a template” (writes OpenCode-native files like `opencode.json` and `.opencode/*`).
4. **JIT folder expansion**: when a task needs access to a new folder, OpenWork offers “Allow once / Add to workspace / Deny”.

This keeps least-privilege, but moves permissions to the moment of intent.

## Design Principle (Guiding)

OpenWork should **prefer OpenCode primitives** before inventing new ones.

For “workspaces”, that means:

- A workspace should map to a real **folder**.
- Workspace configuration should live in existing OpenCode surfaces:
  - `opencode.json` (project scope plugins/MCP)
  - `.opencode/skill` (project scope skills)
- Any OpenWork-only metadata should still live *inside the folder* (e.g. `.opencode/openwork.json`) rather than a separate global database.

## Problem

The current onboarding step “Authorized Workspaces” front-loads decisions that users don’t understand yet:

- Users want to try OpenWork without choosing a folder.
- Users often don’t know what folder they need until they write the task.
- Users commonly work across multiple folders (repo + docs + downloads), which doesn’t fit a single “project dir” prompt.

The result: a premium UI with an early “developer cliff”.

## Goals

- Remove upfront folder selection from first-run Host onboarding.
- Treat “workspace” as a **folder-scoped OpenCode project**.
- Provide a **Starter Workspace** that works out-of-the-box.
- Let users create many workspaces quickly using templates.
- Support multiple authorized folders per workspace and add them JIT.
- Keep parity with OpenCode behavior and config surfaces.

## Non-goals

- Replacing OpenCode’s permission system.
- Multi-user workspace sharing and sync (future).
- Full IDE-style project management.

## Current Constraints

- OpenWork effectively has two layers of access control:
  1. OS/native folder picking and OpenWork-managed allowed roots
  2. OpenCode permission requests surfaced via events

- Host mode currently expects a project directory early.

## Proposal

### 1) Workspace = Folder + OpenCode config

A workspace is identified by its folder path (primary directory).

Within that folder:

- Plugins/MCP configuration: `opencode.json`
- Skills: `.opencode/skill/*`
- OpenWork metadata (optional): `.opencode/openwork.json`

This aligns with existing OpenCode project scoping (`directory`), and keeps workspaces reconstructable.

### 2) Starter Workspace (first-run default)

On first Host launch, OpenWork creates (or initializes) a default workspace folder (the “Starter Workspace”).

Suggested folder location (app-managed, no user picker):

- macOS: `~/Library/Application Support/OpenWork/workspaces/starter`
- Linux: `~/.local/share/openwork/workspaces/starter`
- Windows: `%APPDATA%\\OpenWork\\workspaces\\starter`

The Starter Workspace is a real folder workspace with a template applied:

- `opencode.json` includes a recommended “starter” plugin set
  - includes `different-ai/opencode-scheduler` by default
- `.opencode/skill` can optionally include a small set of curated starter skills (future)

This means:

- The user can reach the dashboard and run a first task without selecting any folder.
- The workspace model is visible and consistent from minute one.

### 3) Workspace templates (folder-native)

Creating a workspace becomes:

1. Pick or create a folder (JIT)
2. Choose a template
3. OpenWork writes/updates OpenCode-native files in that folder

Template examples:

- **Starter (recommended)**
  - installs/enables `different-ai/opencode-scheduler`
  - optionally suggests the browser/plugin set (future)
- **Minimal**
  - no plugins; purely connect and run
- **Automation**
  - scheduler + any supported automation plugins

The important rule: templates should not create a parallel config system. They should materialize into `opencode.json` and `.opencode/*`.

### 4) JIT workspace selection moments

Workspace selection happens when:

- starting a new session
- sending the first prompt (if no session)
- running a template

If there is no active workspace, OpenWork shows a lightweight “Workspace Picker” sheet:

- Recent workspaces (folders)
- Starter Workspace (pinned)
- “New workspace…”
- “Quick task (no file access)” (uses Starter Workspace in read-only/no-extra-folders mode)

### 5) JIT folder expansion (“Add to workspace”)

When the agent needs to read/write outside currently authorized roots, OpenWork prompts:

- Allow once (session-only)
- Add to workspace (persist folder into workspace’s authorized folder list)
- Deny

Storage:

- authorized folders are recorded in `.opencode/openwork.json` inside the workspace folder

This keeps the “workspace = folder” model intact while still allowing multi-folder workflows.

### 6) Plugins + Skills scoping becomes workspace-first

Plugins tab:

- Default scope = current workspace (`<workspace>/opencode.json`)
- Secondary scope = global (`~/.config/opencode/opencode.json`)

Skills tab:

- Default install target = current workspace (`<workspace>/.opencode/skill`)
- Optional future: global skills (explicit)

## UX / UI Elements

### A) Workspace Chip (always visible)

A compact chip in the dashboard header and prompt bar:

- shows active workspace name/folder
- tap to open workspace picker

### B) Workspace Picker (sheet)

- Recent + pinned
- Search by folder/name
- Create new workspace
- Manage workspaces

### C) Workspace Creation Flow (folder + template)

Wizard steps:

1. Choose folder (existing or create new)
2. Name workspace (defaults from folder name)
3. Select template (Starter / Minimal / …)
4. Review “This will write: `opencode.json`, `.opencode/openwork.json`”

### D) Workspace Settings page

Per workspace:

- rename
- change primary folder (advanced)
- view plugin config path
- list authorized folders, add/remove
- “Reset template” (re-apply template to `opencode.json` safely)

### E) “Add Folder” affordance

When a user wants to reference a folder in a prompt (e.g. “Use files in Downloads”), provide an obvious affordance:

- “Add folder…” button near the prompt input

This triggers the same JIT folder addition flow (adds to workspace or once).

## User Flows (Concrete)

### Flow 1 — First run (Host)

1. User launches OpenWork.
2. Engine setup runs.
3. OpenWork lands user in dashboard with Starter Workspace active.
4. Prompt input is ready.

### Flow 2 — First task (no folder selection)

1. User types: “Summarize my meeting notes.”
2. Task runs inside Starter Workspace.
3. If the task never touches external files, no folder prompts appear.

### Flow 3 — Task needs local files (JIT)

1. User types: “Summarize the PDF in my Downloads.”
2. OpenWork sees access request or user clicks “Add folder…”.
3. OpenWork prompts:
   - Allow once
   - Add to workspace
   - Deny
4. If “Add to workspace”, the folder is saved in `.opencode/openwork.json`.

### Flow 4 — Create a new workspace for a repo

1. User clicks Workspace chip → “New workspace…”.
2. Picks an existing repo folder.
3. Chooses template “Starter (recommended)”.
4. OpenWork writes `opencode.json` (with scheduler) and `.opencode/openwork.json`.
5. Workspace becomes active; Plugins/Skills tabs now reflect that folder.

### Flow 5 — Switching workspaces

1. User taps Workspace chip.
2. Picks another workspace.
3. OpenWork re-connects client with `directory = workspace folder`.
4. UI refreshes:
   - plugin config
   - skills list
   - session list (optional filtering; future)

## Technical Notes (No Implementation Yet)

- Workspace list can be stored as “recent folders” in IndexedDB, but the source of truth for workspace-scoped policy should live in the folder (`.opencode/openwork.json`).
- Workspace templates should be represented as a deterministic `opencode.json` patch.
- Starter Workspace is created/initialized on first run and pinned.

## Migration

For users with existing saved `projectDir` and `authorizedDirs`:

- Treat the existing `projectDir` as a workspace folder.
- Create `.opencode/openwork.json` in that folder capturing current authorized dirs.
- Mark it as a recent workspace.

## Acceptance Criteria

- Fresh install:
  - user reaches dashboard without choosing any folder
  - Starter Workspace exists and is active
  - user can run a task immediately
- User can create 2+ folder workspaces and switch between them.
- Adding access to a new folder is possible “JIT” and can be persisted to the workspace.
- Plugins and skills reflect the active folder workspace scope (project vs global).

## Open Questions

- Should the Starter Workspace be fully hidden (just works) or visible and editable from day one?
- Do we want to include a minimal default `opencode.json` in Starter, or only prompt users to install plugins?
- How should mobile Client mode enumerate available workspaces on the host (and enforce which ones are exposed)?
- What is the cleanest OpenCode-native way to express “authorized folders” if we want to avoid any OpenWork-specific file (`.opencode/openwork.json`)?

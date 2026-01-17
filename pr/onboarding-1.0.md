# PRD — Onboarding 1.0: Folder Workspaces + Extension Scopes (OpenWork)

- Status: Draft
- Owner: OpenWork
- Last updated: 2026-01-16

## Product Truth (One Sentence)

OpenWork teaches itself by running **real sessions** that modify **real folder-workspaces** using **real extensions** (skills/plugins/templates) — no tutorial mode, no fake demo.

---

## Summary

OpenWork is a premium native GUI for OpenCode. Today, Host onboarding asks users to pick and pre-authorize folders before they can do anything meaningful.

That is safe, but it’s the wrong moment:

- New users don’t yet understand why folder choice matters.
- Users often don’t know the right folder until they write the task.
- People work across multiple folders (repo + notes + downloads), which doesn’t map cleanly to a single “project dir” prompt.

This PRD defines **Onboarding 1.0**, centered on a single guiding idea:

- **Workspace = Folder** (OpenCode-native)

…and it formalizes “Extensions” and their scopes:

- **Workspace-scoped extensions** (live inside the folder)
- **Global extensions** (live in user/global config)

Finally, it makes a key UX decision explicit:

- **Sessions are a global primitive.** Workspaces are metadata, not containers.

---

## Goals

### Onboarding & UX

- Make “first launch → first successful task” feel effortless and premium.
- Avoid front-loading folder decisions before the user has intent.
- Teach the system **by doing**: onboarding produces durable objects (workspace, session, templates, visible extensions).
- Keep core actions understandable to non-technical users.

### Model & Architecture

- Define an OpenCode-native workspace model: **a workspace is a real folder**.
- Make extension scope obvious (workspace vs global) for:
  - plugins
  - skills
  - templates
- Keep parity with OpenCode primitives and config surfaces.

### Safety

- Keep least-privilege behavior.
- Keep folder authorization explicit and workspace-scoped.

---

## Non-goals

- Replacing or bypassing OpenCode’s permission model.
- Building an IDE-style project system.
- Multi-user sync/sharing across machines (future).
- Fully solving mobile pairing/workspace enumeration (future).

---

## Definitions (Canonical Terms)

### Workspace

A **workspace** is a **folder** that OpenWork treats as a project boundary.

- Identity: the folder path (primary folder)
- Configuration lives in OpenCode-native locations inside that folder:
  - `<workspace>/opencode.json`
  - `<workspace>/.opencode/skill/*`
- OpenWork-only workspace metadata (when required) also lives inside that folder:
  - `<workspace>/.opencode/openwork.json`

### Session

A **session** is an OpenCode session. It represents a task/run history.

- Sessions are **global** and searchable.
- A session can be *tagged* with a workspace context (not owned by the workspace).

### Template (Task Template)

A **template** is a reusable “task starter” that can create a new session and send the first prompt.

- Templates are considered a type of **extension**.
- Templates can be **workspace-scoped** or **global**.

### Workspace Template (Workspace Preset)

A **workspace template** is a preset applied when creating/initializing a workspace.

- It materializes as edits to OpenCode-native files:
  - creates/patches `<workspace>/opencode.json`
  - creates/patches `<workspace>/.opencode/*`
  - may create `<workspace>/.opencode/openwork.json`

This PRD uses:

- “Task Template” = reusable prompt/run
- “Workspace Template/Preset” = initializes a folder-workspace

### Extensions

An **extension** is any installable/reusable capability surface exposed by OpenWork:

- Plugins
- Skills
- Templates

Extensions can exist in either scope:

- Workspace scope (project/folder)
- Global scope (user)

---

## Guiding Principles

1. **Prefer OpenCode primitives before inventing new ones**
   - Workspace is a folder.
   - Config lives in `opencode.json` and `.opencode/*`.
2. **Progressive disclosure**
   - The UI should “just work” without requiring users to understand skills/plugins/templates.
   - When users are ready, the UI makes the LEGO blocks visible and learnable.
3. **Least privilege**
   - Ask for access explicitly and keep scope minimal.
4. **Sessions are global; workspaces are labels**
   - Humans remember tasks, not folder paths.
   - Global Sessions is mandatory; workspace views are filters.
5. **Onboarding must leave durable objects**
   - A workspace (folder)
   - A session (“Welcome to OpenWork”)
   - Visible workspace-scoped extensions (at least one plugin + one skill)
   - Practical templates (not toy examples)

---

## Problem (What’s Broken Today)

### Current behavior

In Host mode today, OpenWork effectively pushes users to:

- pick a folder early (project directory)
- pre-authorize folder roots up front

This creates a “developer cliff”:

- Users don’t know what a “workspace folder” means yet.
- Users don’t know which folder they need until they write the task.
- Users want to try the product *now*.

### Why this matters

If onboarding feels like configuration, OpenWork loses its core promise:

- “agentic work that feels like a product, not a terminal.”

---

## Proposed Model

### 1) Workspace = Folder + OpenCode-native config

A workspace is identified by its folder path.

Inside that folder:

- Plugins/MCP: `<workspace>/opencode.json`
- Skills: `<workspace>/.opencode/skill/*`
- OpenWork metadata (optional, workspace-scoped): `<workspace>/.opencode/openwork.json`

**Rule:** Workspace-scoped policy must live *inside the workspace folder*.

### 2) Sessions are global (canonical)

Sessions must not be trapped inside a workspace-only navigation model.

- Global Sessions is the primary home for task history.
- Workspaces are a filtering dimension.

**Non-negotiable rule:** A workspace can be deleted without deleting sessions.

### 3) Extensions: workspace vs global

We define “Extensions” as a single mental bucket with two scopes.

#### Extension types

| Extension type | What it is | Example |
|---|---|---|
| Plugin | Extends OpenCode engine behavior | `opencode-scheduler`, `@different-ai/opencode-browser` |
| Skill | Reusable workflow/tooling packaged for OpenCode | `.opencode/skill/<name>/...` |
| Template | Reusable task starter (prompt + optional variables) | “Summarize recent work”, “Create a new skill” |

#### Scope table (target state)

| Extension | Workspace scope (folder) | Global scope (user) | UI requirement |
|---|---|---|---|
| Plugins | `<workspace>/opencode.json` | `$XDG_CONFIG_HOME/opencode/opencode.json` (or `~/.config/opencode/opencode.json`) | Always show which config file is being edited |
| Skills | `<workspace>/.opencode/skill/*` | (future) `~/.config/opencode/skill/*` (or other OpenCode-native global location) | Default installs go to workspace; global is explicit |
| Templates | `<workspace>/.openwork/templates/*` (workspace templates) | App-managed storage (global templates) | Templates must show their scope and where they live |

Notes:

- Plugins already have a strong OpenCode-native global/project distinction.
- Skills and Templates should be **workspace-first** for portability/reproducibility.
- Global templates are still valuable for “personal shortcuts” that aren’t tied to a repo.

---

## Onboarding 1.0 (End-to-End)

### Key insight

Don’t teach concepts upfront. Let the first session teach by using the primitives.

### Flow overview

1. Engine check/setup
2. Create/initialize first workspace (defaults, no cliff)
3. Auto-populate the workspace (visible extensions + practical templates)
4. Auto-start a real onboarding session (“Welcome to OpenWork”)
5. Land in a non-empty Workspace Home

---

### Step 0 — First launch: Engine Check

- If OpenCode engine is missing/unreachable:
  - show “Engine Setup” flow (guided install/connect)
  - show logs and explicit consent
- If engine reachable:
  - proceed immediately

(Engine setup is defined in `prd-opencode-install.md`; this PRD assumes it exists.)

---

### Step 1 — Create/Initialize first workspace (no cliff)

**Default behavior (recommended):**

- OpenWork creates a **Starter Workspace** automatically in an app-managed location.
- User does not need a folder picker to continue.

**Optional advanced action:**

- “Change location” lets users pick a folder now (existing or new), but it is not required to start.

UI copy (one sentence):

- “A workspace is a folder with its own skills, plugins, and templates.”

---

### Step 2 — Starter Workspace (first-run default)

On first Host launch, OpenWork creates/initializes a default folder-workspace.

Suggested location (no user picker):

- macOS: `~/Library/Application Support/OpenWork/workspaces/starter`
- Linux: `~/.local/share/openwork/workspaces/starter`
- Windows: `%APPDATA%\\OpenWork\\workspaces\\starter`

Starter Workspace is real and inspectable:

- contains `opencode.json`
- contains `.opencode/skill/*` (optional)
- contains `.opencode/openwork.json`
- contains `.openwork/templates/*`

---

### Step 3 — Auto-populate workspace (make LEGO blocks real)

The Starter Workspace must not be empty.

#### A) Workspace-local plugin (required)

- Enable the scheduler plugin by default (workspace-scoped).
- Visible in Plugins manager, marked “Workspace”.

Rationale:

- Demonstrates “extensions change per workspace”.
- Makes automation feel real, not theoretical.

#### B) Workspace-local onboarding skill (required)

A single “guide” skill exists only to teach onboarding by running:

- Name example: `workspace_guide` or `openwork_onboarding`
- Installed workspace-locally

This skill should:

- explain workspace vs global scopes in plain language
- link (deep-link) to Skills/Plugins/Templates screens
- produce a durable artifact (e.g., a short audit summary)

#### C) Practical templates (required)

Minimum recommended starter templates:

1. **Understand this workspace**
   - runs the onboarding skill
   - explains where things live (folder paths)

2. **Create a new skill**
   - guided workflow: what a skill is, where it lives, how to run it

3. **Turn a task into a template**
   - teaches capture flow (“Save Template”)

4. **Run a scheduled task**
   - demonstrates scheduler plugin end-to-end

Optional extras (high-value):

- “Summarize changes in this folder”
- “Search recent work”

---

### Step 4 — Onboarding becomes a real session

No modal tours. No tutorial overlays.

OpenWork automatically creates and opens a real session titled:

- “Welcome to OpenWork”

This session:

- is visible in Global Sessions
- uses the workspace onboarding skill
- produces a tangible result (and can be reopened anytime)

At the end, the session encourages:

- saving this workflow as a template
- exploring Skills/Plugins

---

### Step 5 — Post-onboarding landing state (never empty)

After onboarding session completes, user lands in Workspace Home:

- Recent Sessions (includes onboarding)
- Quick Start Templates (includes starter templates)
- “New Task” primary CTA
- Workspace chip visible and tappable

---

## Global Sessions UX (Mandatory)

### Why

If sessions are buried under workspaces, users must remember where work happened before they can find it.

Humans remember tasks, not folders.

### Canonical model

- Sessions are global primitives.
- Workspaces are metadata labels.

### Navigation

Global shell includes top-level:

- Home
- Sessions (global)
- Templates
- Skills
- Plugins
- Settings

Workspace switcher exists, but it filters context rather than containing all history.

### Views

- Global Sessions:
  - All / Running / Completed / Failed
  - Filter by workspace, template, time
- Workspace Sessions:
  - derived filter: `sessions WHERE workspace = current`

---

## Workspace UX

### A) Workspace chip (always visible)

A compact chip in dashboard header and prompt bar:

- shows active workspace name + short path
- tap → workspace picker

### B) Workspace picker (sheet)

- Pinned: Starter Workspace
- Recent workspaces (folders)
- Search
- “New workspace…”

### C) Workspace creation (folder + preset)

Wizard steps:

1. Choose folder (existing or create new)
2. Name workspace (default from folder)
3. Select workspace preset (Starter / Minimal / Automation)
4. Review: “This will write `opencode.json`, `.opencode/openwork.json`, and `.openwork/templates/*`”

### D) Workspace settings

Per workspace:

- rename
- show paths for:
  - workspace root
  - plugin config file (`opencode.json`)
  - skills directory (`.opencode/skill`)
  - OpenWork metadata (`.opencode/openwork.json`)
- authorized folders list (add/remove)
- re-apply preset safely (idempotent patch)

---

## Folder Authorization (Workspace-Scoped)

### Why

Multi-folder workflows are normal, but OpenWork must stay least-privilege.

### Model

- A workspace has a set of authorized roots.
- Anything outside those roots is denied by default unless explicitly approved by the user.
- Permission prompts can grant session-scoped access (allow once / allow for session), but those do not expand the workspace roots.
- Persistent folder access is managed explicitly via workspace settings (“Authorized folders”).

### Storage

- Authorized roots are persisted inside the workspace:
  - `<workspace>/.opencode/openwork.json`

---

## Data & Storage (Proposed)

### Workspace metadata file

`<workspace>/.opencode/openwork.json`

Proposed minimal schema:

```json
{
  "version": 1,
  "workspace": {
    "name": "Starter Workspace",
    "createdAt": 1730000000000,
    "preset": "starter"
  },
  "authorizedRoots": [
    "/path/to/workspace",
    "/path/added/with-user-consent"
  ]
}
```

Notes:

- This file is intentionally simple and reconstructable.
- Workspace templates/presets should remain deterministic patches to `opencode.json` + `.opencode/*`.

### Global state (allowed to be global)

Some state must be global to function:

- recent workspace list
- UI preferences
- global templates (optional)

Preferred storage:

- Desktop: app data directory via Tauri (not inside random project folders)

---

## Migration

For existing users with:

- `projectDir`
- `authorizedDirs`
- workspace templates stored in `.openwork/templates/*`
- global templates in app-managed storage (optional)

Migration rules:

1. Treat old `projectDir` as a workspace folder.
2. Create `<workspace>/.opencode/openwork.json` capturing authorized roots.
3. Import existing templates as **global templates** (or optionally into that workspace).
4. Add workspace to recents.

---

## Success Metrics / Acceptance Criteria

### Fresh install

- User reaches dashboard without picking a folder manually.
- Starter Workspace exists and is active.
- User can run a task immediately.

### Workspace model

- User can create 2+ folder workspaces and switch between them.
- Plugins and skills reflect active workspace scope.

### Folder authorization

- When a task needs access to a folder outside the workspace roots:
  - the UI blocks by default and explains why
  - the user can grant session-scoped access (allow once / allow for session)
  - the user can deny
  - if they want persistent access, they explicitly add it as a workspace root via workspace settings

### Sessions

- Global Sessions view exists and lists sessions regardless of workspace.
- Sessions show a workspace badge (where applicable).
- Deleting a workspace does not delete sessions.

---

## Open Questions

1. Should Starter Workspace be fully “pinned & visible” or semi-hidden by default?
2. What is the cleanest OpenCode-native way to store session → workspace association?
   - session metadata/tags (preferred, if available)
   - OpenWork-side index (fallback)
3. What is the best OpenCode-native global skills location (if we want global skills)?
4. Should workspace templates/presets be expressed as JSON patches, or a higher-level declarative format?
5. How should Client mode enumerate which workspaces are exposed on the host?

# PRD: Notion MCP Demo + Skill-Guided Workflow

## Summary
We need a demo-ready flow that connects Notion via MCP and then makes it usable for
non-technical users by pairing the MCP with a curated skill. The demo should reuse
existing OpenWork surfaces (skills install, config writes, engine reload) and only add
the minimum new pieces required for a clean Notion story.

## Motivation
- MCPs are powerful but their tool surfaces are unclear to most users.
- Skills are the UX bridge that make MCPs approachable and repeatable.
- The demo must map to OpenCode primitives (opencode.json, skills) and stay mobile-first.

## Goals
- Demo Notion MCP connection using the existing workspace config flow (`opencode.json`).
- Use the existing Skills UI to install a curated "Manage CRM in Notion" skill.
- Ensure engine reload is triggered so MCP tools + skills are live.
- Provide a "setup my CRM" prompt that clearly uses the Notion MCP + skill.

## Non-Goals
- Building a custom MCP protocol or bespoke auth flow.
- Auto-generating skills from MCP schemas.
- Bypassing OpenCode config/permissions or inventing new storage.

## User Story
As a non-technical user, I want to connect Notion and then run a "Manage CRM" workflow
without having to understand MCP tools or write prompts from scratch.

## Existing Building Blocks (from code)
- Skills UI supports:
  - Install via OpenPackage (`opkg install`) into `.opencode/skill`.
  - Import local skill folders into `.opencode/skill/<name>`.
  - Curated package list with search + install.
- Skills are discovered by listing `.opencode/skill/*` and reading `SKILL.md`.
- Engine reload banner exists and is triggered by skill/plugin changes.
- OpenCode config read/write is already used for plugins in `opencode.json`.
- Provider list is fetched from OpenCode (`client.provider.list()` or `client.config.providers()`).

## Demo Scope
- Add a Notion MCP entry to `opencode.json` in the workspace (project scope).
- Trigger engine reload after MCP config write.
- Add a curated skill entry ("manage-crm-notion") so it can be installed from Skills.
- Use the existing reload banner to guide the user after install.

## User Flow
1. User navigates to MCPs (or settings) and selects Notion.
2. User completes OAuth flow.
3. OpenWork writes an MCP entry into workspace `opencode.json`.
4. OpenWork marks "Reload required" and the user reloads the engine.
5. User opens Skills and searches for "Manage CRM in Notion".
6. User clicks "Install" (OpenPackage or curated source).
7. Skill is written to `.opencode/skill/manage-crm-notion/SKILL.md`.
8. OpenWork marks "Reload required" and the user reloads the engine.
9. User types "setup my crm" and the skill guides Notion actions.

## UX Requirements
- Clear, non-technical copy that explains what MCPs and Skills do.
- Always show status for OAuth, config writes, and engine reload.
- Use the existing reload banner and prevent reload during active runs.
- Mobile-first touch targets and clear progress states.

## Technical Requirements
### MCP Install (Demo)
- Use existing `opencode.json` read/write utilities (project scope).
- Add/merge a `mcp` entry for Notion without breaking existing config.
- Mark reload required so the reload banner is shown.

### Skill Install
- Skills live in `.opencode/skill/<name>/SKILL.md` (current OpenWork path).
- Skill name must be kebab-case and match the folder name.
- Install can be via OpenPackage or curated local source.
- Mark reload required after install.

### Engine Reload
- Use existing "Reload required" banner copy and behavior.
- Reload is only available in Host mode and must be blocked during active runs.

## Data and Artifacts
- `opencode.json` updated with Notion MCP config.
- `.opencode/skill/manage-crm-notion/SKILL.md` created on install.
- Audit log records: OAuth completion, config write, skill install, reloads.

## Permissions and Safety
- Follow least-privilege principles for OAuth scopes.
- Ensure users understand what access they are granting.
- Avoid automatic re-use across workspaces without explicit user action.

## Edge Cases
- OAuth completes but config write fails.
- Config write succeeds but engine reload fails.
- Skill install fails (OpenPackage error or filesystem permissions).
- User removes MCP or skill but doesn’t reload.

## Success Metrics
- % of users who complete Notion OAuth without abandoning.
- Time from "Add MCP" to first successful Notion action.
- % of users who install the Notion CRM skill after MCP setup.
- Reduction in failed Notion prompts after skill install.

## Open Questions
- What is the minimal Notion OAuth scope for the CRM demo?
- Should MCP reload be automatic or user-initiated?
- Where should curated Notion skill live (OpenPackage vs local curated list)?

## What Needs To Be Built
- MCP surface placement: a single “Connect Notion” card in Settings (or a small MCPs section in Settings) so the flow is discoverable without adding a new top-level tab.
- Connection state UI: status row with three states (Not connected, Connecting…, Connected) plus a one-line value statement (“Connect Notion to power your CRM workflow”).
- OAuth completion affordance: confirmation row after OAuth returning to OpenWork that shows the active workspace and the chosen scope summary.
- Config write confirmation: a quiet inline success message that `opencode.json` was updated, without surfacing raw JSON.
- Reload path: reuse the existing reload banner and add MCP as a reload reason so the banner appears after MCP connect and skill install.
- Skill discovery CTA: a featured “Manage CRM in Notion” tile pinned in Skills with a short outcome line and a single install button.
- First-run prompt helper: a “Try it now” CTA that inserts “setup my crm” into the prompt input after the final reload.
- Failure recovery UX: inline retry actions for OAuth, config write, skill install, and reload, keeping users in the flow without modal walls.

## Required Technical Implementation
### UI Surface Mapping (OpenWork)
- Settings view: add a Notion MCP card or “MCPs” section inside `src/views/SettingsView.tsx` with connection status and a “Connect” action.
- Skills view: add a curated “Manage CRM in Notion” entry in `src/app/constants.ts` (curated list) and render it through `src/views/SkillsView.tsx` like other curated packages.
- Prompt CTA: implement the “Try it now” button near the chat input in `src/views/DashboardView.tsx` or the session prompt surface, reusing the existing input setter.
- Status + error copy: reuse the standard `setError` and `setBusyLabel` surfaces from `src/App.tsx` and `src/app/extensions.ts`.

### OpenCode SDK + OpenWork Primitives
- Config read/write: use existing Tauri helpers `read_opencode_config` / `write_opencode_config` from `src/lib/tauri.ts` to update the project `opencode.json`.
- MCP config schema: add a Notion entry under `mcp` in `opencode.json` with `type` and connection details (remote server URL or local command) matching OpenCode MCP spec.
- Skills discovery: rely on `client.file.list()` and `client.file.read()` from `src/app/extensions.ts` for `.opencode/skill/*` discovery; no new indexing logic.
- Skill install: reuse `opkg_install` and `import_skill` in `src/lib/tauri.ts` to land the curated skill into `.opencode/skill/manage-crm-notion/`.
- Event stream: continue using `client.event.subscribe()` (already active) so MCP-auth and tool usage appear in the run timeline as normal.

### Reload Behavior (End-to-End)
- Mark reload required: extend `ReloadReason` in `src/app/types.ts` to include `"mcp"`, then call `markReloadRequired("mcp")` after MCP config writes.
- Banner copy: update the reload copy in `src/App.tsx` to include an MCP-specific message (e.g., “Reload to activate MCP tools”).
- Host-only guardrails: keep the existing host-only and no-active-runs checks in `reloadEngineInstance` to prevent unsafe reloads.
- Engine refresh: rely on `client.instance.dispose()` and `waitForHealthy()` in `src/App.tsx` to restart the OpenCode process, then re-fetch providers, plugins, and skills.
- Post-reload refresh: call `refreshPlugins("project")` and `refreshSkills()` after reload to ensure the Notion MCP + skill appear immediately in UI.
- Retry surface: if reload fails, reuse `reloadError` state to show a retry CTA on the same banner.

### Behavior + Data
- OAuth state: store transient connection state locally (signal/store) with timestamps for “Connecting…” and “Connected” display.
- Audit log: append a lightweight OpenWork audit entry for OAuth success/failure, config write, and reload (mirrors existing activity log behavior).
- Workspace scope: ensure all MCP config writes and skill installs target the active workspace root (`projectDir`).
- Safety: do not auto-run the CRM prompt; insert text into the input so the user explicitly confirms execution.

# PRD — Reload Engine After Plugin / Skill Changes (OpenWork)

## Summary

OpenWork lets users install **skills** (OpenPackage into `.opencode/skill`) and configure **plugins** (via `opencode.json`). Today those changes are visible on disk immediately, but the running OpenCode engine may not pick them up until the **current instance is disposed**.

This PRD adds a calm, premium UX affordance: a contextual **“Reload engine”** button that appears only when OpenWork detects changes that require an engine reload to take effect.

## Problem

Users can:

- add a plugin via the Plugins tab (writes `opencode.json`)
- install/import skills via the Skills tab (writes `.opencode/skill/*`)

…but the agent runtime is often “stale” until the engine reloads its instance:

- npm plugins are loaded/installed at instance startup
- agent skills can be cached by the instance (skill discovery/state)

So the user experiences:

- “I added it, but it doesn’t work”
- no clear feedback about what to do next

## Clarifying Terms

### “Skill added to `opencode.json`”

OpenCode’s config file (`opencode.json`) does **not** declare skills. It declares configuration such as providers/models and **plugins** via the `plugin` key.

In OpenWork UX, users often conflate “skills” (OpenPackage installs) with “plugins” (OpenCode plugins). This feature addresses both:

- **Plugin change**: `opencode.json` changed (project/global)
- **Skill change**: `.opencode/skill/**` changed

In both cases, the fix is the same: **dispose the current OpenCode instance** so the next request recreates it and reloads config/plugins/skills.

## Goals

- Make it obvious when a reload is required.
- Provide a one-click, safe “Reload engine” action.
- Avoid false positives (don’t nag constantly).
- Don’t break running sessions; keep user in control.
- Work across OpenWork’s modes:
  - Host mode (engine started by OpenWork)
  - Client mode (connected to remote engine)
  - Engine source PATH vs Sidecar (Host mode detail)

## Non-goals

- A full plugin installer UI (dependency management, version pins, etc.).
- Hot-reloading plugins/skills without instance disposal.
- Restarting the entire server process unless disposal fails (fallback only).

## Current Behavior (Baseline)

- Plugins tab mutates `opencode.json` via Tauri commands (`read_opencode_config` / `write_opencode_config`).
- Skills tab installs packages via `opkg_install` and reads `.opencode/skill/*/SKILL.md` via the server file API.
- OpenWork does **not** currently tell the engine that config/skill files changed.

## Proposed UX

### Where the reload affordance lives

A lightweight banner component shown in “engine-scoped” surfaces:

- Skills tab
- Plugins tab
- Settings (optional; if we want a central place)

Banner copy:

- Title: “Reload required”
- Body (reason-dependent):
  - Plugin: “OpenCode loads plugins on startup. Reload to apply `opencode.json` changes.”
  - Skill: “OpenCode caches skill state. Reload to make newly installed skills available.”

Buttons:

- Primary: **Reload engine**
- Secondary: Dismiss (hides banner until next change)

### Interaction flows

#### Flow A — Add plugin

1. User clicks “Add” on a plugin.
2. OpenWork writes updated `opencode.json`.
3. OpenWork shows banner: “Reload required to apply plugin changes.”
4. User clicks “Reload engine”.
5. OpenWork reloads the instance and refreshes:
   - providers/models
   - plugins list
   - skills list

#### Flow B — Install skill (OpenPackage)

1. User installs an OpenPackage source.
2. OpenWork refreshes the file list and shows the installed skill(s).
3. OpenWork shows banner: “Reload required to make skills available to the engine.”
4. User reloads.

#### Flow C — Active run

If any session is currently running (status `running` / `retry`):

- Banner still appears, but reload is **disabled** by default.
- Copy: “A run is in progress. Reloading may interrupt tool execution.”
- Actions:
  - Primary disabled: “Reload engine”
  - Secondary: “Reload anyway” (optional confirm modal)

MVP choice: disable reload while any session is running.

#### Flow D — Client mode safety

When in Client mode, OpenWork is connected to a server it does not own.

- Banner still appears (because config/skills changed in the workspace), but the reload button is gated:
  - If the user is connected to a *remote* host, disposing the instance may affect other clients.

MVP choice:

- Show “Reload engine” only in Host mode.
- In Client mode, show informational text: “Changes will apply after the host reloads.”

## Detection (Reliable, Minimal)

### “Reload needed” state

We track a `reloadRequired` flag with metadata:

- `reasons`: `plugin-config-changed` | `skills-changed`
- `detectedAt`: timestamp
- `scope`: project/global (for plugin changes)

### How we set it (MVP)

Set `reloadRequired = true` whenever OpenWork itself performs a write that we know requires reload:

- after successful `writeOpencodeConfig(...)`
- after successful `opkgInstall(...)`
- after successful `importSkill(...)`

This is reliable for the in-app workflow and avoids expensive filesystem polling.

### Optional: detect out-of-band edits (follow-up)

To catch users editing `opencode.json` in their editor:

- compute a cheap “desired fingerprint”:
  - `opencode.json` content hash (project/global)
  - `.opencode/skill` directory names + `SKILL.md` mtime/hash
- store the fingerprint at:
  - engine start
  - after reload
- compare periodically (e.g. when entering Skills/Plugins tab)

If mismatch, set `reloadRequired`.

## Reload Mechanism (Correct mapping to OpenCode)

OpenCode server docs expose:

- `POST /instance/dispose` (dispose current instance)

This is the correct “reload engine” primitive for this UX:

- sessions persist (stored in DB)
- the next request recreates the instance and reloads config/plugins/skills

### Proposed implementation

Preferred path (all modes):

1. Call `client.instance.dispose()` (SDK wrapper for `POST /instance/dispose`).
2. Poll `client.global.health()` until healthy.
3. Refresh UI state:
   - `client.config.providers()`
   - `refreshPlugins()`
   - `refreshSkills()`

Fallback path (Host mode only):

- If disposal fails, perform a hard restart:
  - `engineStop()` then `engineStart()` and reconnect.

## Acceptance Criteria

- After adding a plugin via OpenWork, user sees a “Reload required” banner.
- After installing/importing a skill via OpenWork, user sees the banner.
- Clicking “Reload engine” triggers instance disposal and then clears the banner.
- Reload is not offered while a session is actively running (MVP).
- In Client mode, the UI does not dispose remote instances (MVP).

## Open Questions

- Should we show plugin install progress after reload using `installation.updated` SSE events?
- Should reload be auto-triggered when idle (with a toast), instead of manual?
- Do we want to support Client mode reload behind a confirmation gate?

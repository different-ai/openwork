# AGENTS.md

OpenWork is an open-source alternative to Claude Cowork.

Read INFRASTRUCTURE.md

## Why OpenWork Exists

**Cowork is closed-source and locked to Claude Max.** We need an open alternative.
**Mobile-first matters.** People want to run tasks from their phones, including via messaging surfaces like WhatsApp and Telegram through owpenbot.
**Slick UI is non-negotiable.** The experience must feel premium, not utilitarian.

## Agent Guidelines for development

* **Purpose-first UI**: prioritize clarity, safety, and approachability for non-technical users.
* **Parity with OpenCode**: anything the UI can do must map cleanly to OpenCode tools.
* **Prefer OpenCode primitives**: represent concepts using OpenCode's native surfaces first (folders/projects, `.opencode`, `opencode.json`, skills, plugins) before introducing new abstractions.
* **Self-referential**: maintain a gitignored mirror of OpenCode at `vendor/opencode` for inspection.
* **Self-building**: prefer prompts, skills, and composable primitives over bespoke logic.
* **Open source**: keep the repo portable; no secrets committed.
* **Slick and fluid**: 60fps animations, micro-interactions, premium feel.
* **Mobile-native**: touch targets, gestures, and layouts optimized for small screens.

## Living Systems

OpenWork aims to be a **living system**: agents, skills, commands, and config are hot-reloadable while sessions are running. This enables agents to create new skills or update their own configuration and have changes take effect immediately, without tearing down active sessions.

Design principles for hot reload:

* **Conservative triggers**: only reload when a file that OpenCode reads at startup actually changes inside `.opencode/` or `opencode.json`. Ignore metadata files like `openwork.json`, `.DS_Store`, etc.
* **Workspace-scoped**: reload state is keyed per workspace. Switching workspaces never leaks reload signals from one workspace to another.
* **Session-aware**: when sessions are actively running, queue reload signals. Promote to visible reload (toast or auto-reload) only after all active sessions finish. This avoids interrupting in-flight tool calls.
* **Auto-reload setting**: each workspace can opt into automatic reload via `.opencode/openwork.json` (`reload.auto`). When enabled, the engine reloads automatically once queued signals are ready and no sessions are active.
* **Session continuity**: before reload, capture running session IDs, agents, and models. After reload, optionally relaunch those sessions so the user experiences seamless continuity.
* **Per-workspace isolation**: the desktop file watcher only watches the active workspace root and its `.opencode/` directory. The server reload event store is already keyed by `workspaceId`.

## Technology Stack

| Layer                | Technology                |
| -------------------- | ------------------------- |
| Desktop/Mobile shell | Tauri 2.x                 |
| Frontend             | SolidJS + TailwindCSS     |
| State                | Solid stores + IndexedDB  |
| IPC                  | Tauri commands + events   |
| OpenCode integration | Spawn CLI or embed binary |

## Repository Guidance

* Use `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`, `ARCHITECTURE.md`, and `INFRASTRUCTURE.md` to understand the "why" and requirements so you can guide your decisions.

## Dev Debugging

* If you change `packages/server/src`, rebuild the OpenWork server binary (`pnpm --filter openwork-server build:bin`) because `openwrk` runs the compiled server, not the TS sources.

## Local Structure

```
openwork/
  AGENTS.md                    # This file
  VISION.md                     # Product vision and positioning
  PRINCIPLES.md                 # Decision framework and guardrails
  PRODUCT.md                    # Requirements, UX, and user flows
  ARCHITECTURE.md               # Runtime modes and OpenCode integration
  .gitignore                    # Ignores vendor/opencode, node_modules, etc.
  .opencode/
  packages/
    app/
      src/
      public/
      pr/
      prd/
      package.json
    desktop/
      src-tauri/
      package.json
```

## OpenCode SDK Usage

OpenWork integrates with OpenCode via:

1.  **Non-interactive mode**: `opencode -p "prompt" -f json -q`
2.  **Database access**: Read `.opencode/opencode.db` for sessions and messages.

Key primitives to expose:

* `session.Service` — Task runs, history
* `message.Service` — Chat bubbles, tool calls
* `agent.Service` — Task execution, progress
* `permission.Service` — Permission prompts
* `tools.BaseTool` — Step-level actions

## Safety + Accessibility

* Default to least-privilege permissions and explicit user approvals.
* Provide transparent status, progress, and reasoning at every step.
* WCAG 2.1 AA compliance.
* Screen reader labels for all interactive elements.

## Performance Targets

| Metric                 | Target         |
| ---------------------- | -------------- |
| First contentful paint | <500ms         |
| Time to interactive    | <1s            |
| Animation frame rate   | 60fps          |
| Interaction latency    | <100ms         |
| Bundle size (JS)       | <200KB gzipped |

## Skill: SolidJS Patterns

When editing SolidJS UI (`packages/app/src/**/*.tsx`), consult:

* `.opencode/skills/solidjs-patterns/SKILL.md`

This captures OpenWork’s preferred reactivity + UI state patterns (avoid global `busy()` deadlocks; use scoped async state).

## Skill: Trigger a Release

OpenWork releases are built by GitHub Actions (`Release App`). A release is triggered by pushing a `v*` tag (e.g. `v0.1.6`).
`Release App` can also publish openwrk sidecars and npm packages when enabled via workflow inputs or repo vars (`RELEASE_PUBLISH_SIDECARS`, `RELEASE_PUBLISH_NPM`).

### Standard release (recommended)

1.  Ensure `main` is green and up to date.
2.  Bump versions (keep these in sync):

* `packages/app/package.json` (`version`)
* `packages/desktop/package.json` (`version`)
* `packages/headless/package.json` (`version`, publishes as `openwrk`)
* `packages/desktop/src-tauri/tauri.conf.json` (`version`)
* `packages/desktop/src-tauri/Cargo.toml` (`version`)

You can bump all three non-interactively with:

* `pnpm bump:patch`
* `pnpm bump:minor`
* `pnpm bump:major`
* `pnpm bump:set -- 0.1.21`

3.  Merge the version bump to `main`.
4.  Create and push a tag:
    * `git tag vX.Y.Z`
    * `git push origin vX.Y.Z`

This triggers the workflow automatically (`on: push.tags: v*`).

### Re-run / repair an existing release

If the workflow needs to be re-run for an existing tag (e.g. notarization retry), use workflow dispatch:

* `gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z`

### Verify

* Runs: `gh run list --repo different-ai/openwork --workflow "Release App" --limit 5`
* Release: `gh release view vX.Y.Z --repo different-ai/openwork`

Confirm the DMG assets are attached and versioned correctly.

## Skill: Publish openwrk (npm)

This is usually covered by `Release App` when `publish_sidecars` + `publish_npm` are enabled. Use `.opencode/skills/openwrk-npm-publish/SKILL.md` for manual recovery or one-off publishing.

1.  Ensure the default branch is up to date and clean.
2.  Bump `packages/headless/package.json` (`version`).
3.  Commit the bump.
4.  Build and upload sidecar assets for the same version tag:
    * `pnpm --filter openwrk build:sidecars`
    * `gh release create openwrk-vX.Y.Z packages/headless/dist/sidecars/* --repo different-ai/openwork`
5.  Publish:
    * `pnpm --filter openwrk publish --access public`
6.  Verify:
    * `npm view openwrk version`

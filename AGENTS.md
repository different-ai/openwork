# AGENTS.md

OpenWork is an open-source alternative to Claude Cowork. 

## Why OpenWork Exists

**Cowork is closed-source and locked to Claude Max.** We need an open alternative.
**Mobile-first matters.** People want to run tasks from their phones.
**Slick UI is non-negotiable.** The experience must feel premium, not utilitarian.

## Agent Guidelines for development

- **Purpose-first UI**: prioritize clarity, safety, and approachability for non-technical users.
- **Parity with OpenCode**: anything the UI can do must map cleanly to OpenCode tools.
- **Prefer OpenCode primitives**: represent concepts using OpenCode’s native surfaces first (folders/projects, `.opencode`, `opencode.json`, skills, plugins) before introducing new abstractions.
- **Self-referential**: maintain a gitignored mirror of OpenCode at `vendor/opencode` for inspection.
- **Self-building**: prefer prompts, skills, and composable primitives over bespoke logic.
- **Open source**: keep the repo portable; no secrets committed.
- **Slick and fluid**: 60fps animations, micro-interactions, premium feel.
- **Mobile-native**: touch targets, gestures, and layouts optimized for small screens.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Desktop/Mobile shell | Tauri 2.x |
| Frontend | SolidJS + TailwindCSS |
| State | Solid stores + IndexedDB |
| IPC | Tauri commands + events |
| OpenCode integration | Spawn CLI or embed binary |

## Repository Guidance

- Write new PRDs under `apps/desktop/pr/<prd-name>.md` (see `.opencode/skill/prd-conventions/SKILL.md`).
- Use MOTIVATIONS-PHILOSOPHY.md to understand the "why" of OpenWork so you can guide your decisions.


## Local Structure

```
openwork/
  AGENTS.md                    # This file
  MOTIVATIONS-PHILOSOPHY.md     # Exhaustive PRD and user flow map
  .gitignore                    # Ignores vendor/opencode, node_modules, etc.
  .opencode/
  apps/
    desktop/
      src/
      public/
      pr/
      prd/
      package.json
  packages/
    tauri/
      src-tauri/
      package.json
```

## OpenCode SDK Usage

OpenWork integrates with OpenCode via:

1. **Non-interactive mode**: `opencode -p "prompt" -f json -q`
2. **Database access**: Read `.opencode/opencode.db` for sessions and messages.

Key primitives to expose:
- `session.Service` — Task runs, history
- `message.Service` — Chat bubbles, tool calls
- `agent.Service` — Task execution, progress
- `permission.Service` — Permission prompts
- `tools.BaseTool` — Step-level actions

## Safety + Accessibility

- Default to least-privilege permissions and explicit user approvals.
- Provide transparent status, progress, and reasoning at every step.
- WCAG 2.1 AA compliance.
- Screen reader labels for all interactive elements.

## Performance Targets

| Metric | Target |
|--------|--------|
| First contentful paint | <500ms |
| Time to interactive | <1s |
| Animation frame rate | 60fps |
| Interaction latency | <100ms |
| Bundle size (JS) | <200KB gzipped |

## Skill: SolidJS Patterns

When editing SolidJS UI (`apps/desktop/src/**/*.tsx`), consult:

- `.opencode/skill/solidjs-patterns/SKILL.md`

This captures OpenWork’s preferred reactivity + UI state patterns (avoid global `busy()` deadlocks; use scoped async state).

## Skill: Trigger a Release

OpenWork releases are built by GitHub Actions (`Release App`). A release is triggered by pushing a `v*` tag (e.g. `v0.1.6`).

### Standard release (recommended)

1. Ensure `main` is green and up to date.
2. Bump versions (keep these in sync):
- `apps/desktop/package.json` (`version`)
- `packages/tauri/package.json` (`version`)
- `packages/tauri/src-tauri/tauri.conf.json` (`version`)
- `packages/tauri/src-tauri/Cargo.toml` (`version`)

You can bump all three non-interactively with:
- `pnpm bump:patch`
- `pnpm bump:minor`
- `pnpm bump:major`
- `pnpm bump:set -- 0.1.21`

3. Merge the version bump to `main`.
4. Create and push a tag:
   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`

This triggers the workflow automatically (`on: push.tags: v*`).

### Re-run / repair an existing release

If the workflow needs to be re-run for an existing tag (e.g. notarization retry), use workflow dispatch:

- `gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z`

### Verify

- Runs: `gh run list --repo different-ai/openwork --workflow "Release App" --limit 5`
- Release: `gh release view vX.Y.Z --repo different-ai/openwork`

Confirm the DMG assets are attached and versioned correctly.

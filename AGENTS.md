# AGENTS.md

OpenWork exists to bring OpenCode's agentic power to non-technical people through an accessible, transparent **native GUI**. It is an open-source competitor to Anthropic's Cowork and must stay faithful to OpenCode's principles: self-building, self-referential, standards-first, and graceful degradation.

## Why OpenWork Exists

1. **OpenCode is powerful but terminal-only.** Non-technical users can't access it.
2. **Cowork is closed-source and locked to Claude Max.** We need an open alternative.
3. **Mobile-first matters.** People want to run tasks from their phones.
4. **Slick UI is non-negotiable.** The experience must feel premium, not utilitarian.

## Core Expectations

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

- Always read `design-prd.md` at session start for product intent and user flows.
- Write new PRDs under `pr/<prd-name>.md` (see `.opencode/skill/prd-conventions/SKILL.md`).
- Keep `design-prd.md` and `.opencode/skill/*/SKILL.md` updated when behavior changes.
- Use `.opencode/skill/` for repeatable workflows and domain vocabulary.

## Local Structure

```
apps/openwork/
  AGENTS.md           # This file
  design-prd.md       # Exhaustive PRD and user flow map
  .gitignore          # Ignores vendor/opencode, node_modules, etc.
  .opencode/
    skill/            # Skills for product workflows
  vendor/
    opencode/         # Gitignored OpenCode mirror for self-inspection
  src-tauri/          # Rust backend (Tauri)
  src/                # SolidJS frontend
  package.json        # Frontend dependencies
  Cargo.toml          # Rust dependencies
```

## OpenCode SDK Usage

OpenWork integrates with OpenCode via:

1. **Non-interactive mode**: `opencode -p "prompt" -f json -q`
2. **Database access**: Read `.opencode/opencode.db` for sessions and messages.
3. **MCP bridge**: OpenWork as an MCP server for real-time permissions and streaming.

Key primitives to expose:
- `session.Service` — Task runs, history
- `message.Service` — Chat bubbles, tool calls
- `agent.Service` — Task execution, progress
- `permission.Service` — Permission prompts
- `tools.BaseTool` — Step-level actions

## Safety + Accessibility

- Default to least-privilege permissions and explicit user approvals.
- Provide transparent status, progress, and reasoning at every step.
- Use progressive disclosure for advanced controls.
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

When editing SolidJS UI (`src/**/*.tsx`), consult:

- `.opencode/skill/solidjs-patterns/SKILL.md`

This captures OpenWork’s preferred reactivity + UI state patterns (avoid global `busy()` deadlocks; use scoped async state).

## Skill: Trigger a Release

OpenWork releases are built by GitHub Actions (`Release App`) and publish signed + notarized macOS DMGs to the GitHub Release for a tag.

### Standard release (recommended)

1. Bump versions (at minimum `apps/openwork/package.json`, and keep Tauri/Rust versions in sync).
2. Merge to `main`.
3. Create and push a version tag:

   - `git tag vX.Y.Z`
   - `git push origin vX.Y.Z`

This triggers the workflow automatically (`on: push.tags: v*`).

### Re-run / repair an existing release

If the workflow needs to be re-run for an existing tag (e.g. notarization retry), use workflow dispatch:

- `gh workflow run "Release App" --repo different-ai/openwork -f tag=vX.Y.Z`

### Verify

- `gh run list --repo different-ai/openwork --workflow "Release App" --limit 5`
- `gh release view vX.Y.Z --repo different-ai/openwork`

Confirm the DMG assets are attached and versioned correctly.

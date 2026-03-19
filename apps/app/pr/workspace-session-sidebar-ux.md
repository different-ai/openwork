# Workspace shell sidebar UX

## Summary

- keeps the workspace right rail visible on both session and dashboard surfaces, defaulting to a compact icon-only state
- adds a draggable resize handle for the left workspace column on desktop breakpoints
- makes the status bar settings cog act like a toggle so a second click returns to the previous screen

## Evidence

- `packages/app/pr/screenshots/workspace-session-sidebar-ux/session-right-sidebar-collapsed.png`
- `packages/app/pr/screenshots/workspace-session-sidebar-ux/dashboard-right-sidebar-collapsed.png`
- `packages/app/pr/screenshots/workspace-session-sidebar-ux/session-right-sidebar-expanded.png`
- `packages/app/pr/screenshots/workspace-session-sidebar-ux/session-left-sidebar-resized.png`
- `packages/app/pr/screenshots/workspace-session-sidebar-ux/settings-open-from-session.png`
- `packages/app/pr/screenshots/workspace-session-sidebar-ux/settings-toggle-returned-session.png`

## Verification

- `pnpm typecheck`
- `pnpm build:ui`
- local Playwright smoke against `http://localhost:4173`

## Docker blocker

- `packaging/docker/dev-up.sh` failed before the stack came up because Docker could not read the `node:22-bookworm-slim` image blob from containerd (`input/output error`)

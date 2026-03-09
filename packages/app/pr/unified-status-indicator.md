# Unified Status Bar Indicator

**Branch:** `dev`
**Priority:** P2

---

## Goal

Replace the two separate status indicators (OpenCode Engine + OpenWork Server) in the status bar with a single unified indicator that opens a detail popover on click.

---

## Problem

The status bar shows two icons with individual colored dots, exposing internal architecture details users don't need at a glance. Users just want to know if everything is working.

---

## Implementation

### Files changed
- `packages/app/src/app/components/status-bar.tsx` — main changes
- `packages/app/src/app/pages/dashboard.tsx` — pass `startupPreference` prop
- `packages/app/src/app/pages/session.tsx` — pass `startupPreference` prop
- `packages/app/src/app/app.tsx` — pass `startupPreference` to session props

### Changes

1. **Unified status signal** — combines `clientConnected` and `openworkServerStatus` into a single computed: green/"Ready" only when both are healthy, red/"Unavailable" otherwise.

2. **Single clickable indicator** — replaces the two separate icon+dot pairs with one dot + text label.

3. **Detail popover** — clicking the indicator opens a popover showing per-service status rows (OpenCode Engine, Local/Remote Server) with individual colored dots and labels. Closes on outside click.

4. **Local vs Remote label** — uses `startupPreference` to show "Local Server" or "Remote Server" in the popover.

---

## Testing

- [x] `pnpm --filter @different-ai/openwork-ui typecheck` passes
- [ ] Manual: single indicator shows green "Ready" when both services healthy
- [ ] Manual: shows red "Unavailable" when either service is down
- [ ] Manual: click opens popover with per-service breakdown
- [ ] Manual: popover closes on outside click
- [ ] Manual: shows "Local Server" or "Remote Server" based on preference

# OpenWork 10x Audit Research

**Date:** 2026-02-03
**Scope:** App UI, session/workspace state, background polling

---

## Context

OpenWork is an open-source alternative to Claude Cowork. It is mobile-first, premium-feeling, and a thin UI layer on top of OpenCode primitives. Target users include:

- Bob (IT/power user) who already uses OpenCode and wants to share workflows.
- Susan (non-technical) who wants a polished experience that just works.

---

## Audit summary

The core experience is strong, but several stale-data issues, debug artifacts, and UI inconsistencies prevent the app from feeling "10x" premium and trustworthy. Most fixes are localized and can be split into atomic worktrees.

---

## Findings and opportunities

### 1) Dashboard tab refresh runs only once per tab
- Evidence: `packages/app/src/app/pages/dashboard.tsx:295-421`
- Impact: Skills, plugins, MCP, and scheduled tasks can go stale after the first visit.
- Potential fix: Track per-tab refresh timestamps and refresh on tab revisit after a TTL; add an explicit refresh action.

### 2) Debug logging left in production UI flows
- Evidence: `packages/app/src/app/pages/dashboard.tsx:537` (debug pointer log), `packages/app/src/app/context/workspace.ts:667-671`, `packages/app/src/app/context/session.ts:349-365`
- Impact: Noise in console, potential leakage of workspace info in production logs.
- Potential fix: Gate logging behind `developerMode()` or remove entirely.

### 3) Step cluster collapse does not collapse related steps
- Evidence: `packages/app/src/app/components/session/message-list.tsx:99-113`
- Impact: "Hide steps" behaves inconsistently for clustered step groups.
- Potential fix: When collapsing, add related step IDs to the collapsed set instead of removing them.

### 4) Session sidebar truncates sessions without a "show more"
- Evidence: `packages/app/src/app/components/session/sidebar.tsx:348-394`
- Impact: Users cannot access older sessions from the sidebar.
- Potential fix: Add "Show all" or "View more" with a count; link to Sessions tab.

### 5) Session context menu placement is hard-coded
- Evidence: `packages/app/src/app/components/session/sidebar.tsx:174-188`
- Impact: Menu can overflow or mis-position with localization or font changes.
- Potential fix: Measure actual menu size and clamp to viewport at render time.

### 6) Background polling is always on
- Evidence: `packages/app/src/app/app.tsx:340-510`, `packages/app/src/app/components/status-bar.tsx:160-174`
- Impact: Unnecessary network work and battery drain, especially when hidden.
- Potential fix: Use `document.visibilityState` to pause intervals; consolidate polling with backoff when disconnected.

### 7) Blocking browser prompts in primary flows
- Evidence: `packages/app/src/app/app.tsx:1231-1243` (model variant), `packages/app/src/app/pages/session.tsx:739-756` (delete confirm), `packages/app/src/app/pages/session.tsx:1016-1039` (agent prompt)
- Impact: Inconsistent UI, poor mobile behavior, breaks flow.
- Potential fix: Replace with in-app modals or inline confirmations.

### 8) Mention search results can race
- Evidence: `packages/app/src/app/components/session/composer.tsx:736-750`
- Impact: Stale results can surface if earlier search resolves after a newer query.
- Potential fix: Add request tokens or abort controllers to discard stale results.

### 9) Stale sessions for inactive workspaces
- Evidence: `packages/app/src/app/pages/session.tsx:673-685`
- Impact: Sidebar workspace groups show outdated sessions until the workspace is re-activated.
- Potential fix: Refresh sessions per workspace on demand or group from a global session list keyed by directory.

### 10) OpenWork server checks have no disconnect backoff
- Evidence: `packages/app/src/app/app.tsx:340-370`
- Impact: Repeated failures while disconnected; noisy and wasteful.
- Potential fix: Apply exponential backoff or suspend checks until the user changes connection settings.

---

## Notes

- `ISSUES.md` was not found in the repo; no centralized issue list to reference.

---

## Proposed 10x themes

- Freshness: fix stale data and refresh behavior.
- Trust: remove debug artifacts and avoid blocking prompts.
- Performance: pause background polling when hidden.
- Discoverability: surface older sessions and state changes clearly.

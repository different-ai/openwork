# OpenWork 10x Quality Pass

**Priority:** P0
**Related research:** `packages/app/pr/openwork-10x-audit.md`

---

## Summary

Deliver a focused quality pass that makes OpenWork feel 10x more premium and reliable by fixing stale data, removing debug artifacts, reducing background polling, and smoothing core session flows. Changes are intentionally small and atomic, aligned to OpenCode primitives and mobile-first UX.

---

## Problems

1. Data goes stale across dashboard tabs and workspace lists.
2. Debug logs and blocking prompts undermine a premium UX.
3. Background polling is wasteful when the app is hidden or disconnected.
4. Sidebar session navigation is truncated and inconsistent.

---

## Goals

- Keep sessions, skills, plugins, MCPs, and scheduled tasks fresh without heavy polling.
- Remove or gate debug artifacts in production flows.
- Replace blocking browser prompts with in-app UI.
- Improve session navigation and sidebar discoverability.

---

## Non-goals

- No new backend endpoints.
- No redesign of the overall layout or visual language.
- No changes to OpenCode APIs or engine behavior.

---

## Personas

- **Bob (IT/power user):** expects reliability, speed, and full visibility.
- **Susan (non-technical):** needs clarity, confidence, and minimal friction.

---

## Scope (atomic workstreams)

Each item should be implemented in its own worktree and then merged into a single PR.

1. **Dashboard refresh TTL + manual refresh**
   - Add per-tab refresh timestamps; refresh when re-entering a tab after a TTL.
   - Add a small refresh action for Skills, Plugins, MCP, Scheduled.

2. **Remove or gate debug logs**
   - Strip `console.log` calls in Dashboard, Session store, Workspace store.
   - Allow optional logging only when `developerMode()` is true.

3. **Fix step cluster collapse behavior**
   - Ensure related step IDs are collapsed together in MessageList.

4. **Session sidebar "Show more"**
   - Provide a visible affordance when sessions exceed the current cap.
   - Route to Sessions tab or expand inline.

5. **Context menu positioning**
   - Replace hard-coded menu dimensions with measured bounds.
   - Clamp to viewport to avoid overflow.

6. **Visibility-aware polling**
   - Pause polling intervals when document is hidden.
   - Resume when visible; apply backoff for disconnected states.

7. **Replace blocking prompts**
   - Swap `window.confirm` / `window.prompt` usage for in-app modals.
   - Maintain keyboard accessibility and mobile layout.

8. **Mention search race guard**
   - Add request tokens or abort logic to discard stale results.

9. **Inactive workspace session freshness**
   - Refresh per-workspace sessions when workspace list changes or on demand.
   - Avoid expensive global reloads.

10. **OpenWork server check backoff**
   - When disconnected, use exponential backoff or pause until settings change.

---

## Acceptance criteria

- Switching back to a dashboard tab after a TTL refreshes data without a full reload.
- No debug logs appear unless developer mode is enabled.
- "Hide steps" collapses all related steps in a cluster consistently.
- Sidebar shows a clear path to older sessions.
- Context menu never renders off-screen.
- Polling pauses while the app is hidden and resumes on focus.
- No browser-native prompts are used in session flows.
- Mention search never shows stale results after rapid typing.
- Session lists for inactive workspaces are not stale for long-lived sessions.
- OpenWork server checks do not spam when disconnected.

---

## Success metrics

- < 100ms input-to-feedback on session and dashboard actions.
- 0 stale-dashboard regressions in repeated navigation.
- Reduced background polling traffic when hidden.

---

## Risks and mitigations

- **Risk:** Reduced polling may hide state updates.
  - **Mitigation:** Use TTL-based refresh and manual refresh action.
- **Risk:** Modal additions slow delivery.
  - **Mitigation:** Reuse existing modal components and patterns.

---

## Validation

- Manual: navigate between tabs, verify refresh TTL and manual refresh.
- Manual: create/delete sessions, verify sidebar navigation.
- Manual: verify no console noise in non-developer mode.
- Optional: Chrome MCP smoke test for session and dashboard flows.

# Chat, Artifacts and Automation schedules: GA status

## Scope

Six rollout keys are retired. Their product checks and old UI branches are gone; published clients still receive each key as a fixed `true` (response-only compatibility), and legacy operator, organization and member overrides are accepted and ignored.

| Feature | Former key | Where it now lives |
| --- | --- | --- |
| Model on the Working line while a reply streams | `liveReplyModel` | `message-list.tsx` (`LoadingMessage`), v2 model forwarding in `opencode-v2-adapter.ts` |
| Agents list above the composer | `composerSubagentTracker` | `composer-subagent-tracker.tsx`, `agent-tracker-row.tsx` |
| Text-first chat activity | `textActivityRail` | `activity-rail.tsx`, `text-tool-aggregate-group.tsx`, `github-references.ts` |
| List-first Artifacts with retained live views | `artifactsListFirst` | `artifacts-page.tsx`, `retained-artifact-surface.tsx`, `built-app-pin-button.tsx` |
| Every-few-hours Automation schedules | `automationIntervalSchedules` | graduated on `dev` by #6774; this branch removes no further code |
| Automations before/after Google Calendar meetings | `automationCalendarTriggers` | graduated on `dev` by #6774; this branch removes the leftover always-on per-owner enable hook |

Calendar triggers remain Cloud-only and need a connected Google Calendar with calendar access; an unreadable calendar puts the Automation in "needs attention". Old-client schedule-kind negotiation is unchanged. No production data is changed and historical feature-usage rows are kept.

## Changes found during review

- On OpenCode v2 the Working-line hover showed no model while a reply streamed: v2 names the model only on `session.step.started`, which the adapter dropped. Fixed; `apps/app/tests/live-reply-model-v2.test.ts` fails without the fix and passes with it.
- The text-activity proof fixture used v1 argument names for v2 `write`/`edit` (`path` is required) and pressed Escape to leave the Settings page. Both fixed; the proof's assertions are unchanged.
- Rebased onto `dev` after #6774, #6790 and #6792 landed overlapping work; `dev`'s Automation and Agents-list code was kept.
- `workbot-luna-default.api.test.ts` was red on `dev` f72b0a48c1 (clean control, same failure): with the Gateway unreadable, Workbot default readiness read `unavailable` instead of `unverified`. Fixed in `workbot/model.ts`; all Workbot API tests pass.

## Verification (local, Node 24.22.1, OpenCode v2 2.2.0 pinned)

- App typecheck, Den API typecheck, `pnpm features:check`: pass.
- App unit tests for the touched areas (run per file): pass.
- Den API: feature-response, calendar-trigger source, interval/calendar/feature-outcomes API tests, all Workbot API and unit tests: pass.
- Headless proofs with no rollout overrides: text-activity-rail passes locally and in CI; artifacts-list-first and composer-subagent-tracker pass in CI.

## Not covered

- Real-product recordings could not show the Agents list "needs you" state with Review: on v2 the general helper is not offered the `question` tool, and the fixture's command-approval rule did not reach helpers. Review is covered by the composer-subagent-tracker proof, which drives those states through a development-only control.
- A real Google Calendar connection was not available in the isolated test organization, so no meeting-triggered run was recorded.
- The production effective-state comparison (deployment defaults, rollout and kill state, organization and member overrides) was not run.

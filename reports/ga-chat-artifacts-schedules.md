# Chat, artifacts and Automation schedules: GA handoff

## Scope

Retire these six rollout keys, remove their product checks and old UI branches, keep fixed-true response-only compatibility for published clients, and ignore legacy operator/organization/member overrides:

- `liveReplyModel`
- `composerSubagentTracker`
- `textActivityRail`
- `artifactsListFirst`
- `automationIntervalSchedules`
- `automationCalendarTriggers`

The first three implementations were already on the newer `origin/dev` baseline. This branch also carries the list-first Artifacts implementation and its test follow-up from the existing feature branch. The original workspace's unrelated uncommitted changes were not copied or modified.

Calendar triggers remain Cloud-only and require a connected Google Calendar. Existing Automation authority, placement and old-client schedule-kind negotiation remain enforced. No production data was changed. Historical feature records are not deleted.

## Verification before remote handoff

- `pnpm typecheck`: passed on Node 24.22.1.
- `pnpm features:check`: passed.
- `pnpm --filter @openwork/features test`: 22 passed, no skips.
- API-first feature response compatibility: 2 passed.
- Focused chat/activity/composer unit tests: 50 passed across 8 files (subagent).
- Artifact creation-row: 7 passed; pinning: 8 passed; artifacts page: 9 passed.
- Backend calendar-source, interval/calendar API, model-authority and availability checks: 19 passed (subagent; its Node 24.15 run emitted engine warnings; rerun under supported Node for final evidence).
- Feature outcomes unit: 7 passed; frontend feature-usage model: 7 passed (subagent).
- Feature outcomes API: 6 passed on Node 24.22.1 with an isolated MySQL 8.4 container.
- Evals lint: 124 files, no errors; evals typecheck: 477 files passed (subagent, before the final text-rail proof adjustment).
- Headless product proofs, each cold booted with no schedule/artifact/chat rollout overrides: automation-schedule-triggers, artifacts-list-first, composer-subagent-tracker each passed (1 test each, no skips).
- `git diff --check`: passed.

### Unfinished verification

The text-activity-rail product proof is not green yet. Initial fixture attempted a native `openwork_query` tool that is now Code Mode-only; the fixture now invokes it through `execute`. The next run reached a rendered text-first summary and two inline OpenWork marks, but failed its expected visible `Thought` row (reasoning is off by default). The proof now explicitly enables **Show model reasoning** through Settings before the task; that version was not verified before handoff. The earlier screenshot also showed three failed local tool steps, so inspect the fixture's current v2 read/edit argument shapes and technical details instead of weakening assertions. Do not claim this is pre-existing without running a clean control.

No before/after baseline proof has been run yet. Overall verification remains **Incomplete** until the outstanding proof, remote review, and video evidence are complete.

## Continue on the requested remote machine/model

Use the exact pushed branch and commit; preserve unrelated remote work using a fresh worktree. Verify the session is actually running Claude Opus 5.5, not a default or fallback model. Review changes and fix any defects with meaningful tests. Re-run final checks on the final tree.

Record six separate real-product videos, one for each scope item above. Demonstrate the behavior without enabling its retired flag. Keep screens legible, use generic fixture data, show real interactions and outcomes, and do not represent static screenshots or simulated motion as a real recording. Capture the streaming hover while the turn is still active, Agents list states and actions, text activity and expanded output, list-first artifact opening/pinning/retained state, interval schedule creation, and Cloud-only meeting trigger creation with connected-calendar behavior. Report any unavailable prerequisite honestly. Review every video before sharing and provide a manifest with the commit, runtime/model identity, check verdicts, and video paths/links. Do not merge or deploy without further instruction.

## Deployment / rollback notes

API-first upgrade is supported by fixed true compatibility keys in `feature-response.ts`; newer clients need no rollout keys. Retired Helm settings are accepted-and-ignored with warnings. Deploy the API and compatible desktop/web clients; no destructive data migration is required. Rollback is a code revert, not a retired kill switch. Before deployment, finish a read-only effective-state comparison (deployment defaults, rollout/kill state, organization and member overrides) and check that no unrelated authorization or runtime prerequisites changed. Production dry-run discovery was started but was not completed in this session.

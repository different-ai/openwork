# Headless creation: false startup receipt and delayed sidebar insertion

Date: 2026-09-12. Investigation base: `91a7459a6` (reported installed build: `0.18.47-alpha.2966`, reported dev base: `e1cf5e74f`).

**Overall verdict: Incomplete.** The server receipt/error-preservation fix is implemented and has targeted proof. The sidebar event gap is confirmed, but a safe all-workspace live transport fix is not included. Do not treat the prototype's tests as proof of a sidebar fix in this branch.

## Evidence boundary and timeline

Only app `session.*` affordances were used to inspect the person's sessions. No engine database, credentials, private configuration, or transcripts were copied into this report. A/B below identify the two sessions supplied in the task; titles and prompt contents are intentionally omitted.

| EDT | Observation |
| --- | --- |
| 16:45:18.307 / .310 | A/B created, according to `session.read.createdAt`. |
| 16:45:19.487 / .493 | Last updates. Both contain one user message and no assistant response. |
| 16:45–17:00 | Person reports neither row appeared initially; parent reported two sessions running. |
| 17:08 | Requester's re-read still finds one message each and unchanged timestamps. |
| 17:10 refinement | Person confirms rows appeared later, without a known trigger. Symptom is delayed insertion, not permanent loss. |
| 18:11 onward | Our `session.list_sessions` finds both in loaded inventory, `working:false`, UI status `error`. `session.read` finds `archived:false`, engine status `idle`, unchanged timestamps and only the user prompt. Both retain the requested local-provider/model binding. |
| Later title/phrase search | `session.search` also finds both originals. ID searches and the literal query `ses` did not enumerate them; search matches title/transcript text, not an inventory wildcard. |

A completed sibling in the same workspace used the same local provider ID but a different model and had six messages including an assistant conclusion. This disproves neither current configuration drift nor model-specific unavailability. The exposed affordances contain no workspace provider-catalog/configuration query. **Current availability of the requested model, its credentials, and the exact asynchronous inference error remain unverified.** The status difference is expected to be possible: UI status retains an observed error while engine activity can return to idle. We did not rerun either original. A later search found separately created relaunch sessions; those were not created by this investigation.

## Symptom 2: false `started:true`

Confirmed contract defect, not confirmed cause of the underlying provider failure.

At the base, `apps/server/src/opencode-plugins/openwork-extensions-preview.ts:1115–1122` awaited `POST .../prompt_async`, then unconditionally returned `started:true`. The pinned engine's asynchronous route forks the prompt effect, reports a subsequent error through `session.error`, and returns 204 before inference completes or necessarily begins (engine v1.18.30, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:316–328`, inspected during investigation).

Thus a user-only session can be a genuinely accepted asynchronous request that fails before an assistant message. It is inaccurate to say that every rejected HTTP request was swallowed and still returned `started:true`: direct HTTP rejection already entered the catch. However, `affordanceResult` discarded the detailed failure/partial-result payload and exposed only a generic error. These are distinct failure phases.

`0ff2389e2` (#4917) forwarded the model into creation and the first prompt and proved reasoning-effort propagation with a working provider. Model binding is not capability validation. `cc4521467` (#4920) widened/advertised introspection and workspace arguments; it did not change asynchronous acceptance into a startup acknowledgement.

### Included fix

- `openwork-extensions-preview.ts:1127`: replaces `started:true` with **`accepted:true`**. This is an intentional receipt-field change; no speculative polling or startup guarantee is introduced.
- `:1029`: preserve nested engine error messages as well as top-level messages.
- `:1136–1163`: indexed `issues[]` identify create-versus-prompt failure and preserve any already-created session ID.
- `:253`: failure envelope retains accepted siblings and failed entries under `result`, so callers can inspect rather than blindly duplicate work.
- `apps/server/src/opencode-plugins/openwork-provider-adapters.ts:181`: descriptor explicitly distinguishes acceptance from inference, warns that an unavailable model may fail afterward, and instructs inspection before retrying.

This does **not** turn a later provider error into a synchronous `model_unavailable_in_workspace` issue. That would require an authoritative engine acceptance/startup or activity-error contract. The new `issues[]` reports errors actually returned by the request rather than guessing availability from an ID or claiming a later failure was observed.

## Symptom 1: delayed sidebar insertion

Confirmed code-level subscription gap, reproduced in an isolated headless browser during investigation. No assistant-message filter is needed to explain it.

Base/current sidebar paths (unchanged in this branch):

- Selected-workspace inventory callbacks are wired in `apps/app/src/react-app/shell/session-route.tsx:3389`.
- `use-workspace-route-state.ts:249,392` tracks inventories already loaded; `:598` supplies those to refresh planning. `route-refresh-control.ts:229` excludes healthy loaded inventories from routine reloads.
- `use-workspace-route-state.ts:743–786` applies created/updated/deleted events only to the selected workspace. The non-selected workspace has no corresponding inventory callback subscription.
- `39299d7a3` (#4934 after #4889) restores offline clearing of `loadedWorkspaceIdsRef` (`:557`), not background live subscriptions.

### Which later action can reveal the row?

| Trigger | Code behavior |
| --- | --- |
| Select the workspace | Refetches even an already-loaded inventory: `use-workspace-route-state.ts:726–740`. |
| Explicit `workspace.reload_sessions` | Targeted refetch: `session-route.tsx:3305`; `use-workspace-route-state.ts:455`. Headless creation requests this after all create/prompt attempts settle: `openwork-extensions-preview.ts:1149`. |
| Window focus | No direct inventory-refetch listener in this hook. |
| Page becomes visible | Route refresh (`use-workspace-route-state.ts:846–856`), but healthy loaded inventories remain cached. |
| 15-second timer | Checks engine routing (`:1071`); a routing/scope change invalidates and reloads inventories (`:1092`), not unconditional periodic inventory refresh. |
| Initially empty inventory | One delayed three-second retry (`:416`). |
| Parent calls `session.list_sessions` | Reads loaded state; no refetch: `domains/session/control/session-control-actions.ts:113`. |

**Historical attribution remains unknown.** The transcript and current inventory cannot tell whether selection, explicit reload delivery, initial retry, or routing invalidation caused these specific rows to appear. No fabricated focus/timer/list call attribution is made.

### Why the candidate sidebar fix was withdrawn

An initial small patch subscribed each non-selected workspace through `ensureWorkspaceSessionSync` and preserved user-only sessions. Five hook cases (including v1/v2 routing) and a real two-workspace local headless test passed. Removing subscriptions produced four hook failures; the browser row remained absent for the ten-second negative-control assertion.

Review then found an omitted dimension: these are long-lived browser HTTP/1.1 streams. With many workspaces, one stream per workspace exhausts the per-origin connection budget and can block lists, prompts, and health requests. An eight-workspace negative control reproduced starvation (four inventories still empty after 45 seconds).

A generic multiplex prototype passed an eight-workspace test but review found unresolved cancellation through actual engine proxy streams, silent reconnect gaps across healthy channels, and compatibility with older servers. It was removed along with the unsafe subscription patch. No transport change is included in this PR.

Safe follow-up should use an authenticated inventory-specific projection, explicit reconnection reconciliation, bounded connection ownership and legacy compatibility. Native pooled v1 has directory-attributed `/global/event` (see `apps/server/src/thread-approvals.ts:246–297`), but native v2 and older-server behavior must be proven rather than assumed equivalent. Bounded polling could contain the delay but does not meet the requested live-insertion criterion.

## Coverage matrix / negative space

| Case | Prior coverage gap | This branch |
| --- | --- | --- |
| Valid model + effort forwarded | #4917 tested functioning provider | Existing coverage retained. |
| Create with model target workspace cannot serve | No distinction between HTTP rejection and 204 followed by asynchronous failure | Rejecting-engine unit and testkit witness verify detailed HTTP issue, retained ID, accepted-only/user-only sibling, working sibling, no retry. Not proof of the original provider's error. |
| Partial create/prompt failure | Envelope lost detailed result | Indexed create/prompt issues and accepted siblings asserted. |
| Create into non-selected loaded workspace | Earlier test expected hidden row before selection/reload | Reproduced; **fix not included**. |
| User message, zero assistant messages | Two-workspace prototype explicitly checked this history | Diagnostic only; **not a Passed claim on PR head**. |
| Eight loaded workspaces | Two-workspace success missed browser connection exhaustion | Negative control reproduced starvation; requires safe transport follow-up. |

## Verification and remaining work

Local lane was used as explicitly requested. The committed testkit spec is `evals/specs/session-create-acceptance.test.ts` and runs a real OpenWork server proxy against a rejecting engine witness; it does not claim real-provider availability.

Commands for the final head:

```sh
bun test apps/server/src/opencode-plugins/openwork-extensions-preview.test.ts apps/server/src/opencode-plugins/openwork-provider-adapters.test.ts
pnpm evals:pr specs/session-create-acceptance.test.ts
```

Targeted results during implementation: 82/82 Bun tests and 1/1 testkit spec passed, zero skips. A server revert-fails control restored only `openwork-extensions-preview.ts` from `91a7459a6` while retaining the new descriptor/test: the same testkit command exited 1 (0 passed, 1 failed), observing `issues: undefined` instead of the indexed rejection at spec line 109. The committed implementation was then restored. Final-head results are published on the PR. Prototype app checks and negative controls are investigative evidence only, not the landable tree's sidebar verdict. Broader evals checks encountered unrelated-file errors; without a clean control they are not classified as pre-existing or passed.

The original user prompts remain recoverable: an authorized user can select a verified available model and resume an existing session rather than duplicate it. This investigation neither verified such a model's current availability nor reran the originals. **Completion requires the safe live-inventory fix, its final-head multi-workspace/reconnect/compatibility tests, and a revert-fails check before marking the complete request Passed or the PR ready.**

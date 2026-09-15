# RCA: archive timeout initially correlated with a pinned session

## Verdict and scope

**Confirmed defect:** archive work could outlive the renderer mailbox receipt, and cancellation could be lost by the SDK transport. A deterministic held transcript read reproduces the reported five-second bridge error on the original production code. The fix returns a structured failure before that receipt expires and prevents a late preflight from archiving the session.

**Pin causality is not established.** Healthy pinned UI archive, pinned cross-workspace mailbox archive, and unpin-then-archive all pass with the original production files as well as the fix. Pinning alone does not reproduce the incident. The exact request that stalled in the installed app, and the reason for its first no-window response, remain unknown. This report does not claim to have reproduced that session's entire history or repaired the installed app.

Isolation: dedicated `fix/archive-pinned-session-hang` worktree based on `76b166802a6360878257ad0c43b98668de306920`; local dev Electron created by testkit with separate HOME/XDG/profile, mock keychain, allocated ports and fixture workspaces. No installed-app CDP, main-checkout edits, other-worktree edits, stash, or engine-database inspection. Local placement was explicitly requested. Test assertions, not screenshots, determine the verdict.

## Timeline (EDT, September 14)

| Time | Observation / action |
| --- | --- |
| Approximately 22:50–22:51 | Reported installed app `0.18.47-alpha.2966`, dev near `75fd9ca3f`: idle pinned session, no descendant activity. Header Archive showed “Couldn't archive session — Request timed out.” Source: user report and referenced screenshot, not a fresh mutation of that session. |
| Seconds afterward | Reported affordance attempt 1: no connected window; attempt 2: window did not answer within five seconds. About thirty ordinary non-pinned archives reportedly succeeded earlier. Correlation, not a pin-specific root cause. |
| 23:24–23:29 | Two isolated E2E launches failed before test assertions: CDP websocket failure, then desktop readiness timeout on “Pulling in the latest messages.” No claim of pre-existing failure; startup cause unresolved. Later identical isolated launches reached assertions. |
| 23:35 | Healthy pin matrix passed. Held-read step returned after about 3.6 s, but initially exposed an omitted shared failure-code enum; the bridge normalized the new code to `failed`. Fixed the enum without weakening the assertion. |
| 23:39–23:42 | Full pinned E2E and deadline testkit wrapper passed. Four unit files: 110 passed, zero failed. App and evals typechecks passed. |
| 23:43–23:44 | Revert-fails: restored the five production files to the baseline, retained new tests/fault witness. Healthy pin steps still passed; held-read step returned the exact five-second mailbox error. Focused unit test failed because the outcome was still undefined at 3,500 ms. Restored the signed fix afterward. |

Final-head runs and immutable receipts are published on the PR separately; the revert-fails receipt is explicitly a dirty-tree control, not evidence for the fixed SHA.

## End-to-end mechanism

Paths below are repo-relative. Unless marked baseline, line references describe the fixed production tree.

1. `apps/app/src/react-app/domains/session/control/session-control-actions.ts:292–326`: `session.archive` descriptor and executor call the same archive hook used by the sidebar. `helpers.bridged` enables refusal of working/self targets rather than opening a dialog. New verification/unknown-write codes are preserved at line 314.
2. `apps/server/src/opencode-plugins/openwork-extensions-preview.ts:1303–1308`: archive falls through to `uiControlRequest`; this is not a native engine archive handler. Requester origin accompanies the command (`447–504`). The HTTP transport to the server has a seven-second budget (`324–332`).
3. `apps/server/src/routes/ui-control.ts:22–47` authenticates and submits the command to `UiControlMailbox`. `apps/server/src/ui-control.ts:4–6,37–43` imposes a five-second receipt deadline. Expiration deletes the pending receipt; **it does not cancel renderer execution**. A later reply is rejected as missing/404.
4. `apps/app/src/react-app/shell/control/use-ui-control-mailbox.ts:36–67` polls, awaits each command and reply serially, then polls again. `control-provider.tsx:529–564` invokes bridged execution; `413–470` awaits the action. Choreography adds roughly 80 ms before execution and 280 ms after success (`147–154`).
5. `apps/app/src/react-app/shell/session-route.tsx:2592–2632` supplies the shared `useSessionArchive` instance. The target's owning workspace/endpoint is resolved, not assumed from the focused page.
6. Baseline `use-session-archive.tsx:151–154,192–258` allowed 15 seconds for tree discovery, safety verification, re-verification and PATCH. An idle leaf normally entails 16 SDK reads before PATCH, partly parallel: metadata/path/children twice, approvals/questions twice, **unlimited transcript reads twice**, native permissions twice and status twice. Larger transcripts/trees and slower engine generations amplify latency. This is a plausible incident trigger, not a measured property of the original session.
7. `apps/app/src/app/lib/opencode-session.ts:132–146` uses SDK `session.update`, PATCHing `time.archived`. The server mounts the owning workspace, performs recovery admission and forwards to the owning engine generation (`apps/server/src/server.ts:850–863,1552–1574,1649–1682`; `task-recovery.ts:207–242`; `engine-pool.ts:506–543`). No sidebar-pin lookup occurs here.

### Why the UI can time out too

The human path bypasses the mailbox but uses the same archive gate and SDK. `apps/app/src/app/lib/opencode.ts:44,203–240` has a ten-second ordinary fetch deadline. Its “Request timed out.” is consistent with the reported toast, but does not reveal whether preflight or PATCH stalled.

Before the fix, the wrapper considered only `RequestInit.signal`, not `Request.signal`. Its own controller overrode SDK Request cancellation; desktop's Request path also discarded init overrides. The fetch timeout ends when response headers arrive, not when the SDK finishes consuming JSON. Thus merely aborting after 15 seconds did not bound every awaited operation, particularly an uncooperative body. A five-second mailbox budget could never guarantee receipt of that result.

The baseline mailbox error is reproduced with a held transcript **body**, deliberately testing beyond header receipt. The ten-second UI transport symptom is not claimed as a byte-for-byte replay of the original request.

### Where pinned sessions diverge (and where they do not)

- `apps/app/src/react-app/domains/session/sidebar/session-management-store.ts:190–207,399–402`: `pinnedIds` are local persisted state under `openwork.react.sessionManagement`. No awaited pin-store RPC is part of archive.
- `app-sidebar.tsx:933–946,1237–1256` selects active pinned roots and renders the same session menu item with its owning workspace. Menu/hover archive routes use the common callback (`414–419,487–498`).
- There is **no “archive pinned?” confirmation**, no unpin-before-PATCH, and no promise waiting for `pinned=false`. Archiving hides the inactive entry; its retained pin preference can reappear on restore. The fix preserves this behavior.
- Working-session confirmation is independent of pinning. `use-session-archive.tsx:148–151` returns `target_working` before mounting a dialog for bridged requests; requester/self-tree refusal remains intact. The generic mailbox text mentioning a possible confirmation is not evidence of an actual dialog.
- No focused session is required: the E2E stays at the workspace sessionless route, asserts zero chat surfaces, archives from the sidebar and mailbox, and preserves unrelated sessions. It tests the UI sidebar entry, not a separate header click.

### Inventory reload and #4934

`apps/app/src/react-app/shell/use-workspace-route-state.ts:553–559` clears loaded markers when inventory is cleared, allowing later reload. Transient desktop gaps preserve inventory (`518–543`). Pin persistence is separate. Archive resolves success before workspace inventory reload, although baseline `busy` stayed held until reload finished. Therefore #4934 does not establish an archive pin-store deadlock. The fix bounds post-write cache/reload waits too and releases holds/busy state.

### Why “no connected window” while a window exists?

`apps/server/src/ui-control.ts:18–25,51–54,81–83` defines connected as a pending poll within the last 20 seconds, **not OS-window existence**. No-window rejects before enqueueing that attempt. Polling the wrong/restarting server, connection-resolution failure, renderer suspension, or a prior long command can all produce this state. Serial command execution stops polling while it awaits completion; a late reply incurs a 404/backoff.

The original direct UI archive does not itself occupy the mailbox loop, so it is insufficient to explain the first no-window response. No-window followed by a timeout is compatible with polling resuming between attempts, not proof that restart was needed. Historical tool execution and exact network timing for that session were not observed; no engine database was opened to infer them.

**Recovery:** the fixed held-read E2E releases the response, proves no late PATCH, then archives successfully through the same app/mailbox without restarting. No permanent bridge corruption was reproduced. Other indefinitely running commands can still block the serial mailbox; this PR bounds archive rather than changing concurrency for every command.

## Smallest justified fix

- Keep safety checks and pin semantics; do not add speculative unpinning or bypass approvals.
- `use-session-archive.tsx:159–180`: bound bridged archive at 3,500 ms, leaving margin within the five-second mailbox budget; keep the human 15-second budget. Race awaited work against cancellation as well as pass the signal to transport. Check the deadline again before PATCH. A completely frozen renderer remains outside an in-renderer deadline guarantee.
- Track PATCH dispatch (`286–288`). Return `verification_failed` when no archive PATCH was sent, versus `archive_outcome_unknown` after dispatch without a confirmed result. Do not claim “not archived” after an uncertain write, and never automatically retry it.
- Resolve cancellation on unmount, guard late continuations, release holds and busy state in `finally`. Reconcile a known successful PATCH locally even if cache refresh stalls.
- Preserve effective caller signals and Request init overrides in `opencode.ts:205–209,234–238,305–309`; pass the archive signal through `opencode-session.ts`.
- Declare the two codes in `packages/types/src/openwork-affordance.ts:118–142`, so the renderer bridge cannot silently normalize them away.

## Why tests missed it: negative space

| Missing scenario | Prior coverage / blind spot | Added proof |
| --- | --- | --- |
| **Archive a pinned session** | Pin exposure and archive behavior were tested independently. | Real UI and real mailbox; cross-workspace target; pin preference retained. |
| **Archive when no session page is focused** | Agent archive tests primarily kept another conversation visible. | Sessionless route and empty chat-surface assertions before/after all paths. |
| Slow/uncooperative transcript body | Fast fixture engine and stop faults did not hold idle preflight bodies. | Held HTTP body, real mailbox deadline, structured failure and zero PATCH. |
| Late response after timeout | Transport timeout alone did not bound body consumption. | Release read; observe no late mutation; fresh archive succeeds without restart. |
| Cancellation on SDK Request | URL/init and streaming paths obscured overridden Request signals. | Web/desktop Request and init override/null tests, caller and transport deadlines. |
| Uncertain PATCH / stalled cache refresh | Cancelled could conflate failed verification with dispatched writes. | Six stalled phases; unknown write; unmount; human 15-second budget; holds/busy recovery. |
| New error through shared schema | Hook-level outcome assertions alone could pass while bridge erased code. | Actual control provider/action tests and actual mailbox E2E assert exact codes. |

## Reproduction and evidence

Use the supplied mise pnpm 11.4.0, Bun 1.4.0 and Node 24.20.0 in PATH. Run one app-driving test at a time in this worktree, never point the harness at the installed app.

```sh
# Local isolated dev Electron, both healthy pin matrix and held-read recovery.
env -u OPENWORK_EVAL_ELECTRON_BINARY -u OPENWORK_EVAL_SURFACES_DIR \
  -u OPENWORK_SERVER_CONFIG -u OPENWORK_SERVER_STATE_PATH \
  -u OPENWORK_SERVER_TOKEN_STORE_PATH -u OPENWORK_DESKTOP_WORKSPACE_STATE_PATH \
  -u OPENCODE_DB OPENWORK_DEV_SHARED_STATE=0 \
  pnpm evals:e2e session-archive-pinned --local --engine v1

# Testkit receipt wrapping four native unit suites (110 assertions-based tests).
pnpm evals:pr specs/session-archive-deadline.test.ts
pnpm --filter @openwork/app typecheck
pnpm evals:typecheck
pnpm evals:check-browser
```

Development results: E2E 1 passed / 0 failed / 0 skipped, exit 0; deadline wrapper 1 passed / 0 failed / 0 skipped with 110 unit tests and 828 expectations, exit 0. Typechecks and browser checks passed. A broad layers lint attempted during setup reported 54 violations outside the changed entries; no clean control was run, so its provenance is unresolved. Targeted changed-entry dependency checks passed.

Revert-fails command: the identical E2E command after `git restore --source=76b166802a6360878257ad0c43b98668de306920 --` the five changed production files, retaining the new spec and fault witness. Exit 1, 0 passed / 1 failed / 0 skipped: expected `verification_failed`, received “The OpenWork window did not answer within 5 seconds…”. Healthy UI/mailbox/unpin steps passed before the held-read failure. Receipt: `evals/results/test-runs/2026-09-15T03-43-01-863Z-pinned-idle-sessions-archive-from-the-sidebar-and-mailbox-without-a-focused-sess/test-run.json`. Its recorded HEAD is `4a02ce9cc`, but production files were deliberately reverted in the working tree: **not a fixed-head receipt**.

Focused native revert-fails, from `apps/app`: `pnpm --config.verify-deps-before-run=false exec bun test --isolate tests/session-archive-agent-contract.test.tsx --test-name-pattern "bounds a stalled preflight response body"`. Exit 1, 0 passed / 1 failed / 25 filtered: expected `verification_failed`, received undefined after 3,500 ms. All production files were restored from the signed fix immediately afterward.

## CI follow-up: preserve explicit null overrides across runtime versions

PR #5014's initial `openwork-tests-core` run failed at the **new ordinary-request test** `opencode-stream-timeout.test.ts:185`: explicit `RequestInit.signal=null` must disconnect the input Request signal. This is not a streaming test and its expectation remains unchanged. No oracle change, no archive-only narrowing, and no swallowing caller cancellation are justified.

CI used Bun 1.3.14; the supplied local toolchain used Bun 1.4.0. A focused local run with Bun 1.3.14 reproduced the same failure (1 passed / 1 failed / 27 filtered). That runtime's `new Request(input, {signal:null})` retained the input signal. The desktop wrapper now forwards the explicit init signal into `fetchWithTimeout` as well as cloning the request, preserving null versus undefined through deadline composition. The non-streaming timeout branch is unchanged; event streams remain untimed.

With that transport correction, `pnpm --filter @openwork/app test:core` on Bun 1.3.14 passed **292 tests / 0 failed**, 3,189 expectations, exit 0. The deadline testkit wrapper passed with all 110 native tests; app typecheck passed. The user-requested command `pnpm --filter @openwork/app test -- opencode-stream-timeout` does **not** scope this repo's test script: it expands to `bun test --isolate tests/ -- opencode-stream-timeout`, running 254 files. It returned 2,282 passed / 8 failed, exit 1, with failures in mention instructions, v2 provider options, composer continuity, palette settings and tool-error rendering, not the transport test. No clean control was run for these broader failures; their provenance remains unresolved rather than being labeled pre-existing. They are outside the workflow's 18-file core suite. Final-head core CI and regenerated testkit receipts are linked on the PR.

## User impact and tonight's guidance

Slow archive safety reads can stall both human and agent routes regardless of pinning. The old five-second timeout is an **unknown action outcome**, not authorization to repeat the mutation. Pinning may correlate with older/longer or background-workspace conversations, but that has not been measured for this incident.

**Unpin first is not a confirmed workaround.** Healthy pinned and unpinned paths both work; removing a pin does not avoid archive verification. For tonight, leave a timed-out session intact until a read confirms its archive state and the workspace responds again. Do not automatically retry or restart the app merely because a mailbox receipt timed out. A person may choose to reopen an unresponsive app, but this investigation cannot promise that doing so fixes the original incident. The tested fix recovers without restart; the installed release still needs an update containing it.

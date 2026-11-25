# Permission reply timeout — RCA v3 (2026-09-16)

## Conclusion

**Confirmed for the inspected local-engine path: accepting or denying an existing permission does not await upstream inference.** The renderer sends a finite local HTTP reply; the engine settles its pending permission and returns. Resumed agent work may subsequently need inference. These are separate operations.

**Reproduced transport defect; installed incident not conclusively attributed.** In isolated local testkit Electron on baseline `c4356f0a2`, a trusted Allow once click under real HTTP/1.1 SSE pressure produced `Request failed — Request timed out.` after **10,032.9 ms**, with **zero wire permission replies**, while independent engine reads succeeded. Releasing only pressure let the same pending permission succeed (200 in **8.4 ms**) and the read tool complete while final inference was deliberately held. No installed-app instrumentation or engine database access was performed.

The initial targeted fix completes the same pressured click in **39.6 ms**, with exactly one main-process reply (200 in **7.43 ms**). Final head verification, revert-fails control, public evidence, review gates and merge are recorded below as they complete. Until then the delivery verdict is **Incomplete**.

## Options and ownership

| Option | Benefit | Cost | Risk / blast radius | Decision |
| --- | --- | --- | --- | --- |
| A. Isolate permission replies with the existing main-process finite loopback transport | Allow once / Allow for session / Deny do not wait for renderer sockets; same engine semantics | Small transport predicate, cancellation parity and tests | Selected permission POSTs only; timeout still cannot roll back a dispatched reply | **Implement here.** Normal Stop plus verification reads assigned to the coordinated prompt-send lane; archive Stop already isolated |
| B. Move all renderer-to-engine mutations behind one isolated client | Protect prompt admission, abort and metadata writes consistently | Audit endpoint-specific deadlines, cancellation, admission uncertainty and preflight reads | Larger mutation blast radius; moving POSTs alone does not protect Stop verification or send history reads | Stage user-control actions first. Coordinated `fix/prompt-send-isolated-path` owns scoped send/Stop clients via existing API |
| C. Reduce/multiplex workspace SSE subscriptions | Addresses the shared resource exhaustion rather than selected victims | Ownership, background work, reconnect and replay correctness | Could lose background events or introduce stale state; streams are per workspace+origin, not per tab | Separate transport follow-up, owned by the audit/coordinator to assign; not repaired here |
| D. HTTP/2 or separate stream origin/port | Separates or multiplexes socket demand | Server/proxy/certificate and deployment work | Cross-platform transport compatibility, authentication/CORS, connection limits | Longer-term alternative, not required to protect local controls |

Do not raise timeouts as the fix. IPC alone is insufficient: #5063 demonstrated that generic Electron networking can share Chromium pressure. The selected path must reach the existing **Node HTTP loopback** transport. Do not widen this PR into general session metadata, question forms, stream budgeting, or composer/retry UI.

## Timeline (EDT; reported vs measured)

- September 14 approximately 22:50: earlier archive timeout report, documented in RCA v2; not replayed here.
- September 16 approximately 14:00: repeated idle-session archive failures reported; audit action later succeeded. Timing alone did not prove transport isolation.
- 15:16: #5014 merged (`d16d4a1aa`), bounding archive verification and retaining fail-closed checks. Its pressured renderer request still timed out.
- Later September 16: #5063 merged (`61d57ac19`), isolating archive finite HTTP and confirmed Stop from Chromium SSE sockets. Its pressure proof and negative control are in `reports/rca-archive-timeout-ui-path-2026-09-16.md`.
- Approximately 17:10: user reports repeated external-folder permission click timeouts in a pinned, running chat, progress 0/4. This is a reported installed-app observation; no private transcript, folder contents, session identifiers or customer identity are published here.
- 17:15: task branch created from `c4356f0a2`, including both archive fixes; read precedent rather than repeating archive RCA.
- 17:36–17:37: permission baseline reproduced in isolated Electron. Investigative test exit 0, 1 passed / 0 failed / 0 skipped (a passing failure oracle, not passing UX).
- 17:50–17:51: initial fixed pressure test exit 0, 1 passed / 0 failed / 0 skipped. Permission settles and read proceeds while real SSE pressure and mock final-inference hold remain active.

## Exact failing request and mechanism

`POST /workspace/<fixture-workspace>/opencode/permission/<fixture-request>/reply`

Body: `{ "reply": "once" }`; workspace scoping and authentication are provided by the existing SDK/client. The other buttons send `always` and `reject` to the same endpoint.

Baseline observations:

- Trusted click to toast: **10,032.9 ms**; Chromium cancellation: **10,001.5 ms**.
- CDP: no response, no wire-request extra-info, `net::ERR_ABORTED`, canceled true.
- **Zero** main-process permission replies; **zero** successfully dispatched renderer permission replies; both real permissions remain pending.
- Eight injected real SSE fetches on the exact engine-facing origin, four initially established on distinct HTTP/1.1 connections, five by timeout; original blockers stay open while excess streams queue.
- Renderer canary times out at **2,001.9 ms**. Independent engine pending-permission read succeeds in **5.44 ms**. Renderer timers and frames continue.
- Release only injected pressure, then deliberately retry the still-pending permission: exactly one accepted reply, HTTP 200 in **8.4 ms**, no unrelated approval or transcript change.

This is Chromium per-origin HTTP/1.1 connection-pool starvation, not inference latency, in the controlled witness. Pin state, model identity and long transcript are not necessary to reproduce it. Actual installed socket ownership and request timing were not captured, so the reproduction is strong mechanism evidence rather than proof of that particular incident's cause.

## Source chain (baseline unless stated)

1. `apps/app/src/react-app/domains/session/chat/permission-approval-modal.tsx:420–440`: Deny / Allow once / Allow for session select reject / once / always.
2. `apps/app/src/react-app/domains/session/sync/use-session-interactions.ts:375–411`: busy guard; `client.permission.reply`; unwrap response; settle cache; toast failure; release busy in finally.
3. `apps/app/src/react-app/shell/use-workspace-route-state.ts:1439–1449`: creates normal client without archive's explicit main option.
4. `apps/app/src/app/lib/opencode.ts:194–249,296–334,352–372`: 10-second default finite-request timeout; renderer desktop transport by default on baseline. Timeout becomes `Request timed out.`.
5. `apps/app/src/app/lib/desktop.ts:553–557` (baseline): desktop loopback normally uses renderer fetch. `desktopFetchViaMain` uses finite IPC instead.
6. `apps/server/src/server.ts:853–867,1672–1707` and `apps/server/src/engine-pool.ts:506–543`: authenticate/scope, choose workspace engine, forward reply and return its response. Existing legacy 404 compatibility fallback is not a timeout retry.
7. Engine pin `constants.json:2`, v1.18.30: [permission handler](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts#L16) awaits Permission.reply then returns true. [Permission implementation](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/permission/index.ts#L98) removes pending entry, publishes replied, settles deferred, and for always updates instance-memory rules/matching requests. It does **not** join resumed inference. Missing requests return NotFound.

The test proves this distinction with real pending read tools, not fabricated UI permissions: after reply, the target permission disappears and its read output contains the fixture marker, while the mock final response remains held and no final text is rendered. Upstream inference is required for later model work, not acknowledgment of this existing local permission.

## Fix and safety boundaries

Default finite desktop permission reply POSTs select `desktopFetchViaMain`; explicit `createClient(..., {desktopTransport: "main"})` remains compatible. Native streams are excluded before finite transport selection. Web behavior and upstream provider transport are unchanged. Only HTTP exact loopback hosts use Node fetch; external/HTTPS retain Electron OS trust/proxy behavior; redirects are rejected by the existing finite-loopback helper.

Both IPC ends recognize permission reply POST cancellation, preserving the 10-second deadline and caller cancellation through main. Tests exercise actual main-handler cancellation during headers and body, sender ownership, once/always/reject bodies, mounted paths, Request overrides, HTTP failures without retries, lookalike exclusions and existing prompt-admission semantics. Cancellation closes transport but **does not undo an already applied permission or establish that it was rejected**. No automatic retry/replay is introduced.

#5014 covers archive verification budget and safety, not socket allocation. #5063 protects archive/restore and archive-confirmed Stop only. Neither originally changed ordinary permission clients, ordinary Stop, send or background SSE ownership.

## Remaining paths / explicit follow-ups

| Path | Source | Owner / disposition |
| --- | --- | --- |
| Normal Stop plus descendant/idle/approval verification | `session-surface.tsx:2379–2415`; `opencode-interruption.ts:149–335` | Coordinated prompt-send lane, `fix/prompt-send-isolated-path`; isolate whole scoped interruption client, not abort POST alone |
| Prompt admission plus history/preflight | `session-surface.tsx:2093–2120`; `session-route.tsx:1579–1599`; `opencode.ts:381–430` baseline | Same prompt-send lane; retain admission-unknown/no-replay contract |
| Question reply/reject | `use-session-interactions.ts:416–442` | Audit follow-up; not changed by permission-specific predicate |
| Ordinary session metadata/rename PATCH | `session-route.tsx:3771–3781` | Audit follow-up; archive is already isolated |
| Workspace event subscriptions / unrelated reads | `session-sync.ts:193–202,260–262,1424,1738–1759,1828–1854`; `runtime-sync.tsx:28–42` | Audit/coordinator owns assignment of separate SSE budget/multiplex work. Key is workspaceId + baseUrl; retained work can keep subscriptions alive |
| Preview engine control paths | `opencode-v2-adapter.ts:1542,1658,1766,1948–1963` | Not pressure-certified by the v1 Electron witness; do not extrapolate to all preview endpoints |

## Reproduction and evidence

User-required **local isolated source Electron** lane. Never run against the installed app. Use mise pnpm 11.4.0 / Bun 1.4.0 / Node 24.20.0; unset `OPENWORK_EVAL_ELECTRON_BINARY`, `OPENWORK_EVAL_SURFACES_DIR`, `OPENWORK_EVAL_DAYTONA`, `DAYTONA_SANDBOX_ID`, `OPENWORK_EVAL_CDP_URL`; set `OPENWORK_DEV_SHARED_STATE=0`.

```sh
OPENWORK_PERMISSION_PRESSURE_MODE=baseline pnpm evals:e2e permission-pressure --local --engine v1 --surface electron
OPENWORK_PERMISSION_PRESSURE_MODE=fixed pnpm evals:e2e permission-pressure --local --engine v1 --surface electron
pnpm evals:pr specs/session-archive-transport.test.ts
```

- Baseline: `evals/results/test-runs/2026-09-16T21-36-36-606Z-baseline-external-directory-allow-once-under-real-sse-pressure-preserves-unrelat/`. `07-baseline-numerical-evidence.json`; `09-acknowledgement-independent-of-final-inference.json`; screenshot `06-*.png` is card+timeout.
- Initial fixed (dirty implementation tree, not final head): `evals/results/test-runs/2026-09-16T21-50-09-785Z-fixed-external-directory-allow-once-under-real-sse-pressure-preserves-unrelated-/`. Click 39.6 ms; reply 7.43 ms; renderer canary still times out at 2002 ms; unrelated permission unchanged. Screenshot `08-*.png` is dismissed approval/read complete with inference held.
- Initial transport wrapper: exit 0; 1 testkit wrapper, 9 Node + 50 Bun tests, no skips. `pnpm typecheck` exit 0. Final head reruns required after commit.
- Retained setup issues: separate eval dependency install required; unsupported mock zero-chunk gate was replaced by existing agent-hold; text selector and POST abort expectation corrected. Layer lint exit 54 reports off-scope imports (first `worlds/sidebar-brand.ts -> @openwork/testkit`); not labeled pre-existing without a clean control. No policy change or broad lint repair included.

## Delivery gates

Completed behavioral proof before final-head rerun:

- Revert-fails on task-owned baseline production files `b99617f10`: exact fixed-mode test exit 1 (0 passed / 1 failed / 0 skipped), toast **10,032.1 ms**, zero wire/main replies. Production files restored immediately. Receipt `2026-09-16T21-59-59-988Z-fixed-external-directory-allow-once-under-real-sse-pressure-preserves-unrelated-` is explicitly a dirty-baseline negative control, not fixed-head proof.
- Clean fixed head `28c420a8a`: permission click **56.1 ms**, one main POST 200/**6.957 ms**, 1 passed / 0 failed / 0 skipped. Archive helper regression **116.4 ms**, exactly one main PATCH and no renderer PATCH; neighbors unchanged. Transport 9 Node + 50 Bun passed; app and Electron typechecks green.
- Existing parent-child permission approval passes its selected case; three other cases excluded by line selection are not claimed passed. Existing Stop-cleanup case cannot reach its assertions: repeated fixture engine reload returns 503. A new clean `origin/dev` control at `c4356f0a2` runs the exact same `OPENWORK_EVAL_E2E_TESTS=1 OPENWORK_EVAL_ENGINE=v1 pnpm --dir evals exec vitest run --config vitest.config.ts --project e2e specs/parent-child-permission-approval.e2e.test.ts:100` command under the same toolchain/environment, reproducing the identical `worlds/chat.ts:179` 503 `opencode_engine_unreachable` / `fetch failed`. Task run 47.07s and clean control 102.52s; each exit 1, 0 passed / 1 failed / 3 filtered.
- That independent setup defect is a stale endpoint retained by reload across cloud-provider engine rollover: `apps/server/src/server.ts:4157`, `engine-pool.ts:646,916`, `opencode-connection.ts:16`. Logs place failures 59/101 ms after generation flip. The audit owns follow-up assignment; this permission transport PR does not repair engine rollover. No fixture retry or production workaround was added.
- The permission-pressure fixture now directly covers native Stop on the unrelated still-pending request after pressure release, interrupted read/error, unchanged completed target, and fresh work exactly once. At 18:31 this extended test passes (1/0/0); pressured Allow **54.2 ms**. Stop deliberately issues one scoped **reject**, never an allow: `opencode-interruption.ts:319–335` already withdraws aborted permissions. An initial new oracle incorrectly required zero replies; inspection of the failing ledger and existing code corrected it to exactly one rejection, zero granting/duplicate/renderer replies, not a product change. Three ambient behavioral assertions pass. Receipt `2026-09-16T22-31-20-940Z-fixed-external-directory-allow-once-under-real-sse-pressure-preserves-unrelated-`.

Screenshots are authentic isolated testkit captures, manually inspected as supporting references. No testkit visual judgment is claimed for reference screenshots; behavioral assertions decide pass/fail. Baseline card+timeout and final fixed card-dismissed/read-completed images are embedded in the PR body with source SHAs. A black/transparent sidebar in these raw source-Electron captures is not an asserted visual fix.

Still required for merge: final-head proof publication, `openwork-tests-required`, both Warden runs and CodeQL green; zero unresolved review threads; signatures and DCO; no policy files; check stacked dependents; only then authorized squash merge. Final head receipts and the merge record live in the PR to avoid mutating the tested commit just to record its own SHA. A source merge does not prove the installed dev build has updated.

# Archive UI timeout — RCA v2 (2026-09-16)

## Verdict

**Two mechanisms reproduced; original installed incident not attributed.** PR #5014 is merged: `d16d4a1aa9b4d8b8cf081b213ac9fa50628032b0`. The follow-up isolates archive transport, with passing initial pressure proof. Final-head verification, revert-fails results, CI/review gates and merge status are recorded in the follow-up PR's immutable test-evidence comments; until those gates are satisfied the mission is **Incomplete**.

Local isolated source-built Electron was used, as authorized. No installed-app CDP, engine database access, private transcript capture, main-checkout edits (except fetch), or other worktree edits. Public examples contain only test-generated identities.

## Options and recommendation

| Option | Benefit | Cost / risk | Recommendation |
| --- | --- | --- | --- |
| Route archive's finite desktop reads/writes through IPC **and isolate HTTP loopback networking from Chromium** | Preserve all archive ownership/work/approval checks; avoid waiting behind SSE sockets | Must preserve cancellation and unknown-write reporting; restrict Node transport to loopback with redirects rejected; external TLS must retain OS trust/proxy | Preferred smallest scoped follow-up; requires real pressure success and revert-fails proof |
| Send PATCH first, verify afterward | Fewer preflight requests | Can archive active work, pending approvals or newly discovered descendants | Reject: weakens existing safety contract |
| Multiplex workspace SSE / HTTP2 / explicit connection budget | Addresses wider transport contention including other commands | Cross-engine version/scoping/reconnect/lifetime work; prior prototype had gaps | Separate larger transport project |
| Raise archive timeout | Less failure on brief delays | Does not free occupied connections; delays failure and widens uncertainty | Reject as the primary fix |

Do **not** just replace renderer fetch with the existing generic main fetch: the calibration below also timed out. The main process uses Electron/Chromium networking today.

## Timeline (EDT)

- September 14, approximately 22:50: RCA v1's reported idle pinned archive timed out; first affordance attempt reported no connected window, next hit the five-second mailbox deadline. The report was developed September 14–15; this is the earlier incident, not a fabricated September 15 timestamp.
- September 16, approximately 14:00: user reports an idle, short, non-pinned session in OpenWork Chat repeatedly failed from the UI with `Couldn't archive session — Request timed out.`. Seconds later the audit archived the same session through `session.archive`. These are reported observations, not newly replayed installed-app operations.
- 14:45: audit reports a transient `session.read` result `No OpenWork window is connected to this server...` while the installed app was open and idle; subsequent calls worked. Separate hypothesis, not proof of socket exhaustion.
- 14:45: #5014 updated via signed/DCO merge of current dev to `eb24c339fee929402e5957cb29d5944ac166bc9e`.
- 14:59–15:02: final-head local testkit deadline wrapper and isolated Electron pinned E2E passed, no skips. Native wrapper: 117 tests passed. Held preflight returned structured failure in 3606.7 ms, then recovered in 451.8 ms with exactly one PATCH and no late mutation.
- 15:16: #5014 squash merged after all authorized gates were checked, including exact-head Warden approval and evidence comments.
- 15:18–15:19: pressure baseline passed at `af3e12a5a`: exact ten-second UI toast reproduced using real held HTTP/1.1 SSEs; release recovered the same target through renderer affordance.
- 15:29–15:31: isolated mailbox liveness E2E passed after importing #5014. One held real poll body caused registration expiry while renderer timers/frames and unrelated renderer HTTP remained healthy; release restored the same document's mailbox.

## Exact failing request in the pressure reproduction

At test-generated target:

`GET /workspace/ws_56998ccddcaf/opencode/session/ses_f545746f5ffeP1g6gINirR8uhC`

- Renderer elapsed: **10001.5 ms**.
- Abort reason and thrown error: **Error: Request timed out.**
- CDP: no response headers, no observed wire-request extra-info, no connection assignment; ended `net::ERR_ABORTED`, canceled true.
- Parallel ownership `GET /workspace/ws_56998ccddcaf/opencode/path` also had no headers and was canceled.
- **Zero PATCH attempts**; all five fixture sessions remained idle and unarchived.
- Four injected streams initially established on separate HTTP/1.1 connections (eight requested across two workspaces); additional queued streams can establish as application long polls finish. The assertion requires original blockers to remain, not the count to stay artificially constant.
- A previously successful raw renderer status GET timed out at its two-second deadline under pressure. Independent authenticated runner reads of the same engine succeeded. Renderer timers and frames continued.
- Releasing only the injected streams restored raw renderer GETs. The **same** target then archived through `session.archive`, with successful renderer GET/PATCH metadata and one PATCH, no neighbor mutation or restart.

Source evidence: `evals/results/test-runs/2026-09-16T19-18-54-591Z-investigative-baseline-real-sse-pool-pressure-times-out-sidebar-archive-before-p/`, especially `07-exact-baseline-get-timeout-and-no-archive-mutation.json`.

## Important correction: what the main-process affordance proves

`apps/desktop/electron/ui-control-server.mjs` hosts the control bridge, but forwards `command` to `window.__openworkControl.command`. `session-control-actions.ts` invokes `useSessionArchive`, the same hook used by the human sidebar. Likewise, server `UiControlMailbox` delivers into the renderer. There is no separate native archive state machine on the inspected dev tree.

Thus, success through a main-hosted affordance seconds after UI failure is **not proof of a different request pool**. The controlled recovery explicitly observes that affordance's successful PATCH in Chromium after pressure is released. Historical timing or route/registration recovery could explain the difference; the installed request path/timing was not captured.

The generic IPC `__fetch` calibration under pressure also failed after **2002.5 ms**. Its handler uses `electronNet.fetch`, which does not by itself establish networking isolation from renderer SSE contention. A hypothetical Node loopback route remains to be proven.

## Independent registration-lapse evidence

The mailbox E2E deliberately holds only `response.text()` completion for one real `GET /experimental/ui-control/pending`, after real response bytes arrived. It neither freezes JavaScript nor occupies sockets with injected SSE.

After **21207 ms** of held body consumption (and roughly 31 seconds since that poll began):

- Same document, visible composer and sidebar, unchanged route; renderer interval and animation-frame counters advance.
- No new pending poll starts: the serial consumer is waiting for that body.
- Independent context request returns the exact **no connected window** error in **3.20 ms**, rather than the five-second receipt timeout.
- Unrelated `/health` succeeds through renderer fetch in **2.30 ms**, and runner fetch in **2.03 ms**: this witness is not connection-pool starvation.
- Five sessions' inventories, metadata/transcript/todo digests are unchanged; no engine write was attempted.
- Releasing the one body resumes real polling, then one context request succeeds. Exactly two contexts were delivered across three completed POSTs: the rejected one was never enqueued. No restart.

`UiControlMailbox.connected()` is recent-poll liveness: `Date.now() - lastPollAt <= 20000`, not OS window existence. A testkit clock-boundary spec separately asserts connected at 20000 ms, disconnected at 20001 ms, five-second receipt expiry, rejected late reply, no enqueue on disconnected refusal, and fresh-poll recovery.

Evidence: `evals/results/test-runs/2026-09-16T19-29-51-747Z-investigative-a-synthetic-single-poll-body-gap-expires-mailbox-registration-whil/`.

**Interpretation:** registration expiry with a live renderer is ruled in as a possible mechanism independent of pin and socket pressure. It is not proved to be the audit's transient cause. It also cannot directly cause the human archive toast: the human hook does not await mailbox registration. No speculative heartbeat/registration relaxation is included; advertising a stuck command consumer as available could merely replace a useful refusal with a timeout.

## Hypothesis matrix

| Hypothesis | Evidence verdict | Boundary |
| --- | --- | --- |
| Pin-specific failure | Not necessary: pressure witness target is asserted non-pinned | Does not exclude other pin defects |
| Slow engine session GET / long transcript | Not necessary in witness: empty idle target; runner GET succeeds while renderer request never gets headers | Installed engine timing remains unobserved |
| Renderer HTTP/1.1 pool starvation | **Reproduced** by established live sockets + blocked canary + release control | Eight injected streams over two workspaces are deliberate pressure, not a recreation of 60 tab owners |
| JavaScript/render-thread queue frozen | Excluded in witness by progressing timers/frames and CDP reads | Installed event-loop timing unknown |
| Stale abort controller reuse | Not needed: healthy control, fresh attempt's exact ten-second abort, successful release recovery | Existing cancellation tests cover Request signals; original controller identity was not observed |
| Main process performs archive independently | Contradicted by inspected routing and recovery request observations | Main-hosted transport and native mutation are different concepts |
| Mailbox registration lapses with a live renderer | **Reproduced independently** with healthy unrelated renderer HTTP | Actual reason the installed poll lapsed is unknown |

Static scope: SSE is keyed by workspaceId + baseUrl; retained tabs do not equal one SSE each. Idle retention and background work can keep old workspace streams alive. Three workspaces / roughly 60 tabs alone do not establish six occupied sockets. No claim is made that all actual subscription ownership was reproduced.

## What #5014 covers / does not

Covers bounded bridge verification, effective caller cancellation, fail-closed preflight with no late PATCH, unknown outcome after dispatched write, and hold/busy release. It keeps the human 15-second operation budget and the normal ten-second transport read deadline. It is not a socket allocator or a mailbox heartbeat change.

The stronger test—UI archive succeeds while established stream pressure remains held—will be required of the follow-up. The #5014-only pressure rerun at 15:32 passed its investigative failure oracle (1 passed / 0 failed / 0 skipped): UI still timed out before PATCH, then recovered after pressure release. Thus #5014 alone does **not** make this pressured UI archive succeed. Receipt: `evals/results/test-runs/2026-09-16T19-32-01-947Z-investigative-baseline-real-sse-pool-pressure-times-out-sidebar-archive-before-p/`.

## Follow-up implementation and proof scope

The production diff is deliberately transport-only:

- `use-session-archive.tsx` opts both archive (including safety reads and confirmed Stop) and restore into the finite main-process client transport. No ownership, queue, approval, descendant, confirmation, or pin decision is removed.
- `opencode.ts` adds an explicit `desktopTransport: "main"` client option. The default client path is unchanged. Streaming requests still use renderer fetch and cannot enter the buffering IPC call. Web behavior is unchanged.
- `finite-http-fetch.mjs` routes only HTTP `127.0.0.1`, `localhost`, and `[::1]` through Node fetch. It rejects all redirects. HTTPS—including HTTPS loopback—and all external/lookalike origins keep the exact Electron fetch passed by main, preserving system proxy and OS certificate trust. Existing transfer IDs, caller signals, timeout races and unknown-PATCH outcomes remain intact.
- `main.mjs` uses that finite HTTP selector for the existing `__fetch` handler. No new public native archive state machine or retry is introduced.

Initial fixed pressure E2E passed at 15:38 (1 passed / 0 failed / 0 skipped): trusted sidebar archive persisted while the same real streams remained held and a raw renderer canary still timed out. Native transport tests use real loopback HTTP to assert scoped headers/body, HTTP rejection without retries, held-body cancellation, redirect rejection without reaching the redirect target, and unchanged external fetch selection.

Archive fault tests previously wrapped only renderer `fetch`; that boundary would miss the new archive traffic. A **test-only** CJS preload, installed into the spawned dev Electron through `NODE_OPTIONS`, now observes main global fetch beneath the real IPC handler as well. Setup fails if it is absent. It configures only the fixture server origin and known workspaces; it is not shipped or imported by production. The old behavioral specs retain their assertions, including held-message failure, no late PATCH, and recovery. Pressure proof separately counts the exact successful main PATCH and requires zero renderer PATCHes and no abort/prompt replay. The synthetic held-body fixture must not be confused with the real-socket pressure witness.

The separate mailbox-liveness fixture deliberately remains unchanged in production: it identifies a possible misleading no-window refusal, not a new justification to extend the registration lease while its consumer is stalled. Registration repair and broader SSE budgeting remain separate work if actual installed diagnostics identify them.

## Commands and failures retained

Use mise pnpm 11.4.0, Bun 1.4.0, Node 24.20.0. Isolate all app env paths as in RCA v1, unset `OPENWORK_EVAL_ELECTRON_BINARY`, `OPENWORK_EVAL_SURFACES_DIR`, `OPENWORK_EVAL_DAYTONA`, and set `OPENWORK_DEV_SHARED_STATE=0`.

```sh
pnpm evals:pr specs/session-archive-mailbox.test.ts
OPENWORK_ARCHIVE_PRESSURE_MODE=baseline pnpm evals:e2e session-archive-pressure --local --engine v1 --surface electron
OPENWORK_ARCHIVE_PRESSURE_MODE=fixed pnpm evals:e2e session-archive-pressure --local --engine v1 --surface electron
pnpm evals:e2e session-mailbox-liveness --local --engine v1 --surface electron
```

Baseline mode is an investigative assertion of failure/recovery, **not** a passing UX claim. Fixed mode requires archive success before releasing pressure. Final verification must use fixed mode on the final head and restored production baseline as a revert-fails control.

Retained red runs: first bootstrap lacked the separate evals workspace install (`vitest` missing); installing `pnpm --dir evals install --frozen-lockfile` repaired that prerequisite. First pressure run's unchanged-count oracle rejected a fifth stream establishing after four original blockers; corrected to require all original blockers still live. A subsequent #5014-only run failed during setup navigation, before pressure; row hover-preview read succeeded but route stayed sessionless. Setup now uses the existing `session.open` affordance; the archive action remains a trusted UI click. None is labeled pre-existing without a clean control.

## Merge record

#5014 final head `eb24c339fee929402e5957cb29d5944ac166bc9e`; merge `d16d4a1aa9b4d8b8cf081b213ac9fa50628032b0`.

Verified required set via live dev rules: `openwork-tests-required`; it passed. Exact-head Warden APPROVED, zero failed required checks, zero review threads, every branch commit signed and DCO, no `.github/`, `.warden/`, `warden.toml` changes in PR diff. No Cloudflare failure was ignored on this final head. Head evidence comments: [deadline](https://github.com/different-ai/openwork/pull/5014#issuecomment-5703156344), [Electron](https://github.com/different-ai/openwork/pull/5014#issuecomment-5703157059), [gate summary](https://github.com/different-ai/openwork/pull/5014#issuecomment-5703167373).

# MCP App sandbox proxy timeout — 2026-09-15

## Verdict and scope

**Scoped fix: Passed. Incident attribution and requested hosted/dashboard matrix: Incomplete.**

A controlled browser experiment reproduces the exact reported timeout when either external proxy bootstrap dependency takes longer than the 10-second deadline. The stylesheet blocks the following classic script even when JavaScript has already downloaded. Inlining these small, trusted host constants removes those two requests. A delayed HTML document still times out with diagnostics and now has a working, tile-local Retry.

This is a demonstrated failure mechanism, **not proof that the installed app's incident had the same network delay**. No installed-app network trace was supplied or captured. All browser tests used newly launched, isolated local headless Chrome; no running user app, private profile, production account, or engine database was accessed. No server authentication was changed.

| Matrix | Before | After / qualification |
| --- | --- | --- |
| No faults, ten single + ten six-tile loads | 70/70 delivered, 0 proxy errors | 70/70 delivered, 0 proxy errors |
| 1-second CSS/script delay, six tiles each | 12/12 delivered | Bootstrap no longer requests these assets |
| 11-second CSS/script delay, one + six tiles each | 14/14 exact proxy timeouts, no ready/accept/init | Six tiles each with CSS, JS, or both delayed: 18/18 delivered, zero asset requests |
| Only first HTML document delayed 11 seconds | Deadline behavior remains intentional | One and six-tile cases: one diagnostic each; Retry restores only failed tile; exact input/result once; siblings unchanged |
| Revert inline bootstrap only | Regression spec fails: 0/6 delivered, 6 proxy errors (~30.25 seconds) | Restored fix passes the full deterministic spec |
| Three hosted providers, >=10 loads | Acquisition attempted | Third advertised safe demo call returns HTTP 401; hosted browser matrix **not run** |
| Real saved/local-cache and organization dashboards | Code traced | Full dashboard composition, cache/live swaps and Electron partitions **not live-tested** |

## Mechanism and handshake

References are relative to this worktree. Investigation baseline is `c67ba51ed`; `v0.18.47` has identical sandbox renderer/proxy source to that baseline. The reported `0.18.47-alpha` label was not independently mapped to an installed binary SHA.

1. **One existing OpenWork HTTP server, not one listener per tile.** `apps/server/src/server.ts:1071–1097` awaits `serve` and records its bound port. Static unauthenticated routes `/mcp-apps/sandbox.html`, `.js`, `.css` are registered at `server.ts:3535–3549`, with `Cache-Control: no-store`. MCP discovery or provider tool execution is not in these route handlers. `mcp-app-host.ts` resolves provider resources/launch leases; it does not allocate the outer proxy port per tile.
2. `apps/app/src/app/lib/openwork-server.ts:2033–2046` derives the proxy URL and expected origin from the selected server endpoint plus CSP/host-origin query parameters. The provider's `ui://` URI is not a browser navigation URL. Tiles using one endpoint share its origin/HTTP connection resources, not an app-specific server.
3. `apps/app/src/components/chat/mcp-app-frame.tsx:336–380` begins its effect only with resolved resource bytes. `:636–653` installs both parent message listeners **before** the startup queue assigns `iframe.src`. The shared queue at `:36–70` already admits two startups. The 10-second timer begins at navigation, not during queue wait or provider discovery.
4. **Pre-fix bottleneck: `apps/server/src/mcp-app-sandbox.ts:223` at the baseline** emits an external stylesheet followed by an external classic script. A pending stylesheet prevents that script from executing. Ready is a one-shot `postMessage` at script line 219, after validation of the host origin and registration of the proxy relay. An 11-second delay on CSS alone therefore gives `sandbox-navigation-started` with no `sandbox-proxy-ready`, even with downloaded JS.
5. The parent's ready handler (`mcp-app-frame.tsx:548–608`) accepts only that iframe's `contentWindow`, expected origin and ready method. It then connects AppBridge and sends secured HTML. No base64 decoding, provider HTML parsing, `srcdoc` assignment or provider initialization is required for **outer proxy ready**.
6. The outer proxy's sandbox remains `allow-scripts allow-same-origin`; its inner provider frame remains `allow-scripts` (`mcp-app-sandbox.ts:129–139`). Resource bytes are assigned to the opaque inner `srcdoc` only after ready (`:174–190`). The accept and initialized messages have their own existing deadlines. No origin, CSP, device permission, or action authorization was relaxed.

### Why intermittent / why siblings disagree

Each tile navigates independently. One bootstrap request can complete while another is stalled; a shared endpoint does not make those response timelines identical. The faulted six-tile experiment produces three queue-controlled pairs at approximately 10/20/30 seconds. This demonstrates a load-sensitive failure shape matching sibling disagreement, without establishing why a particular installed HTTP request was slow. HTTP connection saturation, renderer scheduling, CSS/script errors, and endpoint-specific faults remain possible triggers, not measured production causes.

The queue and listener-before-navigation fix already landed in #4996. Adding another queue or a blanket/adaptive longer deadline would not remove the demonstrated unnecessary request dependency. The earlier reported five-second chat trace predates the `v0.18.47` release commit timestamp; its exact binary version was not verified. Current chat and dashboard share the same ten-second constant.

### Hypotheses disposition

| Hypothesis | Finding |
| --- | --- |
| Per-tile port exhaustion / listener not listening | No per-tile listener allocation found. Server binding is awaited. Fixture also awaits its listener. Production startup availability was not measured. |
| Timer includes resource bytes/CSP/blob decoding | Provider resource is already resolved. The demonstrated wait is outer proxy CSS/script; provider HTML is delivered later. |
| Ready posted before parent subscribes | Ordinary initial race contradicted by current ordering and 70 immediate successful boots. No production listener buffer is warranted from this evidence. Navigation-generation/refresh races are not ruled out. |
| Saved locally vs organization auto-run | Both converge on `McpAppSandboxView`; cached resources can mount before live refresh completes. Distinct upstream resolution paths do not bypass the proxy. |
| Shared proxy server/lock | Shared server endpoint; global startup queue = 2. Browser request contention possible; no server-wide proxy mutex found. |
| Electron partition/webPreferences under load | Not measured. Test uses isolated headless Chromium, not installed Electron. |

## Surface paths and recovery

- Saved snapshots: `react-app/domains/dashboard/dashboard-apps.tsx:91–116` -> `react-app/domains/apps/generated-app-preview.tsx:16–34` -> shared renderer, read-only.
- Saved live apps: `react-app/domains/apps/live-generated-app.tsx:15–20` -> `McpAppTile`.
- Granted/organization apps: `react-app/domains/dashboard/dashboard-page.tsx:138–159` -> `McpAppTile` -> renderer (`mcp-app-tile.tsx:527–539`).
- Cached "Saved locally / refreshing" mounts and fresh result replacement are at `mcp-app-tile.tsx:158–168,352–367`. This is an additional source of navigation churn, not experimentally attributed here. Overlapping PR #5038 addresses continuity; this branch does not duplicate that work.
- Fix at `mcp-app-sandbox.ts:223–227`: inline only trusted host CSS/JS in the proxy response; preserve external routes for compatibility.
- Fix at `mcp-app-frame.tsx:325,660–666`: Retry clears the diagnostic and creates a fresh effect/iframe using the same resolved input and result. It does not call the launch tool again. Existing diagnostics, origin checks, queue limit and deadlines remain intact.

## Negative-space / why prior tests missed it

| Missing case | Old coverage | New evidence |
| --- | --- | --- |
| N tiles at once, real browser resource pipeline | Scheduling unit tests used synthetic ready events, `about:blank`, fake timers and a mocked bridge | Ten six-tile navigations; actual renderer, AppBridge, client URL builder, proxy HTML/script and opaque inner frame |
| Ready before listener | Current code already subscribes before navigation; synthetic unit signals cannot validate browser order | Real immediate-ready/control runs; no claim that an impossible initial browser ordering was reproduced |
| CSS downloaded late, JS already downloaded | Server VM tests execute script directly; route test inspected headers/body | HTTP finish/abort traces show downloaded JS but absent ready under delayed preceding CSS |
| Timeout followed by usable Retry | Shared error notice had no Retry callback | Real mouse click; exact input/result receipts once; unchanged sibling event sequences; late/aborted HTML response cannot duplicate initialization |
| Live provider + actual dashboard composition | Tile tests mock shared renderer | Opt-in hosted acquisition hard-fails on 401; full dashboard/installed Electron still missing |

## Reproduction and evidence

Run from the worktree root, with the requested mise binaries on PATH:

```sh
export PATH="$HOME/.local/share/mise/installs/pnpm/11.4.0:$HOME/.local/share/mise/installs/bun/1.4.0/bin:$HOME/.local/share/mise/installs/node/24.20.0/bin:$PATH"
pnpm install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile
OPENWORK_EVAL_HOST=local pnpm --dir evals run test:e2e specs/mcp-app-sandbox-startup.e2e.test.ts
pnpm --filter openwork-server test src/mcp-app-sandbox.test.ts
pnpm --filter @openwork/app exec bun test --isolate tests/mcp-app-frame.test.ts
pnpm --dir evals typecheck
```

Deterministic browser verdict: 3 passed, 0 failed, 0 skipped. Supplementary server suite: 19 passed / 159 expectations; renderer suite: 60 passed / 1,073 expectations. The browser tests are component integration, not a signed-in dashboard E2E. Unrelated chat card imports are isolated from the fixture; the sandbox/bridge/client/proxy modules are real. The loopback fixture uses the production proxy exports and CSP with an HTTP delay injector; it does not exercise the full Bun server dispatch stack (covered separately by the server suite).

Opt-in fourth test: supply `OPENWORK_SANDBOX_DEMO_ENDPOINTS` as a JSON array of three explicitly authorized static demo MCP endpoints, then run the same command. URLs and credentials are deliberately not committed. Read-only synthetic demo/input-only schema gates prevent live/private action calls. The configured attempt produced **3 passed, 1 failed, 0 skipped**, with `provider-3: tools/call failed (HTTP_401)`. No browser matrix is claimed from the two successful resource acquisitions.

Revert-fails control: restore only the baseline external `<link>`/`<script src>` HTML constant, keep the regression tests and Retry, then run:

```sh
OPENWORK_EVAL_HOST=local pnpm --dir evals run test:e2e specs/mcp-app-sandbox-startup.e2e.test.ts -t 'inline proxy ignores'
```

Observed exit 1, 1 failed, 2 filtered/skipped, expected 6 deliveries but received 0. Trace `evals/results/mcp-app-sandbox-startup/1789509253288-45838/inline-css-6.json`; failure receipt starts `2026-09-15T21-54-13-267Z`. Restore the fixed constant before the full passing run. Filtered tests are not passed claims.

Private/local investigation traces are under `evals/results/mcp-app-sandbox-startup/`: baseline `1789507807905-50122`, under-deadline control `1789507812991-50122`, delayed baseline `1789507820180-50122`. Each load includes navigation, message, HTTP request/finish/abort timestamps. Ambient assertion receipts live in `evals/results/test-runs/`; final-head receipts are published on the PR. Browser profiles, raw providers, tokens, and private diagnostic bundles are not published. Earlier global lint/ratchet failures outside these new files were not clean-control-classified and are not called pre-existing; scoped checks and typechecking passed.

## Release / demo guidance

Until the missing hosted and real-dashboard validation is completed, overall readiness remains **Incomplete**. Do not present a synthetic delay reproduction as definitive production RCA.

If the fix cannot ship: pre-open and verify each tile; avoid whole-board refresh immediately before presenting. If a tile fails on the installed build, use its existing tile refresh/reopen control where available, or reopen the conversation/view; avoid repeatedly refreshing healthy siblings. Single-tile control was reliable in the no-fault experiment but is not guaranteed under a genuine network stall. Prepare the already verified static captures as a clearly labeled non-interactive fallback. Validate the exact release/profile before the demo, including the calendar provider's authentication requirement.

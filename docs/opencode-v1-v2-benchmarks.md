# OpenCode v1 vs v2 benchmarks

This note records two benchmark lanes run on the same machine with the same
deterministic witness provider. All durations are milliseconds. Medians and
ranges below are calculated directly from the sample arrays in:

- `evals/bench/results/2026-08-31-m3max-engines.json`
- `evals/bench/results/2026-08-31-m3max-app-v1.json`

## What was asked and what each lane answers

The original questions map to the measured scenarios as follows.

| User question | App-perspective metric | Engine-perspective metric |
| --- | --- | --- |
| Time to first session, first load, and first send | `cold_boot_to_composer`, `first_send_cold` | `boot_ready`, `spawn_to_first_api_ok`, `first_prompt_cold` |
| Time to a ready session | `new_session_ready` | `session_create` |
| Workspace switch speed | `workspace_switch.aToB`, `workspace_switch.bToA` | `directory_switch` |
| Message response time | `message_rtt.userRendered`, `firstToken`, `complete` | `message.accepted`, `witness_first_byte`, `first_token`, `complete` |
| Very long message and compaction | `long_message`, `uiCompactionAvailable` | `long.*`, `compaction` |

### Lane A: app perspective, pure CDP

Lane A runs the real OpenWork Electron app on the v1 engine. It drives the app
only through the UI: CDP `Input.insertText` types into the real composer and
the real controls are clicked.

The witness provider is provisioned by a file on disk before workspace
creation. The benchmark chooses its model through the picker UI. There is zero
API seeding of workspaces, sessions, messages, or model selection.

This is the lane that answers what an OpenWork user sees today.

### Lane B: engine vs engine

Lane B compares the v1 engine, `opencode` 1.18.18, with the v2 engine,
`opencode2` 0.0.0-beta-18707. It sends identical user-shaped sequences over
each engine's own HTTP dialect and routes both engines to the same kind of
witness.

This isolates the engine boundary from OpenWork renderer and Electron costs.

### Why there is no pure-CDP v2 app lane

OpenWork's UI cannot run on v2 until the server-to-engine dialect adapter lands.
That adapter is stage 3 in
[`docs/opencode-v2-parallel-lane.md`](opencode-v2-parallel-lane.md#3-server-to-engine-dialect)
and is not part of the current parallel sidecar.

The v2 stack's own drivable surface is not a substitute. Its web UI, bundled
in the `opencode2` binary, crashes on `/new-session` with:

```text
Error: TitlebarRight must be used within TitlebarRightProvider
```

That failure was reproduced through CDP in Chrome 152 on 2026-08-30 with both
0.0.0-beta-18707 and 0.0.0-dev-18710. A narrow-viewport layout crashed the same
way. The older 0.0.0-beta-17823 home screen never opened a session view.

Building the v2 desktop app from source would benchmark a different app, not
the proposed engine swap inside OpenWork. Lane B is therefore the fair engine
comparison available today. Lane A should be rerun on both engines after the
adapter lands.

## Method

### Deterministic witness

Both lanes use a local HTTP witness provider. It streams exactly 20 tokens at
20 ms pacing, which imposes a 400 ms floor on completion. Usage is fixed.

The engine lane gives v1 and v2 separate API keys and asserts that every
request carries the correct lane key, model, and nonempty prompt. This catches
cross-lane traffic. The app lane similarly asserts its app-only key and model.

### Samples and machine

- Iterations: N=5.
- Exception: `first_prompt_cold` is intentionally one cold sample per engine.
- Reported values: median with minimum-maximum range.
- Platform: darwin arm64.
- Processor: Apple M3 Max, 16 CPUs.
- Memory: 48 GB.
- Node: v24.15.0.
- Lane B API polling resolution: 25 ms.
- Lane A UI polling resolution: 50 ms, from `pollResolutionMs`.
- Lane A app commit: `8d8d0105fd9e5bea4b7ff254833ee649b604e691`.

### Important cold-boot qualification

**Lane A runs a DEV BUILD: a Vite development server plus Electron dev. Its
cold-boot timings are not comparable to packaged-app startup.**

Each cold sample uses a fresh profile and workspace. Warm scenarios run in the
last cold instance only. The first cold iteration also pays first-compile cost,
which is visible in its higher sample.

### Metric boundaries

Lane B boundaries are:

- `boot_ready`: process spawn start until the managed engine reports ready; v2
  is additionally health-gated.
- `spawn_to_first_api_ok`: the same process spawn start through the first
  successful session-list response.
- `session_create`: immediately before the create request through a successful
  response containing a session ID.
- `first_prompt_cold`: immediately before the first prompt call through the
  message list containing the final witness token.
- `message.accepted`: prompt timer start through prompt admission response.
- `message.witness_first_byte`: prompt timer start until the witness receives
  the request.
- `message.first_token`: prompt timer start until a 25 ms message-list poll
  sees the witness nonce and `token 1`.
- `message.complete`: prompt timer start until a message-list poll sees the
  final witness token.
- `directory_switch`: immediately before listing a never-seen directory through
  that list and the first successful session creation in that directory.
- `long.*`: the message boundaries above, using an exact 200,000-character
  prompt.
- `compaction`: immediately before v1 `summarize` or v2 `compact` through a
  polled completed compaction record and a witnessed provider request.

Lane A boundaries are:

- `appInteractive`: desktop launch start until the desktop harness returns an
  interactive app.
- `workspaceReady`: that same launch start through UI workspace creation and
  selection.
- `composerReady`: that same launch start until the composer is editable and
  the Run task control is visible.
- `first_send_cold`: after untimed model selection, Run task click through the
  rendered final witness token and disappearance of the session loading
  indicator.
- `new_session_ready`: New task click until a distinct session route and
  surface exist, with an editable composer and visible Run task control.
- `message.userRendered`: Run task click until the exact new user turn appears.
- `message.firstToken`: the same click until `token 1` appears in the latest
  assistant turn.
- `message.complete`: the same click until the final token and witness nonce
  appear and the loading indicator is absent.
- `workspace_switch`: session-row click until the target workspace and session
  surface match and its composer is typable.
- `long.insertMs`: immediately before CDP `Input.insertText` until the composer
  contains the exact long payload; its other fields use the prepared-send
  boundaries above.

Timings are data, not performance assertions. The specs assert completion,
exact payload handling, workspace isolation, and witness fidelity only.

### Reproduction

```sh
OPENWORK_BENCH_ITERATIONS=5 pnpm evals:pr specs/bench-opencode-engines.test.ts
OPENWORK_BENCH_ITERATIONS=5 OPENWORK_EVAL_E2E_TESTS=1 pnpm --dir evals exec vitest run --config vitest.config.ts --project e2e specs/bench-openwork-app-v1.e2e.test.ts
```

Set `OPENWORK_BENCH_RESULTS_DIR` to retain the generated JSON files.

## Lane B results: engine vs engine (medians, N=5)

Delta is v2 minus v1. Negative means v2 completed this boundary sooner.
`first_prompt_cold` has one sample rather than five.

| Scenario | v1 median (min-max) | v2 median (min-max) | Delta |
| --- | ---: | ---: | ---: |
| `boot_ready` | 540 (526-565) | 516 (511-779) | -24 |
| `spawn_to_first_api_ok` | 683 (664-706) | 520 (514-787) | -163 |
| `session_create` | 7 (3-9) | 55 (49-119) | +48 |
| `first_prompt_cold` | 3494 (3494-3494) | 4502 (4502-4502) | +1008 |
| `message.accepted` | 4 (4-6) | 3 (2-3) | -1 |
| `message.witness_first_byte` | 11 (10-18) | 9 (9-10) | -2 |
| `message.first_token` | 447 (445-480) | 516 (491-546) | +69 |
| `message.complete` | 452 (447-481) | 517 (494-547) | +65 |
| `directory_switch` | 13 (10-21) | 49 (49-61) | +36 |
| `long.accepted` | 6 (5-12) | 14 (13-21) | +8 |
| `long.witness_first_byte` | 25 (17-51) | 10 (10-18) | -15 |
| `long.complete` | 487 (465-543) | 525 (514-537) | +38 |
| `compaction` | 469 (451-500) | 452 (446-480) | -17 |

### Interpretation

- **Boot to usable API:** v2 is faster on `spawn_to_first_api_ok`. This is a
  single daemon with health-gated readiness, measured from spawn through the
  first successful list call.
- **Session creation:** v1's 7 ms median is effectively in-memory-scale here;
  v2's 55 ms includes durable SQLite and location-graph work. Both are
  imperceptible beside UI session setup.
- **Directory switch:** v1 wins the measured first-list-plus-create boundary.
  This needs a prominent laziness caveat: v1 defers real instance/provider cost,
  and its cold cost appears in `first_prompt_cold`. V2 pays a bounded `LayerMap`
  location build during first touch.
- **Cold first prompt:** v1 npm-installs `@ai-sdk/openai-compatible` at first
  provider use; this is real product behavior. V2 bundles the compatible
  provider, yet its cold first prompt is higher in this run. **Hypothesis, not a
  measured explanation:** catalog/plugin generation settling plus the model-read
  gate on the first location account for some of that result.
- **Message dispatch:** witness arrival is about 10 ms in both lanes, so wire
  dispatch is effectively immediate.
- **Completion:** against the 400 ms witness pacing floor, median overhead is
  52 ms for v1 and 117 ms for v2.
- **First-token caveat:** Lane B `first_token` is when a message-list poll sees
  persisted text. It is not user-perceived streaming. OpenWork receives push
  events; Lane A measures a 92 ms v1 user-visible first token.
- **Compaction:** v1 `summarize` and v2 `compact` are witness-served and nearly
  equal on this boundary. Both are verified to reach the provider with their
  lane-specific key.
- **Overall:** at user-perceptible scales, warm engine message flows are within
  about 10% in this run. V2's case is architectural rather than raw latency:
  [no-reload provider injection](opencode-v2-parallel-lane.md#providers-on-v2-why-no-reload-is-needed),
  durable sessions, and one daemon for many directories.

## Lane A results: OpenWork app on v1, pure CDP (medians, N=5)

### Cold boot to composer: DEV BUILD, not packaged startup

| Metric | Median (min-max) |
| --- | ---: |
| `appInteractive` | 27089 (27022-36513) |
| `workspaceReady` | 38536 (38489-51020) |
| `composerReady` | 38537 (38490-51020) |

Iteration 1 is higher because it includes first compilation. Do not use this
table to predict packaged-app startup.

### Session and regular message flow

| Metric | Median (min-max) |
| --- | ---: |
| `first_send_cold.complete` | 2885 (2325-3583) |
| `new_session_ready` | 355 (335-403) |
| `message_rtt.userRendered` | 76 (75-83) |
| `message_rtt.firstToken` | 92 (88-133) |
| `message_rtt.complete` | 506 (490-523) |
| `workspace_switch.aToB` | 107 (97-133) |
| `workspace_switch.bToA` | 93 (89-132) |

A new prompt-ready session takes about 355 ms. Workspace restoration is about
100 ms. The first witness token is visible about 92 ms after clicking Run task.

### Exact 200,000-character message

| Metric | Median (min-max) |
| --- | ---: |
| `long_message.insertMs` | 43 (42-50) |
| `long_message.userRendered` | 108 (94-124) |
| `long_message.firstToken` | 167 (131-167) |
| `long_message.complete` | 540 (524-552) |

The 200,000-character CDP insertion itself takes 43 ms. Compared with the
regular-message medians, the long turn adds 32 ms to user render, 75 ms to
first token, and 34 ms to completion. In practical terms, the 200 KB paste adds
roughly 40-70 ms around the normal round trip, with the exact observed boundary
deltas stated above.

`uiCompactionAvailable=false`: OpenWork has no user-facing compact or summarize
control in this UI today. Engine-side compaction is covered in Lane B.

## Answers to the five questions

| Question | Metric today: v1 app and engine | V2 engine equivalent | Likely user-visible change after adoption |
| --- | --- | --- | --- |
| First session, load, and send | DEV composer ready 38537 ms; cold first send 2885 ms; engine API usable 683 ms | API usable 520 ms; cold first prompt 4502 ms | Packaged app must be measured separately; provider changes no longer require reload |
| Ready session | App ready 355 ms; engine create 7 ms | Engine create 55 ms | About +48 ms engine-side, likely hidden by current UI work |
| Workspace switch | 107 ms A→B and 93 ms B→A; unseen-directory engine touch 13 ms | Unseen-directory touch 49 ms | About +36 ms on first directory touch; revisits need an app-lane rerun |
| Message response | Visible first token 92 ms, complete 506 ms; engine complete 452 ms | Engine complete 517 ms | Warm flow is broadly equivalent; UI streaming cannot be claimed until Lane A runs on v2 |
| Long message and compaction | Exact 200000 chars complete in 540 ms; no UI compaction control; engine summarize 469 ms | Exact long prompt complete 525 ms; compact 452 ms | Long sends and witness-backed compaction are equivalent at this pacing floor |

The strongest expected UX difference is not a benchmark-table win. V2 can
apply provider changes without reloading the engine. Session create adds about
50 ms engine-side and first directory touch adds about 35 ms, both small beside
today's UI boundaries. Message flows are equivalent for practical purposes in
this sample.

## Follow-ups

- Rerun Lane A against v2 after the stage 3 OpenWork adapter in
  [`docs/opencode-v2-parallel-lane.md`](opencode-v2-parallel-lane.md#rollout-stages)
  exists. That will produce the true v2 app-perspective comparison.
- Report the `/new-session` web UI crash upstream against the anomalyco/opencode
  v2 branch, including the exact provider error and affected builds above.
- N=5 on one machine is directional evidence, not a population study. Treat
  single-digit-millisecond deltas as noise. The 400 ms pacing floor dominates
  completion metrics by design.

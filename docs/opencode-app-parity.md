# OpenCode app parity

## Real-model native parity

Run `OPENWORK_LIVE_INSTALLED_GATEWAY=1 pnpm evals:parity:live --iterations=3` for the real-inference suite. This is separate from the deterministic integration suite below. It never falls back to scripted model answers. It requires an existing locally configured OpenWork Gateway provider with two assigned models and a matching API key; the fixture reads that configuration without changing it, copies only the endpoint and model definitions into an isolated app profile, and enters the key through the app's masked local-provider form. The key is sent only to its original Gateway destination and is never recorded in evidence. Infisical can supply credentials for individually selected live tests through `OPENWORK_LIVE_PROVIDER`, `OPENWORK_LIVE_KEY_ENV`, and `OPENWORK_LIVE_MODEL`; the complete Gateway matrix requires the installed-provider opt-in.

The live runner produces `evals/results/engine-live-parity/<timestamp>/report.md` with named steps, screenshots, real model completion metadata, independently witnessed connector calls, and three native launch samples per engine. Missing, skipped, failed or duplicate cases fail the command. The starter-model test always uses a blank profile with no copied credentials, even when the Gateway opt-in is set.

Native live profiles and default workspaces are created in the operating system's temporary directory, outside the checkout. Before any conversation action, the fixture verifies the resolved workspace path and enclosing Git project. This matters because a real engine Restore operation can reset the entire enclosing Git project. The fixture stops its app and removes its temporary profile, including copied credentials, during cleanup.

| Real-model journey | Required outcome |
| --- | --- |
| Blank native installation | Production startup creates the default workspace, stays signed out, and sends the first message to its real default model. |
| Organization first send | Sign into a fresh organization, then send once; v2 create and prompt requests each survive an independently imposed 21-second delay without a false error or duplicated draft. |
| Conversation controls | Revert and restore history, edit/resend, fork at a boundary, and open an independent side chat. |
| Skills | Consume installed instructions through a witnessed native skill-tool call; v2 edits, removes and reinstalls them in the same conversation without engine reloads. |
| Models | Enter a real key in the app, browse assigned Gateway aliases, remove/add a model, select it, and obtain real answers from both. |
| Local MCP | Add a stdio process through Library and retrieve two changing results held outside the conversation and workspace. |
| Connectors | A real model searches Den capabilities, executes the discovered capability, and truthfully reports a second service failure. Only the external report service is a controlled witness. |
| Native launch | Fresh app profile to native bridge and editable composer, with shared build caches. Launch success is independent of inference success. |

Native context menus are real OS popups without DOM targets. Those choices use the existing development bridge after opening and inspecting the actual enabled popup; they do not call conversation APIs directly. No-reload checks require logs that actually observed inference, as well as an unchanged renderer document and engine PID. Native launch measurements include development build/harness overhead and are not packaged cold-start figures. Existing prepared Electron resources may be reused with `OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED=1`; this was needed on the current Mac because rebuilding the ComputerUse helper failed.

The empty browser-host test, `engine-live-parity.e2e.test.ts`, separately verifies a server starting with zero workspaces. Because the browser has no native folder chooser, it creates the first workspace through the real host API and then sends through the visible composer. The native blank-installation test covers the desktop's actual automatic workspace creation.

The signed-in first-send regression is covered by `LIVE-ORG`. Native v2 create and prompt writes receive a bounded 60-second startup budget because organization connection and skill reconciliation can exceed the ordinary 10-second read budget. The test delays the real HTTP requests on the wire; it does not substitute engine or model responses. Ordinary reads retain their original timeout, and the transport never automatically resends a write.

Slow “Starting” diagnosis: a read-only measurement against an existing 95-skill organization took 14.3s to download all skill bodies with four concurrent requests; bounded 32-way reads took 5.9s (one sample each, not end-to-end app timing). Den now publishes an opaque revision derived from the immutable skill version and rendered metadata. Each admission still initializes an authenticated MCP session and reads the current authorized index; only unchanged versioned bodies are reused. Updates, additions, removals, credential changes, and failed authorization invalidate the relevant cache. Older Den servers omit revisions and retain full fresh body reads. The warm-send improvement requires deploying the Den API changes as well as restarting the updated local server; it is not delivered by toggling OC2 alone.

The pinned v2 free starter service currently rejects real inference with HTTP 426, requesting OpenCode 1.18.0 or newer despite the native beta's `0.0.0-beta-19086` version. This remains a failing migration gate. Paid Gateway success must not hide that failure or be presented as complete first-boot parity.

## Local verification recorded on 2026-09-23

The development checkout completed 17 of 18 engine-specific real-model flow checks after targeted rechecks. The remaining failure was v2's free starter inference (HTTP 426). Gateway inference, conversation controls, skills, models, local MCP and Den capability execution passed on both engines. Each engine also completed three fresh native launch samples: ready-composer medians were 25,284 ms for v1 and 16,793 ms for v2. These include development build/harness overhead.

After applying the changes to current `dev`, app/server typechecks and 159 focused checks passed, including the real Chrome input test. The evals typecheck reported one error in the unchanged spend-limit spec (`radio` is not in `TargetRole`). The full live matrix was not repeated after this base update; the earlier results are not evidence for the new commit. CI evidence must bind to the PR head, and the live matrix still requires explicitly configured real credentials.

## Deterministic integration parity

Run `pnpm evals:parity` from the repository root. The command runs both pinned engines, then collects three fresh-profile app launch samples per engine. Use `pnpm evals:parity --iterations=5` for more timing samples.

The runner downloads only native engine executables into the ignored results directory, checks archive integrity and reported versions against `constants.json`, and never runs package installation scripts. Explicit `OPENWORK_OPENCODE_BIN` and `OPENWORK_OPENCODE2_BIN` overrides must report the pinned versions. The normal local E2E prerequisites apply: installed workspace dependencies, Chrome, Bun, and the local MySQL/Redis services used by the disposable Den fixture. Run this suite serially; simultaneous Den builds share generated dependency output.

The output is `evals/results/engine-parity/<timestamp>/report.md`. It links each journey to a human-readable page with named steps, screenshots and assertions. `results.json`, individual test JSON and logs sit beside it. A skipped, missing, duplicated, failed or wrong-engine case makes the command fail; a green subset cannot claim parity.

## What a person should be able to do

| Journey | Visible proof | Independent proof |
| --- | --- | --- |
| First boot | Open a fresh signed-out app, see Big Pickle selected automatically, type a task, receive its answer once. | No model preference is seeded; the upstream records the selected model and exactly one final answer. |
| Streaming | Read the first sentence while the rest of the answer is still unavailable. | The model fixture holds the second chunk until the screenshot and assertion complete. |
| Gateway models | Select an assigned model, receive its answer, add another model while the app is open, use it, remove the first model and stop offering it. | Real Den assignments, model groups, Gateway routing and upstream model IDs; three actual chat turns. |
| Skills | Install a skill and answer using its actual instructions. V2 also installs, edits, removes and reinstalls it across five turns in one conversation. | Random codes exist only in skill files. The real native skill tool reads them; prompts and canned replies never contain them. |
| Connectors | Discover an assigned capability, execute it and display the report; report a subsequent connector failure truthfully. | Real Den `search_capabilities` and `execute_capability`, with an external witness recording exact invocations. |

V1 uses its explicit legacy engine reload and app refresh in the Gateway journey and installs the skill before its first task. V2 must retain the same browser document, conversation and engine PID throughout hot updates. The v2 assertions reject both HTTP reload requests and internal engine rollover/in-place reload activity.

The stronger v1 skill experiment exposed an existing limitation: after an absent-skill turn, installing and reloading made the native catalog current, but the same conversation's skill tool still returned the old missing-skill result on 1.18.30 and 1.18.32. The v1 baseline covers working skill consumption; it does not claim this lifecycle works. V2 is held to the full lifecycle requirement.

## What is real and what is controlled

The renderer, OpenWork server, OpenCode executables, Den, MySQL and Gateway are real processes. Only the paid model responses and the external connector are local deterministic witnesses. Administrators change assignments and skill files through the real Den/OpenWork APIs; model selection, task submission, streaming and answers are exercised in the visible app. The model emits protocol-valid tool calls; engines and Den must perform the work and return the real result. This proves integration behavior, not the reasoning quality of a live model or the health of an external provider account.

Every app has an isolated profile, engine database, home, configuration and environment store. Den uses a disposable `openwork_eval_` database. Fixtures use synthetic identities and credentials. No production account is needed.

## Reading launch measurements

The launch clock starts immediately before starting the real app-web stack and ends at the interactive renderer or the ready composer. Model/Den fixture preparation and binary download are outside that boundary. First-answer timing starts when the user presses Run task. Each sample uses a fresh app profile; package/build caches remain shared. Engine order alternates between samples. The report shows median, range and sample count, and the evidence records engine version and source commit.

These are development app-web measurements, including browser and development-server startup. They are not packaged Electron startup numbers, cold filesystem-cache measurements or real-provider latency. App-web uses the same renderer and server paths and is the portable route for this comparison.

## Scope of a green result

For the deterministic suite, PASS means the five journeys above passed on both pinned engines, including the stricter v2 hot-update checks, and all requested timing samples were captured. It does not mean the repository's entire historical E2E suite is green or that the real-model migration gate passed. Older recovery-draft checks must be evaluated separately. Native live tests subsequently ran with prepared Electron resources; rebuilding those resources on this machine remains blocked by the ComputerUse Swift build.

The changes preserve conversation continuity (DESIGN P11). Review the attached screenshots for the actual model choices, messages, skill answers and connector results (DESIGN P10).

## Wider checks observed during this work

These results are separate from the targeted parity command; none are silently treated as passing:

- The earlier sessionless recovery check failed to restore the expected draft after recovery. First boot, first send and streaming in this parity suite are independently exercised.
- The broader server proxy test found `HEAD /opencode cancellation after ownership metadata stays request-scoped` returning 500 instead of 499. Several combined Bun server runs also ended with SIGTRAP after printing their assertion results; those commands are not clean passes.
- The evals typecheck reported 17 errors in existing analytics, sessionless-world and MCP sandbox files. Layer lint reported 61 existing violations; the new parity files introduced no reported violations. Existing channel/boundary ratchets also reported debt outside these journeys.
- Rebuilding desktop resources failed because the local ComputerUse Swift build could not parse a property list. The later native live suite used existing prepared resources successfully. Both app-web and native development launch timings were measured; neither is a packaged cold-start benchmark.

App and server TypeScript checks and the focused adapter, skill synchronization, proxy boundary, model-picker, reload, witness and result-guard tests are checked separately from that wider debt.

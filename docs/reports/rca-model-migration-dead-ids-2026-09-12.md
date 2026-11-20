# RCA: retired provider IDs, agent model discovery, and run errors

Incident date: 2026-09-12. Investigation continued into 2026-09-13 UTC.
Base: `0bd71ebf4dc0a312d7e38ddb2d8fac917e8b2402` (`origin/dev` when isolated).
Reported app: `0.18.47-alpha.2966`.

## Verdict and scope

**Confirmed mechanism and agent contract gap; exact migration execution time remains unverified.** The legacy-to-Gateway migration replaces resource identities; desktop reconciliation removes retired providers rather than aliasing them. Existing session bindings are not rewritten. Human-readable catalog names exist, but the previous agent contracts exposed only provider/model IDs. Admission of a prompt is not successful inference.

This patch implements Q3 and a deliberately bounded Q4: model names on read/list/create where resolvable, `models.list`, preflighted create-by-alias/displayName, and safe `session.read.lastError` for errors present in assistant snapshots. It does not remap existing sessions, implement re-pick UI, change `session.send`, fix event-only error persistence, or duplicate #4950's acceptance receipt.

Private transcripts, customer/research subjects, credentials, log payloads, and actual provider/session identifiers are intentionally not reproduced. No engine database was opened. Session evidence came exclusively from `session.read`; notification evidence came from `notifications.list`. No original failed session was retried.

## Timeline and confidence

| Time (UTC) | Evidence | Meaning / limit |
| --- | --- | --- |
| 2026-04-06 | `c442567005`, #1343 | Legacy LLM-provider resource/prefix introduced. Not an incident timestamp. |
| 2026-08-05 | `6119ede9ad`, #3526 | Remove-absent-provider reconciliation existed before Gateway migration. |
| 2026-09-11 14:49:11 | #4358 merge, `4fa0232350` | Gateway identities, migration endpoint, ownership-aware retirement reached dev. Deployment/execution not established. |
| 2026-09-11 18:47:58 | #4880 merge, `b72d9f042` | Reload status/retry corrections reached dev. Not evidence these changes initiated migration. |
| 2026-09-11 19:06:04.327 | Decoded timestamp of live provider-notification ID using the actual ID constructor | **Initial creation of the coalesced notification**, not necessarily time of its current title. Current title: “4 new providers & 14 new models available”; count: 6. |
| 2026-09-12 22:05:18.310 | `session.read` metadata for an original failed research launch | Session created with retired legacy provider and named model ID. Updated at 22:05:19.493; returned one user message, no last assistant, `idle`, `working:false`, old binding retained. |
| 2026-09-12, reported | User incident account | Two dead launches, subsequent attempts, and three model probes; manual picker selection recovered the intended model. Error text `ProviderModelNotFoundError` reported from engine log, not independently re-read here. |
| Investigation | Live Sentry searches, desktop-app errors and den-api logs, last 48h | No matching model-not-found events or migration-path log rows returned. Absence is not proof that migration/failure did not happen. |

`notification-store.ts:71–73` encodes `now` in base36; `:145–159` retains the original ID while updating title/count/updatedAt. The public notification query omits createdAt/updatedAt. Therefore treating the decoded ID timestamp as the exact replacement timestamp would be incorrect. The new-provider listener coalesces notifications (`apps/app/src/react-app/shell/new-providers-listener.tsx:172`).

Sentry queries were `error.type:ProviderModelNotFoundError` in desktop-app and both `message:"*migrate-to-gateway*"` and the actual route-name query `message:"*migrate-from-llm-provider*"` in den-api logs. All returned no results. Exact incident migration actor, request receipt, and local cleanup timestamp remain unknown. [Desktop error search](https://different-ai-inc.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=error.type%3AProviderModelNotFoundError&project=4511908094017536&statsPeriod=48h) and [migration log search](https://different-ai-inc.sentry.io/explore/logs/?logsQuery=message%3A%22*migrate-from-llm-provider*%22&project=4511728271360000&statsPeriod=48h) are live dashboards, not immutable incident receipts.

## Q1 — Identity replacement and desktop application

- **`lpr_` means LLM provider, not local provider.** `ee/packages/utils/src/typeid.ts:43` maps `llmProvider` to `lpr`; `:105` maps `inferenceProvider` to `ipr`.
- The explicit admin endpoint is `POST /v1/inference-providers/migrate-from-llm-provider` (`ee/apps/den-api/src/routes/org/inference-providers.ts:609`). It supports eligible shared models.dev providers, not per-member credentials (`:626`).
- In one transaction it creates a new inference-provider ID and stores provenance in `settings.migration.llmProviderId` (`:645`), copies models/credentials/audiences (`:647–650`), then deletes old access/model/provider rows (`:651–653`). This is not a lexical prefix rename or runtime alias.
- Desktop fetches legacy and Gateway catalogs together (`apps/server/src/cloud-provider-sync.ts:541`). Runtime provider keys are Den resource IDs, except hosted `source=openwork` maps to `openwork` (`:571`). Gateway model IDs are composite `gwm_…_…_…` identities (`:386`); changing only the provider prefix cannot repair a session.
- Sync computes desired and retired owned providers (`:1222–1226`), removes absent global entries via null patches and inserts new entries (`:1247–1256`). Credential cleanup is ownership/hash guarded (`:1237–1268`). Managed workspace overrides are removed (`:1361–1388`). Retired engine auth is removed by its owner (`apps/server/src/managed-provider-auth.ts:357–384`). None of these paths rewrites session model bindings.
- The flagged `cloud-provider-sync.ts:1271–1315` block applies workspace cleanup, writes runtime configuration, delivers auth, and requests/defer/retries an engine reload. It **materializes** the changed catalog; it does not itself choose to migrate an LLM-provider resource.
- `apps/server/src/engine-pool.ts:944` aborts event proxies on generation promotion so clients reconnect. It does not translate model IDs. Draining protects existing work but does not make an idle old binding valid on a new generation.

**Causal confidence:** the implementation precisely explains the observed old/new resources and failed lookups. Without the incident's migration receipt, it is still possible the resources were manually recreated instead of using the migration endpoint. Do not infer the exact initiating operation solely from the prefixes.

## Q2 — What stale bindings do

There are two stores/paths, not a universal automatic replacement:

1. Engine session records carry the bound provider/model. Headless `session.send` posts only message ID/text to `prompt_async` and returns acceptance; it does not resolve a replacement (`apps/server/src/opencode-plugins/openwork-extensions-preview.ts`, `sendOpenWorkSession`, originally `:961–980`). A retained removed identity can therefore reach the same engine lookup failure. The observed original session remains bound to the removed identity and appears idle with no assistant. We did not re-send to establish a second live failure.
2. Composer session overrides persist in `openwork.sessionModels.v1` (`apps/app/src/react-app/domains/session/surface/session-model-store.ts:21,143–164`). They win over the new-task default. Changing that default does not migrate existing overrides.

The composer is **not wholly unguarded**:

- `model-availability.ts:59–103` yields pending during loading/cloud reconciliation, then unavailable for a settled missing model; `:116,151–164` confirms catalog absence for 1,200 ms (policy blocks immediate).
- `apps/app/src/react-app/shell/session-route.tsx:1483–1489` rechecks on send. Pending can still send. `:1579–1595` uses the selected IDs; the background drainer also uses remembered IDs without the same availability gate (`domains/session/sync/global-queue-drainer.ts:94–162`).
- Confirmed unavailable disables submit (`session-surface.tsx:3448`) and shows “Model no longer available” (`surface/composer/composer.tsx:1785–1803`). The underlying dead model remains selected until replaced; it is not displayed as a healthy available choice.
- The picker auto-opens for a confirmed missing conversation override (`session-route.tsx:1205–1226`); choosing a model updates that session (`session-surface.tsx:1146–1149`). Refresh reruns sync, not resurrection of deleted records.
- `managed-models-recovery.ts:26–34,46–54,89–94` gates transient availability, auto-opening, and refresh. It is not a legacy-to-Gateway mapping table or bulk session migration.

**Design-owned:** the frozen re-pick investigation asks for this-session versus other-active-sessions scope, with obsolete/archived conversations excluded by default. Its returned last text was intermediate prototype work, not a concluded design. Read-only review of `reports/model-unavailable-repick/prototype.html` in the main checkout confirms a clickable exploration of those alternatives, not shipped runtime behavior. Recommend explicit this-session default plus opt-in, previewed active-session scope; honor current policy and avoid silent bulk migration. This remains Ben's OPE-48 area. No UI built here.

## Q3 — Catalog ownership and agent fix

Names are not discoverable by asking a model to identify itself. They belong to catalog records:

- Migration copies `LlmProviderModelTable.name` into Gateway models and provider name into the new record (`inference-providers.ts:645–648`).
- Desktop materialization preserves catalog names (`cloud-provider-sync.ts:628,646`) alongside runtime IDs.
- The picker reads the connected workspace provider catalog; model title is `model.name || id`, provider description is `provider.name` (`use-model-picker.ts:129–149`). It additionally applies cloud sign-in and desktop-policy filtering (`:152–169`).
- The remote OpenWork Models skill manages upstream models.dev overlays/aliases through the repository scripts. Those aliases are not an authoritative mapping from a member's changing `ipr/gwm` resources. No overlay/model assignment was modified.

No `models.list` affordance existed in this base/live context. This patch adds it and reuses the picker's connected-catalog names and policy/sign-in filters:

- `packages/types/src/openwork-affordance.ts:80–145`: selector validation, catalog projection, label decoration, exact case-insensitive name resolution. IDs remain authoritative when a returned model object includes displayName metadata; alias plus ID is rejected. Ambiguous names require a provider qualifier. No substring/fuzzy match or silent default.
- `apps/app/src/react-app/domains/session/control/session-control-actions.ts:109–143`: `models.list {workspaceId}` returns `{providerId,modelId,displayName,providerName,available:true}`; unrelated workspaces are not read, no navigation/focus. Disconnected, signed-out cloud, and policy-blocked options are omitted. Assigned fallback options that have not reached an engine are deliberately not called available.
- `list-control-sessions.ts:126` decorates existing bindings without mutation. Read uses the same underlying names where resolvable; failed catalog reads leave raw IDs intact.
- `openwork-extensions-preview.ts:1135–1164`: all explicit batch models are resolved before create/prompt writes. The catalog is obtained through the existing renderer-host query, validated for the exact requested workspace, and never replaced with a raw-catalog selection fallback. Engine writes receive canonical IDs/effort, not labels.

**Host requirement / tradeoff:** explicit-ID and named creation now require the existing renderer-host `models.list` response, like the existing renderer-backed session inventory. Headless here means no UI navigation/focus, not renderer-free operation. Missing host or mismatched catalog fails closed. Model-free creation retains engine-default behavior. Standalone renderer-free selection would need a server-owned effective catalog API; it is not fabricated here. Availability is a snapshot, not authorization forever: downstream policy/engine checks still apply, and a removal after preflight can still fail a run.

## Q4 — Run error observability

Admission can be followed by asynchronous failure. #4950 is OPEN and owns changing the false `started:true` receipt to `accepted:true`, indexed HTTP failures, and partial batches. This branch is based on dev, does not cherry-pick it, and deliberately leaves that receipt untouched. Both branches touch the create function; preserve preflight/labels plus its acceptance semantics when combining.

- Renderer `session-sync.ts:998–1033` handles live `session.error`, marks error activity, notifies, and inserts a synthetic transcript error. `session-activity-store.ts:509–532` holds error state in memory, not durable run history.
- `usechat-adapter.ts:220–224` reconstructs an error from assistant `message.info.error` if the engine snapshot contains it.
- Before this change, headless reads kept text only and dropped messages with no readable text. A failed assistant containing only error metadata was invisible. `session.list_sessions` may report renderer error state if its event was observed; `session.read` engine activity can still report idle. Neither is a durable guarantee.
- `openwork-extensions-preview.ts:849–868,908–915` now returns `lastError:{code,message}|null` in normal and summary reads, inspecting the newest assistant in the loaded snapshot **before** text filtering. Later error-free assistant clears it. Known error names, including `ProviderModelNotFoundError`, map to fixed safe messages; unknown names become `UnknownError`. Raw response bodies, headers, provider strings, and credentials are never copied into this new field.
- Tail reads inspect their fetched `count`; start/summary reads fetch full transcript. Null means no error on the latest assistant **in that loaded window**, not “this run succeeded” or “this session never failed.” An error may precede a newer user retry; the field is not a terminal run receipt.

**Remaining hard gap:** this checkout does not establish that a model lookup failure before assistant creation is persisted in `info.error`. Event-only/pre-assistant failures remain unobservable after the event is lost. Fixing that requires durable run/event receipts, not pretending this projection solves the original incident in every case. No `lastError` was added to list results because that would misleadingly conflate transient renderer state with persisted snapshot errors.

#4937 remains OPEN, not merged into this base. Its proposed tool-parts/activity projection is independent: integrate this metadata-level signal without duplicating or exposing raw tool/error payloads. Other sessions' tool calls were not observable via this runtime's session affordances; no database fallback was used.

## Negative space: why existing checks did not catch it

| Missing scenario / contract | Prior coverage gap | This patch / remaining proof |
| --- | --- | --- |
| Create with a model ID the provider no longer has | Valid-shaped IDs and successful create/prompt witnesses; no available-catalog membership preflight | Removed IDs, disconnected/blocked models, stale discovery, and mixed valid/invalid batch assert zero engine writes. |
| Send into a session bound to a removed provider | Sync tests prove config/auth ownership and reload, not persisted session rebinding | Documented unchanged risk; no live-send claim and no UI migration built. Add an engine-backed negative E2E to re-pick work. |
| Agent resolves model by display name | Previous schema required provider/model IDs; no discoverable workspace catalog | Alias/displayName, ambiguity, provider qualifier, full returned-model round-trip, workspace identity, and canonical IDs on both writes asserted. |
| Raw catalog differs from selectable picker policy | Connected does not by itself mean entitled | Renderer action tests exercise policy/sign-out/disconnected filtering; selection uses that host result, not raw fallback. |
| 204 accepted, run then fails with no text | HTTP acceptance tests cannot establish later run success; text projection hid error-only assistant | Snapshot lastError and clearing/window semantics asserted; event-only failure explicitly remains. |
| Model probes self-identify opaque IDs | Model knowledge is not member catalog metadata | Query display names instead; no live probe sessions created by this investigation. |

## Ranked follow-ups

1. **This PR:** agent catalog, strict named selection, raw-binding labels, safe observed snapshot error signal. Small production change; deterministic tests below.
2. **#4950:** honest acceptance/error receipts. Combine without discarding this preflight, and retain its separate sidebar-transport scope.
3. **Run receipt ownership:** persist early `session.error`/pre-assistant failures with run/message identity and expose a bounded terminal signal, coordinated with #4937. Required to eliminate idle-with-no-answer ambiguity after 204.
4. **OPE-48 design:** explicit per-session replacement plus previewed opt-in active-session scope. Pending-state/queued-send behavior needs engine-backed tests. No silent guessing across provider identity/credential-group changes.
5. **Migration provenance:** expose a durable old-to-new mapping/audit receipt including model/group/credential-set identity, not merely prefix substitution. Use it to suggest replacements; require current entitlement and user scope choice.
6. **Diagnostics:** expose notification createdAt/updatedAt and materialization/migration receipts; record model lookup errors safely at their actual owner. The coalesced notification cannot establish exact timing.

## Verification and boundaries

Local fallback: Daytona API credentials/service URL were absent from the execution environment. Toolchain: mise Node 24.20.0, Bun 1.4.0, pnpm 11.4.0. Tests use synthetic HTTP witnesses; no paid inference, live provider migration, real-session writes, or database access.

- `pnpm evals:pr specs/session-model-aliases.test.ts`: one test with 33 behavioral assertion sections, zero skips. Real plugin facade plus renderer inventory projection; not live-engine E2E.
- `pnpm --filter openwork-server test src/opencode-plugins/openwork-extensions-preview.test.ts src/opencode-plugins/openwork-provider-adapters.test.ts`: 123 passed, 0 failed.
- `pnpm --filter @openwork/app exec bun test --isolate tests/session-model-catalog.test.tsx`: 9 passed, 0 failed; mounted renderer actions, including policy/sign-out filtering.
- App and server typechecks pass; `git diff --check` passes.
- **Revert-fails:** replacing alias/name selection with IDs-only lookup makes the testkit spec fail at create-by-alias (exit 1); restoring it recovers. Replacing lastError projection with null makes the same spec fail on the error-only assistant assertion (exit 1); restored before final proof. Neither mutation is committed.

Broader checks are **baseline red**, not claimed passed. Same exact commands/toolchain were run on a clean detached control at `0bd71ebf4dc0a312d7e38ddb2d8fac917e8b2402`:

| Command | Task / control | Matching signature |
| --- | --- | --- |
| `pnpm --filter @openwork/app exec bun test --isolate tests/session-archive-agent-contract.test.tsx` | exit 1 / 1; 6 pass, 3 fail each | Lines 261/276 return cancelled instead of working warnings; line 289 dialog timeout. |
| `pnpm --dir evals run typecheck:spec-layer` | exit 2 / 2; 12 diagnostics each | Two TS1294 in generic-oauth.ts:218–219; ten Promise.withResolvers TS2550 in chat/first-run/session-shell worlds. |
| `pnpm --dir evals run lint:layers` | exit 52 / 52; 52 violations each | 51 specs-use-testkit-only and one worlds-use-seed-layer. No extra violation from this spec. |

Changed-claim verdict is Passed once final-head evidence is published; repository-wide validation is not wholly green. The PR evidence is authoritative for final commit/run identity. Production diff is 229 changed lines (tests/report excluded). No re-pick UI, original-incident engine reproduction, durable event-only capture, or complete migration time is claimed.

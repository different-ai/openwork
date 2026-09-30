# Experimental verification dictionary

Compile a verification intent once into a **closed set of checked-in checks**, then
replay those checks with **zero model calls**. Jev selects relevant checks; it is
not a model judge of the application, does not run tests, and cannot author actions,
selectors, JavaScript, expected values, or observation readers.

The implementation contracts are [core](./packages/testkit/src/verification.ts),
[gateway adapter](./packages/testkit/src/verification-jev.ts), and
[benchmark CLI](./scripts/verification-benchmark.ts). Both functions and the adapter
are exported by the normal `@openwork/testkit` barrel. Importing them does not opt
into a live service; constructing and invoking the live evaluator does.

## Compile, then check

`compileVerification({ intent, dictionary, evaluate, timeoutMs?, signal? })` sends
one evaluator batch: one `coverage` question and one relevance question per entry
(`check_0`, `check_1`, …). Coverage asks whether the dictionary can express the
whole request, including rejecting action requests and unsupported assertions.
Relevance asks which descriptions are requested or necessary, **not whether they
are true in the app**. The dictionary supports 1–32 uniquely identified checks.

Coverage must be at least **0.9**. Entries at least **0.9** are selected; entries
at most **0.1** are excluded. Any entry strictly between those thresholds, low
coverage, or an empty selection produces `incomplete`. These are experimental,
uncalibrated thresholds, not an established confidence guarantee. Malformed
answers, provider errors, timeouts, and cancellation also produce `incomplete`;
invalid caller data can throw before evaluation. Neither an incomplete result nor
an error is a pass. Do not silently skip verification after either.

Coverage and relevance are independent model judgments, not a proof that the
selected subset covers every requested claim. A high-confidence wrong omission
remains possible. Review compiled plans and retain author-written required
assertions; do not replace release gates with model-selected coverage.

`runVerification({ plan, dictionary, observations?, channels })` validates the
plan and every selected observation binding before executing checks in dictionary
order through the supplied **real `step`**. It returns `status: "passed"` only
after completion; mismatches or invalid plans throw. A plan is reusable, but each
replay reads current state. Deterministic replay means fixed assertions, not a
guarantee that a changing application will produce the same result.

### Supported assertion kinds (not the entire author vocabulary)

| Kind | Replay operation and semantics |
| --- | --- |
| `see` | `user.see(target, options)`: visible target, optional `editable`, exact `value`, exact string `text`, and `timeoutMs`. |
| `notSee` | `user.notSee(target, { timeoutMs })`: sustained **sampled absence** over the window (default 3 seconds), not one negative snapshot or proof of continuous absence between samples. |
| `textContains` | Poll `probe.text()` for string inclusion with `probe.eventually`; default 10 seconds. |
| `observe` | Poll an author-bound named reader, traverse its explicit `path`, and apply `equals`, string `includes`, `length`, numeric `atLeast`, or numeric `atMost`; default 10 seconds. |

`textContains` and `observe` enforce a wall-clock deadline even if a read stalls.
Observation readers receive an `AbortSignal`; pass it to supported transports.
Uncooperative in-flight reads cannot be forcibly stopped, but their late result
cannot pass verification. Reader exceptions are terminal, not evidence of absence.

`see`/`notSee` locate targets and may scroll the viewport. This is
**product-data-read-only**, not pure or free of UI effects. Observation readers
must likewise be reviewed as read-only; the function type cannot enforce purity.
`Target` accepts a string or six optional object fields: `text`, `role`, `label`,
`placeholder`, `testId`, `nth` (an object needs at least one field besides `nth`).
Its 13 roles are `button`, `link`, `textbox`, `checkbox`, `switch`, `menuitem`,
`tab`, `option`, `separator`, `combobox`, `listbox`, `alert`, `heading`.
Full author code can use regular expressions for target text/label and `see.text`;
persistent dictionary assertions deliberately accept only the JSON string subset.

## Full channel vocabulary: 59 methods

Counts are distinct public method names **per channel**, excluding overloads:
19 seed + 13 user + 9 agent + 18 probe. Sources:
[Seed](./packages/env/src/seed.ts) and
[User/Agent/Probe](./packages/testkit/src/spec/types.ts). This inventory describes
author code, not permission for the model to invoke those methods.

| Channel | Methods (count) | Effects / purpose | Verification fast path |
| --- | --- | --- | --- |
| seed | `den`, `desktop`, `appWeb`, `web` (4) | Boot or attach resources and arrange surfaces. | Out; arrange the world first. |
| seed | `workspace`, `session`, `sessions`, `signIn`, `api`, `orgConnection`, `nativeConnector` (7) | Arrange product state, identity, connections; API may write. | Out. |
| seed | `mock`, `faultProxy`, `denLink`, `tmpPath` (4) | Fixtures, fault/network controls, temporary paths. | Out. |
| seed | `composerText`, `deepLink`, `browserFixtureDiscovery`, `evalIn` (4) | Renderer arrangement and fixture controls; `evalIn` is migration-only raw write escape hatch. | Out; never generated by the model. |
| user | `click`, `rightClick`, `dblclick`, `type`, `press`, `hover`, `reload`, `navigate` (8) | Input, focus/hover, navigation and application mutations. | Out. |
| user | `see`, `notSee` (2) | Assertions with polling/target location; may scroll. | In, directly. |
| user | `screenshot`, `looks`, `on` (3) | Capture evidence, visual judging, bind a surface. | Capture/judging out; authors may bind `on` before replay. |
| agent | `browserTask`, `browserRequest`, `desktopApi`, `run`, `send`, `createSession`, `list`, `actions`, `on` (9) | Agent work, requests, sessions, discovery, surface binding; includes write-capable operations. | All out; even discovery is not a generated action. |
| probe | `zoom`, `browserState`, `browserTabMetrics`, `browserFixtureState`, `dom`, `has`, `composer`, `connectorCatalog`, `storage`, `hash`, `connectState`, `api`, `desktopApi`, `toolCalls` (14) | Read projections, fixtures, state, API responses and recorded calls. `probe.api` enforces GET; its response status still needs an assertion. | Only through trusted named `observe` bindings; bind concrete arguments and reviewed read-only API operations in author code. |
| probe | `text`, `eventually` (2) | Read visible text and bounded polling. | In for `textContains`/`observe`; may also support trusted readers. |
| probe | `eval`, `on` (2) | Author browser-evaluation escape hatch; surface binding. | No model-authored raw evaluation. Authors bind `on` outside the plan; prefer fixed named projections over `eval`. |

Named reads bind to existing composer, DOM, hash, zoom, connect state, connector
catalog, read-only API, tool-call and other reviewed projections—not raw eval
from the model. An observation is `{ version, read: (signal) => Promise<unknown> }`;
the check references `{ id, version }`, a path, and a predicate. Credentials and
surface handles stay in closures, never in a persisted plan. Missing bindings,
version mismatches, and unsafe/missing paths do not become successful checks.

## Four-check example

This helper belongs in an existing spec with an arranged, surface-bound
`{ user, probe, step }` context. It assumes the journey has already entered the
synthetic draft `Review notes` and displays `Run task`; it does not arrange that
state or send a message. `see` uses exact string text, not `value` for the
contenteditable composer. The named reader's actual field is `draftText` (see
[ComposerState](./packages/behaviors/src/composer.ts)), not `text` or `value`.

```ts
import {
  compileVerification, runVerification, createJevVerificationEvaluator,
  type VerificationDictionary,
} from "@openwork/testkit";

const dictionary: VerificationDictionary = {
  id: "draft-review", version: "1", checks: [
    { id: "composer", description: "The composer is editable and says exactly Review notes",
      assertion: { kind: "see", target: "composer",
        options: { editable: true, text: "Review notes" } } },
    { id: "no-error", description: "Model no longer available stays absent for three seconds",
      assertion: { kind: "notSee", target: "Model no longer available", timeoutMs: 3_000 } },
    { id: "run-label", description: "Visible page text contains Run task",
      assertion: { kind: "textContains", text: "Run task" } },
    { id: "draft", description: "The composer draftText equals Review notes",
      assertion: { kind: "observe", observation: { id: "composer", version: "1" },
        path: ["draftText"], predicate: { kind: "equals", value: "Review notes" } } },
  ],
};

// Explicit live opt-in: requires JEV_AI_GATEWAY_API_KEY and transmits descriptions.
async function compileDraftPlan() {
  const result = await compileVerification({
    dictionary,
    intent: "Verify all four: editable composer says exactly Review notes; "
      + "Model no longer available stays absent for three seconds; visible page "
      + "text contains Run task; composer draftText equals Review notes.",
    evaluate: createJevVerificationEvaluator(),
  });
  if (result.status !== "ready") throw new Error(result.reason);
  return result.plan;
}

// Call compileDraftPlan once; retain its plan for subsequent replay calls.
async function replayDraft(
  plan: Awaited<ReturnType<typeof compileDraftPlan>>,
  { user, probe, step }: Pick<import("@openwork/testkit").SpecBodyContext<unknown>,
    "user" | "probe" | "step">,
) {
  return runVerification({ plan, dictionary,
    observations: { composer: { version: "1", read: () => probe.composer() } },
    channels: { user, probe, step }, // actual spec step, not a no-op wrapper
  });
}
```

## Trust, freshness, and privacy

The canonical SHA-256 dictionary digest covers IDs, descriptions, versions,
targets, options, expected values, observation paths/predicates and observation
versions. Changing any of these invalidates the old plan. It does **not** hash a
reader's function body: bump its observation version when semantics change.
The digest is **not a signature** or proof of trusted compilation. Plans contain
intent, selected IDs and probabilities; protect their provenance and review them
as trusted artifacts. A party able to rewrite a plan can rewrite its probabilities.

Stale expected values require rebuilding the dictionary and recompiling, not
asking the model to repair expectations until the test passes. There is no
learned auto-heal, selector repair, generated test code, or automatic expansion of
the vocabulary. Descriptions must faithfully describe the bound assertions.

The adapter pins its wire contract to inspected `@ai-sdk/gateway@4.0.85` source
(documented source offsets in the adapter), without adding an SDK runtime
dependency. It uses the fixed Vercel AI Gateway evaluation route and model
`typesafe-ai/jev`, not an invented direct TypeSafe endpoint. This avoids an SDK
dependency; it does **not** resolve external-service/privacy policy by itself.
Live use requires explicit opt-in and authorization for external transmission.
Only intent and dictionary IDs/versions/check descriptions, plus fixed evaluator
questions, are sent—not browser state, screenshots, assertion targets, reader
results, or executable code. Intent/descriptions can still contain sensitive
information: authors must sanitize them before opting in. Keep API keys out of
plans, dictionaries, evidence, logs and examples.

## Offline and live benchmark CLI

From the repository root, with the evals workspace installed:

```bash
node evals/scripts/verification-benchmark.ts
```

Offline mode uses an exact-intent ground-truth fixture and single-attempt in-memory
channel stubs. It checks plumbing, replay and a deliberately wrong expected-value
negative control—not semantic accuracy or UI behavior.

For an authorized live run, use the repository-linked Infisical project and
`dev` environment. The required secret is `JEV_AI_GATEWAY_API_KEY`, a **gateway**
key. The current CLI's `--output` listing route is unsupported; do not list
secrets or print values to discover it. Injection plus a one-key boolean presence
check avoids exposing secret values:

```bash
infisical run --env dev --recursive --silent -- node -e 'const present = Boolean(process.env.JEV_AI_GATEWAY_API_KEY?.trim()); console.log(JSON.stringify({ JEV_AI_GATEWAY_API_KEY: present })); process.exitCode = present ? 0 : 2'
infisical run --env dev --recursive --silent -- node evals/scripts/verification-benchmark.ts --live
```

Proceed only when the first command reports `{"JEV_AI_GATEWAY_API_KEY":true}`.
If absent, stop and ask for that secret in the authorized project/environment.
Never print it, enable shell tracing, dump the environment, or save it to a file.
Infisical injection may expose other project secrets to the child process; keep
the child command trusted and bounded. No secret retrieval or live run is implied
by this documentation.

### Measurement and interpretation

The CLI has 12 synthetic scenarios and replays each ready plan three times. Record
each scenario's expected/selected IDs, `status`, `selection`, availability,
`requestCount`, `compileMs`, adapter `metrics.durationMs` and optional token usage,
`replayMs`, and `replayStatus`. Core `modelCalls` counts evaluator invocations:
one for attempted compilation (zero if already cancelled), zero for replay.
Offline evaluator invocations are **not service calls**. In live mode instrument
the adapter/transport to confirm service requests; it makes one POST per invocation
and has no retry loop. Keep the independent offline negative-control invocation
separate from live request counts.

Report compile and replay p50/p95 separately, with sample count and mode. These
durations exclude app boot; the synthetic benchmark boots no app at all. For a
real journey measure boot separately and start the verification timer after world
arrangement. Track incorrect selections, supported abstentions, expected-negative
abstentions and provider unavailability separately; incomplete is never a pass.
Ready-only accuracy omits abstentions, so report it alongside the exact-ready
fraction of all cases. Exit 1 indicates incorrect selection, replay failure or a
broken negative control; exit 2 indicates missing configuration, unavailable
service or supported abstentions; exit 0 does not turn expected abstentions into
passes. Mocks are not semantic proof; a small live sample is not broad calibration.
No latency, accuracy, benchmark or E2E result is claimed here.

## Design references, not benchmark evidence

- TypeSafe skill examples [function calling](https://docs.typesafe.ai/cookbooks/function_calling.md),
  [fan-out](https://docs.typesafe.ai/patterns/fan-out.md), and
  [semantic search](https://docs.typesafe.ai/cookbooks/semantic_find.md):
  useful conceptual references for closed-set selection and batched relevance.
  They do not extend this API into action execution or model-authored assertions.
- [Playwright best practices](https://playwright.dev/docs/best-practices): primary
  guidance on testing user-visible behavior, isolation, resilient locators and
  retrying assertions; applicable to dictionary authoring, not a claim that this
  implementation uses Playwright.
- [agentic-qe-framework-v3](https://github.com/sreevsr/agentic-qe-framework-v3):
  a deterministic-replay comparator to inspect, not evidence of relative speed,
  accuracy, equivalence or a reproduced benchmark.

# A little constellation. A lot of work.

**Think big. Work lean.**

Alpha candidate, 2026-09-08: `feature/coworker-alpha-refresh`, based on the
newer Coworker candidate at `045912ad9` and rebased onto `origin/dev` at
`60494f205`. Includes the completed model-composition and conditional ChatGPT
settings diff from the local exploration based on `a4085492a`. Not a release
receipt; exact-candidate native proof and packaging verification remain pending.

**Deferred / not included:** free anonymous backend integration and no-login
growth work depend on #4621 and its rollout. This candidate does not add an
anonymous inference backend, free-start/session gates, or free-inference IPC.
Existing local/BYOK and account paths remain; no new free allowance is promised.
The landing page stays development-only and noindex. An alpha publication via
`coworker-pre` does not roll out the production website.

## Story and recommendation

Open Coworker gives work persistent identity, workspace and memory, with visible,
independent cross-vendor roles. Astra's announcement is the timing hook, not the
product's identity. The constellation and stars are one-off campaign styling.

**Illustrative recipe, not fixed architecture:** GPT-5.6 Luna for conversation +
GPT-6 Astra for a deep-thinking Worker + Gemini 3.8 Flash for delivery Workers.
Choose any supported connected model(s); a single-model setup is equally valid.
Workers require tool-capable models and supported effort choices, not those brands.

For hard ambiguity, one thinking Worker returns a brief to the original coworker,
which can then delegate up to two delivery Workers and review their evidence.
Workers do not delegate or consult. They use their owner's workspace, not separate
persistent identities or filesystem sandboxes. A separate coworker such as Polaris
can still answer via `coworker_team_consult`; that is an alternative, not a required
stage or the same thing as a thinking Worker. Clear routine work skips the thinker.

## Current versus proposed

| Surface | Base behavior | Alpha candidate / deferred work |
|---|---|---|
| Identity | Coworker profile, workspace, memory and model/effort | Unchanged; Worker roles do not replace the coworker |
| Worker settings | Owner's standard model | Persisted `thinkingModel`, `thinkingModelVariant`, `deliveryModel`, `deliveryModelVariant`; unset inherits owner model/effort |
| Worker purpose | Undifferentiated work | `thinking` or `delivery` (default); two thinking turns by default, finite delivery defaults from effort dial (ten at Balanced) |
| Model snapshot | Pending turn keeps message ID and prompt | New Workers pin provider/model/effort at creation; `pendingTurn.model` retains it; settings edits affect new Workers only; legacy records still inherit |
| Handoff | Worker completion returns to origin | One successful thinking Worker can resume the original coworker for up to two delivery Workers, then final review; no Worker recursion |
| Availability | Owner-model path | Connected native catalog checked at creation and before new sends; unavailable explicit/saved choice stops without model/provider fallback |
| Consultation | Explicit context, visible pair/group answer, return to origin | Remains a separate coworker option; Workers cannot call it |
| Controls | Task turn limits, not dollar caps | Model/effort choices and snapshots in candidate; dollar budgets, enforced escalation approval and per-task usage receipts deferred |
| Templates | Strict profile documents, no model or private state | Same keys/version; optional `star` glasses in shared schema and native allowlist; old builds may reject |
| ChatGPT settings | Manual OpenAI setup and local detection | Evidence-led offers; shape metadata only, no entitlement claim; shared-connection replacement guarded |
| Anonymous inference | No new integration in this candidate | Free anonymous backend and no-login growth deferred until #4621 dependency and rollout |

Source: `apps/coworker/electron/{coworkers,workers,main,collaboration}.mjs`,
`apps/coworker/src/ui/{coworker-home,model-picker,workers}.tsx`, and
`packages/types/src/coworker-template.ts`. Source presence is not native E2E proof.
Conditional settings use `electron/local-providers.mjs`, `src/lib/model-growth.ts`,
and `src/{lib,ui}/local-providers`.
Detection never verifies an entitlement. A zero-model import is labelled as saved
with no models available, not usable ChatGPT access; the native provider flow is
unchanged. Generic OpenAI sign-in remains available through manual setup.

## Profiles and setup

Each download is an editable starting profile, not a backup or a skill.

| Coworker | Suggested responsibility | Appearance | Public download path |
|---|---|---|---|
| Polaris | Deep thinker: resolve a consequential decision | Violet, star | [/coworker/profiles/polaris.coworker.json](/coworker/profiles/polaris.coworker.json) |
| Scout | Research: assemble a bounded evidence brief | Mint, oval | [/coworker/profiles/scout.coworker.json](/coworker/profiles/scout.coworker.json) |
| Spark | Launch editor: turn approved facts into a draft | Orange, round | [/coworker/profiles/spark.coworker.json](/coworker/profiles/spark.coworker.json) |
| Forge | Engineering: deliver the smallest verified change | Blue, square | [/coworker/profiles/forge.coworker.json](/coworker/profiles/forge.coworker.json) |
| Relay | Operations: turn a goal into clear next actions | Sage, square | [/coworker/profiles/relay.coworker.json](/coworker/profiles/relay.coworker.json) |

Import a profile, review its role/workspace, then choose models separately. Leave
Worker choices at **Same as coworker**, or configure **Deep thinking model** and
**Delivery model** with supported effort. Check account access before paid work.
Polaris demonstrates optional star glasses: use the latest candidate; older builds
may reject this profile. Appearance never selects a model or changes capabilities.
Profiles do not install models/providers, grant tools, import memory or authorize
spending. They contain no runtime model fields; role instructions are not enforcement.

## Why potentially faster or cheaper

This is a testable hypothesis about work design, not a savings or speed result.

- Keep the supervisor responsive while bounded work runs beside the conversation;
  do not require a premium model to run nonstop for coordination and routine edits.
- Skip thinking for clear routine tasks. For real ambiguity, use one thinking pass
  or consultation to produce a decision, constraints, acceptance criteria and risks.
- Reuse a compact brief and document references instead of copying full transcripts.
  Avoid needless transcript replay and cold-cache restarts; never assume cache hits.
- Bound delivery fanout after thinking to two Workers with distinct acceptance
  criteria. Parallelism can add overhead; the supervisor reviews returned evidence.
- Judge the accepted result, total task latency and actual cost together. Reviewer
  acceptance, not equal token volumes or cheaper rates, determines useful work.

## Build, preview and proof status

1. Review content/profile and landing UI changes separately from the runtime slice.
   The preview includes three-model, Flash-first, and single-model recipes.
2. Prove the candidate settings, pinned turns and thinking-to-delivery handoff in
   the existing team journey. Keep single-model and legacy behavior covered.
3. Defer dollar budgets, escalation approval enforcement and per-task usage receipts.
   **Ask first** remains guidance; **Turn limit** is not a spending cap.

From the repository root, preview the landing exploration locally:

```sh
OPENWORK_DEEP_THINKER_PREVIEW=1 pnpm --filter @openwork-ee/landing exec next dev --hostname 127.0.0.1 --port 4318
```

Route: `/coworker/deep-thinker`. It requires development mode AND that environment
flag; otherwise it returns not found. Metadata is `noindex, nofollow`.

Historical source checks, not exact alpha-candidate proof: Coworker typecheck and
33 focused model-composition checks passed before transplant; 17 focused native/lib
conditional ChatGPT checks passed separately. Local page diagnostics covered
patterns, independent mock selects, profiles, calculator, star toggle and reduced
motion; desktop/mobile screenshots were reviewed. Landing typecheck failed on
React 18/19 shared email/UI types (unresolved, not classified as pre-existing).
The earlier `pnpm evals:e2e open-coworker-team --local` attempt printed
`placement: local (--local)` but exited 1 before tests: Vitest missing. No tests
ran; counts unavailable. Native multi-provider proof is **Incomplete**. This
transplant has not established an exact-candidate typecheck, native journey,
package or installer result; those must be reported from the final candidate.

## Must-pass provider witness plan

Extend `evals/specs/open-coworker-team.e2e.test.ts`, not a parallel journey.
Its existing single scripted provider is not multi-model/provider routing proof.

- Use distinct local provider witnesses with synthetic credentials and the actual
  configured protocols. Record endpoint identity, credential identity, wire model
  and effort on every request, including retries; model labels alone prove nothing.
- Witness the illustrative three-role path: original conversation -> one thinking
  Worker -> original coworker -> two delivery Workers -> original final review.
  Assert correct endpoint/model/effort and zero cross-routing, once per return phase.
- Persist/reload settings; change them during a Worker and verify its snapshot and
  pending turn stay pinned. New Workers use new choices; inherited and legacy work.
- Reject missing/deprecated/non-tool models, unsupported effort, denial and quota
  failures without alternate paid requests. Recovery observes accepted work without
  replay; stop, turn exhaustion and blockers return honestly to the original thread.
- Assert no Worker spawn/consult/question tools, second thinker or recursive phase;
  preserve unrelated state and focus. Retain separate-consult private-canary coverage;
  Worker shared workspace access must not be portrayed as filesystem isolation.
- Deferred gates need future assertions: declined escalation sends no premium call;
  usage receipts reconcile all billable work and mark missing data unknown.

Use local mocks, not paid providers. When authorized, run
`pnpm evals:e2e open-coworker-team --local`; report placement and passed/failed/skipped
counts. Any missing assertion or skip is **Incomplete**; real measurement is separate.

## Launch demo script

1. Show the constellation and Polaris's optional stars. Import a profile; demonstrate
   manual model setup and **Same as coworker** before the optional three-model recipe.
2. Configure an isolated example: Spark converses on Luna, thinking uses Astra,
   delivery uses Flash. Say explicitly: "One template; choose your own models."
3. Request a draft launch for a fictional weekly planning kit with one unresolved
   positioning decision. One two-turn thinking Worker returns a compact brief.
4. Show Spark resume, review it and delegate at most two delivery Workers with
   distinct outputs and document refs. Spark checks evidence and returns one draft,
   decision summary and remaining approvals to the original conversation. No publish.
5. Reopen to show continuity: "Think big. Work lean." Label scripted inference;
   do not present pending native behavior or fabricated usage receipts as proven.

## Research and cost assumptions

Official-source research recorded 2026-09-08 in the source exploration; recheck
before publishing claims. It was not independently refreshed for this transplant.

The calculator is an Astra/Flash **two-model subset**, not a total three-model task
estimate: it omits Luna and assumes the same token volumes/share for input/output.
Rates are editable assumptions, not measured usage, invoices or numerical savings.

- [OpenAI release notes](https://openai.com/products/release-notes/): September 3
  announces GPT-6 Astra; this is not a general-availability announcement.
- [Astra model pricing](https://developers.openai.com/api/docs/models/gpt-6-astra):
  standard context <=272k is $10 input / $50 output per million tokens; cached
  input is separate. Do not extrapolate these rates to other context tiers.
- [Gemini latest model](https://ai.google.dev/gemini-api/docs/latest-model) and
  [changelog](https://ai.google.dev/gemini-api/docs/changelog): September 2/3,
  Gemini 3.8 Flash GA; intro $0.75 input / $3.75 output per million through
  December 31, 2026; normal $1.50 / $7.50 from January 1, 2027.
- [Cloud pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing) notes
  a credits-based promotion. Use $1.50 / $7.50 for a conservative Flash scenario
  and label it an **editable assumption, not the current invoice**.
- No savings have been measured. Real task comparisons include billable reasoning,
  retries, handoff, cache, tools and supervisor/reviewer work. Avoid double-counting
  reasoning already billed in output. API cost differs from subscription allowance.
- Claude Code documents [opusplan](https://code.claude.com/docs/en/model-config)
  and [subagent models](https://code.claude.com/docs/en/subagents). Its
  [gateway guide](https://code.claude.com/docs/en/llm-gateway) calls non-Claude
  routing unsupported, not impossible; native cross-vendor routing is not documented.

## Approval gates and delivery

Risks: stale access/pricing, shared-workspace exposure, duplicate work, recovery
model drift, runaway retries and misleading claims. Catalog checks are not billing
entitlement guarantees. Keep external actions draft-first and unclear high-impact
decisions human-led. No first-to-market, sponsorship, free credits, universal access,
fixed speed, equal quality or numerical savings promises; roles do not enforce gates.

The alpha candidate preserves newer browser/workspace, All Hands, coordinator,
provider and isolated packaging work. Its selected transplant excludes interrupted
anonymous inference work. Keep the existing `beforePack` hook and isolated
`coworker-pre` workflow; publication and production website rollout are separate.
A runtime PR should own settings, snapshots, handoff and covering journey together.
Only for authorized delivery, review the delta and rerun exact-head proof. This
document itself grants no staging, commit, push, PR, paid request, external write,
release or deployment authority.

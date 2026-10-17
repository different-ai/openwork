# Full workshop proof — GPT-6.1 Sol FAST vs Qwen 27B

## Verdict: INCOMPLETE

Both real paid subjects were run on the Mac, in the requested order, through native OpenWork app-web/composer paths. All twelve scenes have an outcome; none was silently dropped. This is **not** a claim that the entire workshop passes, nor a general model-quality ranking.

- Tested implementation: [`be0acb54e9`](https://github.com/different-ai/openwork/commit/be0acb54e9), draft [PR #6109](https://github.com/different-ai/openwork/pull/6109), not merged.
- Placement printed by both native commands: `local (--local)`, engine `v1`, surface `web`.
- Same frozen prompts, assertions and limits. Prompt/limits digest: `94c37c204f12cd7364770471c91c3a27899e813913a5e312abcb9fb73517148d`.
- Initial service-state hashes **matched**: `d42c2d0d10c5a0977df87d8c35cdb4fa2b97e8ae49d12d49d3399ffdf6bbe0e2`. Exact owned origins and narrowly defined transport/auth fields normalize; business IDs, facts and dates do not disappear.
- Fresh isolated canonical workspaces, app auth/config and owned Den/mock services for each subject. Only paid inference used an external provider. No installed provider/model setting was changed; no mail was sent.
- Native tests: **0 passed / 2 failed / 0 skipped**. Each intentionally fails unless all scenes pass. Wrapper exit: **1**.

## Exact subjects and measured usage

| | GPT-6.1 Sol FAST | Qwen3.8 27B |
|---|---:|---:|
| Upstream model | `gpt-6.1-sol` | `qwen/qwen3.8-27b` |
| API | OpenAI Responses | OpenRouter Chat Completions |
| Variant | `__openwork_fast_v1/default` | default |
| Tier | Requested `priority`; observed `fast` | No Fast tier requested |
| Real forced tool-call preflight | HTTP 200, 1,184 ms | HTTP 200, 647 ms |
| Phase wall time, including setup/cleanup | 13m 28.4s | 20m 53.5s |
| Input tokens, final ledger | 6,029,715 | 4,752,788 |
| Output tokens, final ledger | 34,551 | 103,406 |
| Requests reaching upstream, including preflight | 177 | 106 |
| Additional attempts rejected before upstream | 2 | 2 |
| Sum of available per-request estimates | $24.80988 | $1.36816232 |
| Cost reported in upstream usage | **Unavailable** | **$0.363171644**, 106 requests |

Estimates are **not invoices** and do not account for cache discounts. OpenRouter's reported usage cost is not independently reconciled to billing. Do not compare Sol's estimate with Qwen's reported cost as if both were billed figures. The earlier exploratory Sol calibration is excluded from this matched score and added approximately $24.67 in available-request estimates; actual billing and orchestration-model costs are unavailable.

Sol's successful narrative requests returned the required Fast tier; Fast was not substituted with a lower reasoning setting. Qwen authentication alone was not counted as inference: its real tool-call preflight passed, followed by actual paid narrative requests. No GPT-4.1 or other subject fallback was permitted.

## Frozen native contract results

These are the machine contract outcomes, **not full acceptance certification**. See the stricter review below. Latencies include task execution and observer overhead; fixed UI waits and cancellation affect failed scenes.

| Scene | Sol | Qwen | Seconds Sol / Qwen | Observed result or failed check |
|---|---|---|---:|---|
| T10 09:00 news digest | PASS | FAIL | 95.5 / 176.7 | Sol passed bounded registered-job/due-dispatch/source/folder/file/draft checks. Qwen's schedule-registration call provenance was not verified; this does not establish that no job existed. |
| T01 customer one-pager | PASS | FAIL | 60.5 / 182.4 | Sol verified full reads, cited OneDrive content and threaded draft. Qwen exceeded the common 180s turn bound without verified completion. |
| T02 reusable Workflow | PASS | PASS | 78.6 / 106.8 | Both verified persisted native versions, successful executions and distinct backend input digests. |
| T03 recipient sharing/run | BLOCKED | BLOCKED | 97.8 / 177.9 | Verified viewer grant plus successful execution receipt attributable to Nora was unavailable. No owner fallback counted. |
| T04 account analysis | PASS | PASS | 44.7 / 41.7 | Full account plans; saved/read-back report with correct ARR versus orders, relationship, growth, churn and citations. |
| T05 account-report PPTX | PASS | FAIL | 118.7 / 182.8 | Sol's actual downloaded new OOXML opened in python-pptx and passed slide/content/citation checks. Qwen timed out without a verified uploaded presentation. |
| T06 DOC ticket/Nora | FAIL | FAIL | 47.0 / 43.0 | Both reached a created issue page; the Assignee browser locator/value assertion timed out. This is a harness/UI assertion failure, not proof of wrong assignment. |
| T07 Windows reset | PASS | PASS | 49.6 / 130.6 | Actual ITSD request, discovered required Application option, read-back and visible Windows login field. No password collected. |
| T09 absent dog policy | PASS | PASS | 12.9 / 22.3 | Complete internal sources, honest missing-policy answer, People Ops handoff, no detected unapproved external-search attempt. |
| T08 negative UI feedback | BLOCKED | BLOCKED | 0.9 / 0.9 | Actual feedback menu inspected. No owned landing/Plain persistence surface; feedback was **not submitted**. |
| T11 calendar scheduling | PASS | PASS | 19.8 / 19.3 | Same meeting genuinely rescheduled with attendees, Pacific timezone, body/location, Graph state and browser visibility. Bounded fixture—not full Outlook parity. |
| T12 Confluence follow-up | FAIL | FAIL | 49.3 / 39.2 | Version/body-preservation and new-comment assertions failed. Draft/link checks alone did not establish full completion. |

**Raw contract counts:** Sol **8 PASS / 2 FAIL / 2 BLOCKED**; Qwen **5 PASS / 5 FAIL / 2 BLOCKED**.

## Acceptance review: do not overclaim the passing checks

A separate read-only audit identified proof gaps. For the user's stronger entire-narrative acceptance, the following contract passes remain **BLOCKED / unverified**, not certified successes:

- **T01:** full source reads, citations, writes and read-back are checked, but meaningful coverage of the customer's requirements is not fully asserted.
- **T02:** durable execution/version/caller and changed input digests are proven, but exact requested inputs and grounded reusable output semantics are not independently checked. A trivial successful Workflow could otherwise satisfy the contract.
- **T10:** the model-authored due job genuinely dispatched paid inference and persisted delivery objects, but the draft's digest content/link and explicit absence of premature delivery are not fully asserted. A due event or operator receipt is not sufficient by itself.

| Acceptance status | Sol | Qwen |
|---|---:|---:|
| PASS under the remaining bounded checks | 5 | 4 |
| FAIL | 2 | 5 |
| BLOCKED / not fully verified | 5 | 3 |

The raw outcome remains visible rather than being rewritten. `summary.json` carries both contract and acceptance statuses per scene. There is **no full workshop pass for either subject**.

Additional limitations:

1. Opaque Code Mode attribution uses a unique completed tool time window, not a cryptographic session/request binding. The recipient transcript does not get all owner-transcript model checks; outsider access is not exhaustively verified.
2. The frozen runner did not invoke its aggregate verifier or validate native exit codes/exact scene order in its completion predicate. This review does: combined wall time **34m 21.9s exceeds the declared 30m aggregate limit**. Known tokens (10,920,460) and available-request estimates ($26.17804232) remain below their declared aggregate thresholds. This is another reason to withhold acceptance.
3. A successful nonstreaming Sol preflight was mislabeled `upstream-error` because the recorder treated `error: null` as an error. Its HTTP 200, completed output and forced tool call were independently validated; do not report this as an upstream HTTP failure.
4. Two Qwen scene snapshots showed a final request as still started around cancellation; the final ledger later recorded completion. Per-scene attribution near timeout is approximate. Aggregate ledger totals are reported separately.
5. Both phases had two fail-closed concurrent-request rejections, potentially involving background/delegated requests. These did not get forwarded to a different model or service tier.
6. PowerPoint checks prove actual ZIP/OOXML parser openability and content, **not** Office GUI rendering or editing. No Windows-launch claim is made. Calendar screenshots do not claim Outlook UI parity.

## Screenshots and local preview

The native galleries contain **24 Sol and 21 Qwen actual screenshots**, including chat, successes, failures and blockers. All 45 passed a local credential-pattern OCR scan; selected publishable images are also visually reviewed. The committed gallery contains only reviewed fictional views, not raw receipts, auth state, transcripts or configuration.

See [the screenshot gallery](gallery.md), or open the local `index.html` preview in this folder. Original private native records remain under `evals/results/test-runs/`; they are not committed. Images are actual captures, not reference images pasted into a mock UI.

Both native worlds were cleaned up after their phases. Live Den/business-service links are intentionally not retained; the preview is a read-only evidence gallery.

## Repeat

```sh
OPENWORK_EVAL_MYSQL_URL=<owned-local-MySQL-base> \
node evals/scripts/run-workshop-narrative.ts
```

This launches `pnpm evals:e2e workshop-narrative --local --surface web --engine v1` in strict Sol → Qwen order. Keys are fetched only by the scoped consumer from Infisical dev `/` and `/openwork-ops`; no key appears in the command or report. See `worlds/workshop-narrative.md` for prerequisites, limits, isolation and scene definitions.

## Supporting fixture and harness checks

Separate from the failed native paid proofs: **47 unit/contract checks, 27 API/parity tests and 3 standalone headless-browser checks passed, zero skips**. Evals typecheck covered 265 files with no errors; spec lint checked 23 files with no errors. These checks validate fixtures/guards and do not turn the full narrative green.

The failed calibration/bootstrap records remain private and separate from these frozen matched results. The proof, failed checks and audit gaps are being handed off—not repaired after the fact to manufacture a full pass.

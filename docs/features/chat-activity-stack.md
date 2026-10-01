# Chat improvements, organized by what a person can do

The implementation is split into five outcomes. Each PR adds one reviewable
layer; its own description explains the incremental change. The original PR is
an index containing this document.

| Order and benefit | Previous state | What this adds or improves | PR | Evidence |
| --- | --- | --- | --- | --- |
| 1. Inspect what a connected tool returned | A completed Code Mode action could retain its arguments while losing its individual result, including after reload. | Native starts are published while calls run; saved results, errors and timing follow each invocation. Raw output stays inside Technical details. Capture is bounded and omitted detail is marked. | [#5518](https://github.com/different-ai/openwork/pull/5518) | [Report and current status](https://github.com/different-ai/openwork/pull/5518#issuecomment-5938399052) |
| 2. Follow a task without losing its order or working time | A fast reply could appear before its prompt; a follow-up could restart elapsed time; decision waits could inflate work time. | Replies follow prompt ancestry. The same run survives follow-ups and reloads, with decision waits subtracted. Answers keep their own model and native timing. | [#5519](https://github.com/different-ai/openwork/pull/5519) | [Report and current status](https://github.com/different-ai/openwork/pull/5519#issuecomment-5939174809) |
| 3. Answer a helper's question when an update was missed | A helper could remain blocked without its question or approval appearing in the parent. | Related active or waiting sessions reconcile again. Unanswered decisions and allowlisted native completion notices survive history without mixing unrelated tasks. | [#5521](https://github.com/different-ai/openwork/pull/5521) | [Report and current status](https://github.com/different-ai/openwork/pull/5521#issuecomment-5939234042) |
| 4. Intervene in a helper and return to your work | Busy-helper Enter could queue; returning could lose a draft or pane; Stop could trust stale associations or imply success too soon. | Direct helper follow-ups; collapsed Original task; scoped draft, pane and position restoration; verified Stop with pending, acknowledgement and retry feedback. | [#5522](https://github.com/different-ai/openwork/pull/5522) | [Report and current status](https://github.com/different-ai/openwork/pull/5522#issuecomment-5939269920) |
| 5. Keep live progress clear and stable | Folded execution lost shimmer; thinking pulsed; individual connected actions had no live duration or copy action. | Moving visible progress, distinct thinking, per-action elapsed time restored from observed events on a same-tab reload, and Copy details; retain height hold, model placement and disclosed output. | [#5531](https://github.com/different-ai/openwork/pull/5531) | [Report and current status](https://github.com/different-ai/openwork/pull/5531#issuecomment-5940712154) |

## What each report actually checks

- **Saved tool results:** the existing connector journey opens the action's
  own result, reloads, and inspects that same result again. An assistant answer
  repeating the result cannot satisfy this check.
- **Task order and working time:** the delegated-activity journey witnesses an
  advancing timer, sends a follow-up, checks the original task precedes it and
  the timer continues, then reopens the same unfinished helper after reload.
- **Recovered decisions:** the fixture drops the real helper question's live
  notification while retaining its native request. The parent must recover it,
  keep it answerable after reload and leave another task's question unanswered.
- **Helper controls:** the journey requires a prompt POST to the selected busy
  helper while its grandchild is held, checks draft restoration and return,
  finishes delegated work, and separately stops the selected helper and its verified descendants without
  stopping the parent.

- **Clear and stable progress:** existing visibility and connector journeys sample moving shimmer and title weight, measure live height, inspect reasoning disclosure, preserve trusted answer-level model placement, advance the individual action timer through same-tab reload and acknowledge its clipboard write. [Acceptance by reported gap](chat-progress-acceptance.md) records the limits.

CI executes these journeys on both engines. The linked evidence comments
track the exact current PR head and lead to its report. A red, incomplete or
pending report remains visible; a passing build does not replace that report.

Focused unit coverage additionally checks parallel-call correlation and byte
limits, overlapping decision waits, rejected admissions, historical model
identity, native completion allowlisting, pane isolation, stale/cyclic ancestry
rejection and Stop failure/retry. The runtime journeys do not prove every one
of those boundaries.

## The familiar chat interface

These changes retain the existing activity rail, completed-step folding,
answer model footer and opt-in Technical details. The proposed agent tray,
default raw result previews and engine-startup wording are excluded.

The previous seven layers are consolidated as follows:

| Former PR | Current home |
| --- | --- |
| #5518 tool capture | #5518, including the result availability label |
| #5519 chronology and #5520 timing | #5519 |
| #5521 decisions and native notices | #5521 |
| #5522 navigation and #5523 controls | #5522 |
| #5524 presentation refinements | Result availability in #5518; reasoning timing and visible shimmer in #5531 |

The original implementation is preserved on
`archive/chat-activity-monolith-2026-10-01`; the earlier seven-layer stack is
preserved on `archive/chat-activity-seven-layer-stack-2026-10-01`.

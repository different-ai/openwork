# Clear and stable chat progress

The previous chat layout is the reference. This slice preserves the live rail,
its existing height hold, completed-work fold, answer-level model label and
collapsed technical details. Event capture, chronology and helper recovery
remain independently reviewable in the earlier stack layers.

| Reported gap or omitted value | Previous state / risk | Added or preserved behavior | Acceptance and evidence |
|---|---|---|---|
| Frozen shimmer | A still image and an animation class cannot establish moving progress. Folding a live Code Mode group hid its current animated row. | The visible running row or folded summary carries the cue; reduced motion remains static. | Native visibility journey samples painted background position over time; component check covers folded summary handoff. This does not establish the original monolith's CSS root cause. |
| Changing emphasis | The monolith introduced label crossfades and an activity shell; weight and color could change between updates. | Reuse the existing rail and neutral tokens without the new shell or crossfades. | Native journey samples the held running title's weight, base color, gradient and status color alongside moving background positions. Sampling does not prove the absence of every sub-frame flicker or every desktop hover state. |
| Thinking resembles answer text | The original redesign weakened an existing distinction; baseline Thinking pulsed, and empty reasoning still exposed an empty disclosure. | Collapsed Thinking with a quiet running cue; empty reasoning has no disclosure; completed native timing reads Thought for a duration. | Native held reasoning is hidden until opened and stays distinct from the held answer. Focused checks cover empty text, completed and invalid timing. |
| Height shrinks between steps | Folding a finished detail before the next row can move the conversation. | Retain upstream LiveSteps' existing tallest-height hold. | Native visibility journey measures height through read, command and delegation; no shrink over its documented 8px tolerance. No new height abstraction. |
| Redundant startup and zero-step rows | The monolith showed earlier-step counts, Starting and Working together. | Keep the established Working state and rail. | Native journey samples absence of zero-earlier-step and internal engine-start labels. Existing tool-specific startup information is not globally removed. |
| Internal capabilities or raw JSON by default | The monolith rendered returned text/JSON before the technical disclosure. | Sentence-first connector rows; input/output only on explicit disclosure. | Native connector journey observes a live row without preformatted data, then inspects the action's own result before and after reload. |
| Model placement | The monolith moved model identity into per-action progress. | A trusted resolved model stays at the completed turn/answer summary, none inside live steps; unknown resolution does not invent a label. | Native visibility checks no internal model labels and no invented resolution for its mock. Focused completed-work checks prove one resolved label at answer level. Identity mapping belongs to chronology. |
| Copy technical details was omitted | Selecting diagnostic text manually was the only way to take it elsewhere. | Disclosed Copy details button copies invocation identity, input, captured output/error and capture flags; success or retry feedback. | Native connector journey acknowledges the real clipboard write. Focused check verifies exact copied data and denied-write retry. |
| Individual running-tool time was omitted | Connected actions showed a duration only after completion. | Advance each action from native timing when supplied, otherwise its first live observation; freeze at native completion. Explicitly unavailable native timing stays unknown. | Native connector journey observes increasing readings and a v2 live reload; focused check covers supplied native start, completion and unavailable timing. The event-capture layer publishes native starts before completion. Because pinned v2 returns empty running metadata, the UI retains actually observed progress in tab storage, restoring only an exact server/workspace, session, reply and invocation confirmed running by native history. The journey reloads that action and requires its time to continue. |
| Question distinction and intentional Stop | Decisions and interruption must remain recognizable without a new tray. | Preserve existing decision card and interruption/recovery presentation. | Earlier child-decision recovery proof owns questions. Existing native visibility Stop journey checks settlement and retained queued words; this slice does not redesign recovery. |

Native journeys use the real app and v1/v2 engine with deterministic provider
and connector fixtures. Their screenshots show actual journey states; they
are not screenshots of the original monolith or an older release. CI owns
report publication. Read its current-head evidence comment for the verdict.

Live reload retention is limited to the same tab: at most 64 snapshots, 256 KiB
per snapshot, 1 MiB serialized total and six hours. Oversized, expired or
unavailable storage contributes no progress. Another tab or device cannot
recover progress the native runtime omitted. Completed/error history and native
terminal events clear retained progress; missing completed results stay missing.

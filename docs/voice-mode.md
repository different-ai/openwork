# Voice Mode in a conversation

Voice Mode attaches audio to the conversation you have open. A finalized spoken request uses the same Send/Steer callback as a typed request, with that conversation's workspace, selected model, system context, and existing permission checks. Browser, WebMCP, connected apps, and computer use remain capabilities of the normal execution engine.

Start voice, describe the work, and continue speaking to clarify or change direction. The written conversation is the durable record. Voice reads a bounded excerpt of a completed response after observing the underlying conversation; dispatching a prompt or playing audio does not establish task success. Errors and unresolved tools are not announced as success.

| Control | Audio | Conversation work |
| --- | --- | --- |
| Stop talking / Escape in the voice text field | Cancels generation and clears unplayed speech | Continues |
| Mute | Stops microphone tracks; output remains available | Continues |
| End voice / close panel | Releases microphone, playback, peer, listeners, timers | Accepted work continues |
| Switch conversation or workspace | Ends the current call and discards its pending audio callbacks | Remains owned by the original conversation |
| Cancel operation | Interrupts playback and clears unsubmitted voice input | Clears queued follow-ups and requests the normal directory-scoped abort; completed effects cannot be undone |
| Reconnect voice | Creates a fresh audio connection after an explicit click | Reads current state; never resubmits a previous request |

The exact spoken commands “stop talking”, “pause the voice session”, “mute microphone”, and “cancel this operation” have the same separate meanings. Other utterances become conversation turns. Short ambiguous commands should be clarified in text. A changed task is an ordinary follow-up, not an implicit cancellation.

Permissions, questions, sign-in, and sensitive input use the on-screen product controls. Voice has no permission-approval tool and no general UI-action executor. Background speech and generated audio cannot reply to permission requests. A final transcript with missing confidence data or mean token log-probability below -1 is held for text review; this threshold is a conservative heuristic, not speaker authentication. Partial and revised transcripts are never submitted. No acoustic classifier can guarantee that all confident background speech is excluded: mute when not addressing OpenWork.

## Architecture and research decisions

Research checked September 4, 2026. Consequential decisions:

- **WebRTC for live audio, one existing executor.** Retain the deployed OpenAI Realtime connection and broker. Use final transcription as the boundary into the existing text execution path. This adds transcription and execution latency versus letting a speech-to-speech model answer directly, but preserves provider/model context, a durable conversation, and existing tools and approvals. Official guidance distinguishes immediate realtime interaction from [chained voice workflows that extend an existing text agent](https://developers.openai.com/api/docs/guides/voice-agents). [The WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) recommends WebRTC for browser clients and illustrates server-minted ephemeral credentials. SDP negotiation uses browser fetch with an abort signal; audio remains on the peer connection.
- **Configure before capture.** Both direct and managed broker sessions receive a session update that removes tools, disables automatic responses, enables transcription confidence, and selects low-eagerness semantic VAD. Microphone tracks remain disabled until configuration acknowledgement and the initial conversation snapshot. [Semantic VAD](https://developers.openai.com/api/docs/guides/realtime-vad) accounts for incomplete utterances rather than treating a 320 ms silence as an unconditional end of turn. This intentionally favors pauses over minimum response latency.
- **Playback follows observed results.** Speech requests use an out-of-band conversation, no tools, and only a bounded completed-response excerpt. They cannot enqueue tasks. WebRTC's server-managed audio buffer supports clearing and truncating unheard audio on interruption; a generated transcript is not an exact record of heard words. The UI marks interruptions and leaves the authoritative written response intact. See [Realtime conversations: interruption, truncation, and out-of-band responses](https://developers.openai.com/api/docs/guides/realtime-conversations).
- **Explicit capture lifecycle.** Request echo cancellation, noise suppression, and gain control; inspect the actual track settings. If AEC is not reported, pause microphone transmission during output and leave Stop talking available. Mute stops tracks and reacquires them on unmute. Handle unavailable/denied/interrupted microphones, device selection, peer loss, offline, and delayed permission grants. The [media capture contract](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) permits permission promises to remain pending; [track stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/stop) releases each owned capture track. Desktop retains its existing [native microphone permission handoff](https://www.electronjs.org/docs/latest/api/system-preferences).
- **Bounded recovery.** Calls pause after 25 minutes, five minutes without speech, a system scheduling interruption, or a connection failure. There is no automatic capture restart or retry of a submitted operation. A request with uncertain delivery stays reviewable and warns against duplicate submission. This is a new audio call over the same durable conversation, not provider-session resumption. Other providers expose different contracts, such as [Live API resumption handles](https://ai.google.dev/gemini-api/docs/live-api/session-management); those require a separate validated transport implementation.
- **Public product precedent has limits.** [Public desktop voice documentation](https://learn.chatgpt.com/docs/features/voice) describes voice in existing tasks, selected-model execution, and changing direction. It does not document internal transports, echo-cancellation algorithms, or cancellation delivery guarantees. Those internals are not assumed here.

## Model, provider, cost, and privacy

Conversation execution retains its selected supported provider and model. Audio currently requires the existing OpenAI Realtime broker contract: managed OpenWork Models when configured, or the existing explicit OpenAI key path. The deployed default remains `gpt-realtime-2` with `gpt-4o-transcribe`; this change does not assert support for arbitrary OpenAI-compatible endpoints. An acknowledged tool-free session, semantic VAD, transcription log-probabilities, audio output, and interruption events are required. Managed-provider input validation and new inference-provider routing remain separate work.

Audio and bounded response excerpts are sent to OpenAI, including when execution uses a different provider. OpenWork retains accepted user turns and engine replies in its existing conversation store; the panel's bounded activity is ephemeral. It does not record raw audio or copy transcripts into diagnostic events. Provider-side retention is separate: [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) describe default abuse-monitoring retention and separately approved retention controls. Local-only voice is not claimed.

Audio uses the existing managed accounting or direct provider billing, alongside normal conversation inference. Session/idle/turn limits, a single active submission, one pending speech excerpt, and bounded output tokens limit resource consumption; they are not a fixed price guarantee. A full speech-to-speech executor would respond sooner but introduce a second task/authorization surface. A local STT/TTS implementation would have different hardware, model-distribution, latency, and privacy requirements; it is not silently selected as a fallback.

## Existing work and integration boundaries

The base review covered current `dev`, all-author open PR metadata, relevant diffs, and file history.

| Work | Observed relationship |
| --- | --- |
| Original Voice Mode [#1888](https://github.com/different-ai/openwork/pull/1888) and managed-voice proposal [#2325](https://github.com/different-ai/openwork/pull/2325) | Closed unmerged; newer code supersedes the original proposals |
| [#1976](https://github.com/different-ai/openwork/pull/1976), [#2327](https://github.com/different-ai/openwork/pull/2327), [#2333](https://github.com/different-ai/openwork/pull/2333) | Earlier audio checks, context improvements, and managed voice landed; current `dev` owns the substrate |
| [#4193](https://github.com/different-ai/openwork/pull/4193), [#4212](https://github.com/different-ai/openwork/pull/4212) | Native conversation reads and bounded runtime caches already landed; preserve those contracts |
| [#4382](https://github.com/different-ai/openwork/pull/4382), local dictation | Open, separate composer/MLX implementation; explicitly excludes realtime playback and automatic submission. No dependency or shared implementation edits |
| [#3189](https://github.com/different-ai/openwork/pull/3189), untrusted input validation | Open, owns broker model validation among other changes. Preserve existing broker model defaults; do not copy its server/inference edits |
| [#4358](https://github.com/different-ai/openwork/pull/4358), inference gateway | Open, separate provider routing/credentials/usage work; no dependency |
| [#4111](https://github.com/different-ai/openwork/pull/4111) and current browser-task work | WebMCP/browser internals remain separate. Voice enters through the normal sender; no browser/native transport changes |
| [#4459](https://github.com/different-ai/openwork/pull/4459), UI control through server | Merged into the current base, separate control mailbox transport. Voice no longer depends on general UI-control tools |
| [#4461](https://github.com/different-ai/openwork/pull/4461), computer task mentions | Open, owns composer encoding and routing hints. Plain spoken requests use the existing capabilities; no copying of the mention implementation |
| [#4463](https://github.com/different-ai/openwork/pull/4463), scoped native computer sessions | Open, owns native consent, app/window scope, and its cancellation client. No dependency: voice uses the normal executor and its existing tool contract. The shared extension catalog changes separate Voice Mode and Computer Use entries |

No unrelated open branch is imported. The only conversation-shell wiring passes its existing sender and immutable owner into the voice panel.

## Proof and remaining live verification

`pnpm evals:e2e voice-conversation` drives the actual app and engine. An isolated model witness asks the real bash tool to write a workspace file, then returns a response. A controlled AudioContext/MediaStream and simulated realtime events exercise capture lifecycle, finalized transcript submission, interruption, follow-up, cancellation, reconnection, late callbacks, conversation isolation, denied permission, late grants, and typed fallback. Assertions inspect actual engine messages and file effects, not just dispatch acknowledgements.

This is deterministic integration coverage. It does **not** establish physical microphone/speaker quality, acoustic echo cancellation, recognition accuracy, realtime-provider schema acceptance, semantic-VAD latency, Windows/macOS device recovery, or audible transcript alignment. Those require an explicitly observed live session on supported hardware and remain separate evidence. Long-running external tools may not cancel immediately; the UI reports an abort request or an unconfirmed cancellation rather than promising rollback.

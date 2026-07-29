# OpenWork Station ambitious MVP demo

OpenWork Station is a passive, consent-gated contextual agent. It hears a live
work conversation, transcribes it through OpenAI Realtime, decides whether
connected context would help, and calls one local read-only research handler.
The Station UI surfaces cited context or a reviewable draft. It never sends a
message, schedules an event, or mutates a connected record.

Station is off by default. Preferences → OpenWork Station → **Enable Station**
is the sole product enablement boundary. While disabled there is no Station
window, global shortcut, microphone capture, or Realtime session. **Disable**
stops active media, unregisters the shortcut, and destroys the native surface.

## What is real in the primary demo

The `maya-memory` scenario runs this path:

1. Spoken MP3 fixtures are decoded by Web Audio.
2. The resulting `MediaStream` is supplied to `OpenAIRealtimeWebRTC`.
3. The browser connects with a short-lived client secret minted by the local
   OpenWork server.
4. Realtime performs actual speech detection and transcription.
5. The Realtime model chooses whether to call
   `research_current_context`.
6. The local handler sends the accumulated, corrected transcript to the
   Station analyzer interface.
7. In scenario mode, an auditable deterministic analyzer classifies raw
   records from the explicitly labeled development MCP simulator.
8. The shared suggestion normalizer and relevance engine append the result to
   ordered card history. Passive mode keeps it hidden; the Station shortcut
   deals the highest-priority card from behind the Station pill.

The automated proof uses a deterministic spoken fixture so its assertions are
repeatable. The production path uses `navigator.mediaDevices.getUserMedia`
with the physical microphone. Both feed `OpenAIRealtimeWebRTC` and genuine
Realtime inference; the sanitized Station state labels the input provenance so
a fixture is never reported as a physical microphone.

The simulator replaces an unavailable live Connect account; it does not
replace audio, transcription, Realtime inference, model tool selection, the
local handler, the Station analysis contract, or the UI. It exposes raw read
results and stable source URLs, never prebuilt suggestion cards. Scenario
classification is deterministic by design so recovery, correction, and
no-result assertions do not depend on a second unrelated model call.

## Secure local setup

Put a standard OpenAI project key in the ignored repository-root file
`.env.station.local`:

```dotenv
OPENAI_API_KEY=your-project-key
```

Keep the file local and restricted to your user. `.env*.local` is ignored by
Git. The project key is read only by the local server. The renderer receives
only the short-lived client secret returned by the Realtime client-secrets
endpoint.

Do not paste the key into DevTools, a control action, a fixture, a screenshot,
or a committed file.

## Start the desktop runtime

From the repository root:

```bash
pnpm dev
```

The default developer CDP endpoint is `http://127.0.0.1:9823`. Wait for the
desktop app to finish booting and for a workspace to be selected.

## Run the approved proof

In a second terminal:

```bash
pnpm fraimz --flow openwork-station-realtime-audio \
  --cdp-url http://127.0.0.1:9823
```

The proof verifies:

- a real ephemeral-secret WebRTC connection;
- actual speech detection and completed transcription;
- an actual Realtime model turn and tool request;
- the local research handler and read-only development MCP capabilities;
- a cited memory suggestion with a Development Slack source;
- passive versus active mode and the slide-from-behind card;
- bounded Left/Right ordered-history navigation;
- immediate shutdown, zero media energy, and preservation of the useful card.

The generated `fraimz.html` is the reviewable frame-by-frame artifact. This
command does not post it to a pull request.

For the internal real-audio resilience matrix:

```bash
pnpm fraimz --flow openwork-station-realtime-resilience \
  --cdp-url http://127.0.0.1:9823
```

Set `OPENWORK_STATION_RESILIENCE_CASE` to a comma-separated subset of
`ambient-speech`, `correction-over-time`, `mcp-recovery`, and
`immediate-stop` when isolating one failure.

## Manual control

The desktop shortcut contract is:

- Preferences contains the explicit **Enable Station** boundary. After it is
  enabled, **Open Station** brings the island forward and **Disable** performs
  the complete teardown described above.
- `Command + Shift + Space` on macOS, or `Control + Shift + Space` elsewhere,
  toggles active and passive mode. The dotted activity field in the pill
  provides the same action by mouse. Returning to passive mode keeps listening,
  transcription, and research running while retracting every card.
- `Left Arrow` moves into older ordered card history only while active.
- `Right Arrow` moves toward the highest-priority card only while active.
- `Enter` creates a real OpenWork thread with the selected card, its reason,
  evidence, and any prepared draft; the prompt starts automatically, external
  actions remain review-gated, and Station returns to passive mode.
- `Escape` chooses “Not now,” dismisses the current card, and deals the next
  priority if one exists. Dismissing the final queued card atomically returns
  Station to passive mode so a later background result cannot collapse and
  rebound the native island.
- The arrow, Enter, and Escape shortcuts are unregistered outside active mode
  so they cannot capture normal keyboard input. These are the only two card
  decisions: start a thread or dismiss it.

The development and proof control actions are:

- `station.scenario.run` — run a declarative timeline. Real inference is the
  default.
- `station.scenario.status` — read sanitized lifecycle metadata, counts, source
  providers, and the current outcome.
- `station.scenario.reset` — reset Station and the scenario’s development MCP
  state.
- `station.stop` — close Realtime, stop every media track, cancel scenario
  timers, and reject late async results.
- `station.mode.set` — mirror the global active/passive shortcut.
- `station.history.navigate` — mirror Left/Right ordered-history navigation.
- `station.dismiss` — mirror Escape / “Not now.”
- `station.handoff` — mirror Enter and create the seeded OpenWork thread.

Example real run arguments:

```json
{
  "scenarioId": "maya-memory",
  "playbackSpeed": 1,
  "realInference": true,
  "resetBeforeRun": true,
  "stopAfterRun": false
}
```

`station.scan_scenario` and `realInference: false` form a separate,
explicitly labeled text-simulation lane. They are useful for fast analyzer
diagnostics but are not proof of microphone, audio, WebRTC, transcription, or
Realtime model behavior.

## Scenario catalog

| Scenario | Time-varying behavior | Expected outcome |
| --- | --- | --- |
| `maya-memory` | General launch talk, pause, then a direct prior-context question | One cited memory suggestion |
| `denver-berlin` | Denver time first, Berlin participant and duration later | One cross-time-zone calendar draft |
| `follow-up` | General promise, then a more specific follow-up boundary | One refined review-only follow-up |
| `ambient-speech` | Greetings, filler, and irrelevant fragments | No tool call and no suggestion |
| `correction-over-time` | Friday changes to Monday, then to thirty minutes | The newer calendar suggestion replaces the old one |
| `mcp-recovery` | Connected context unavailable, then restored on a later turn | Honest recoverable error followed by a cited result |
| `immediate-stop` | Stop while fixture audio and possible research are active | Closed session, stopped tracks, no late publication |

## Sanitized lifecycle

The inspector records only bounded metadata for these events:

```text
station.realtime.secret_requested
station.realtime.connected
station.realtime.speech_started
station.realtime.transcript_completed
station.realtime.response_started
station.realtime.tool_requested
station.realtime.tool_started
station.mcp.discovery_started
station.mcp.discovery_completed
station.suggestions_published
station.realtime.tool_completed
station.realtime.tool_failed
station.realtime.stopped
```

It may include model name, local tool name, source category, result category,
and suggestion count. It does not include transcript bodies, audio, client
secrets, project keys, or connected-record contents.

## Honest failure behavior

- Missing microphone permission is terminal for that attempted run.
- Realtime or connected-data failures are visible and recoverable; Station
  remains safe to restart or keep listening.
- A development MCP outage does not generate a fake fallback card.
- Empty connected data produces “Nothing useful yet,” not a fabricated source.
- The standard non-scenario analyzer may still produce its clearly labeled
  local-signal fallback when live Connect analysis is unavailable.

# OpenWork Station MVP

OpenWork Station is a passive AI right hand for the desktop app. It lives
discreetly at the edge of the screen, understands live work while listening is
visibly enabled, researches relevant context, and prepares useful next moves
without requiring a chat prompt.

## Interaction model

- `CommandOrControl+Shift+Space` toggles listening. Station can also be opened
  from the session rail.
- The surface has only two rail states: a 34 × 118 pixel resting pill and a
  restrained 46 × 210 pixel hover state. Opening a detail card does not create
  another rail size.
- At rest, an accumulating cluster of up to eight signals sits behind muted
  glass. Bubble diameter is continuously derived from relevance, kind, and
  available evidence rather than selected from fixed size presets.
- The cluster keeps persistent particle positions across rail resizing. Bubbles
  pack into the capsule, collide, push one another, breathe slowly, and respond
  to microphone energy without overflowing their container.
- The rail expands only after an intentional hover. Pausing over an armed
  bubble peeks its detail blade; any physical pointer movement retracts the
  peek. Clicking or keyboard-focusing pins the card for interaction.
- The flat detail card slides from behind the pill like a switchblade. The pill
  remains above it and the card reserves a right-hand gutter for the pill.
- Source links open directly. Calendar and email outcomes remain reviewable
  drafts. Station has no send, schedule, invite, create, update, or delete UI.

## Runtime path

1. The Electron main process owns a transparent, always-on-top Station window.
   Its native frame keeps the same vertical and display anchor at both widths;
   visible motion is CSS-controlled so resizing does not pull the pointer.
2. The main OpenWork renderer owns microphone permission, the live passive-agent
   loop, selected context, and the bounded suggestion history.
3. The server exchanges either managed OpenWork Models authority or a standard
   local OpenAI project key for a short-lived Realtime client secret. The
   standard key never enters a renderer.
4. The renderer runs `gpt-realtime-2.1` over WebRTC with text-only output and
   `gpt-live-transcribe` input transcription. Transcript events are reconciled
   by item ID, and an audio analyser drives the Station cluster.
5. The silent Realtime agent decides when a meaningful turn merits
   `research_current_context`. Filler and background speech do not trigger a
   scan.
6. A scan uses a transient OpenCode session with filesystem, shell, task, and
   ordinary execution tools disabled. It chooses a connected, text-and-tool
   capable model, requests low effort structured output, performs no retries,
   and falls back to honest local signals after 17 seconds.
7. New signals are normalized, sanitized, deduplicated, relevance-decayed, and
   accumulated to a maximum of eight. A suggestion is labeled
   `openwork-connect` only when the model returned at least one valid HTTP(S)
   source URL.
8. Stopping Station closes the Realtime session, audio context, and media tracks
   immediately while preserving reviewable context in memory.

For local desktop development, put the standard project key in the ignored
`.env.station.local` file:

```dotenv
OPENAI_API_KEY=your-project-key
```

`pnpm dev` loads this optional file before Electron and the local server start.
Variables explicitly supplied by the shell take precedence. A configured
OpenWork Models broker can mint the same Station session without a local key.

## Authority and privacy boundary

- External actions are never executed from the Station UI. The only external
  navigation is opening a cited source; generated messages and meetings are
  drafts for review.
- The analysis policy permits Connect execution only when the discovered
  capability name clearly describes a read operation and rejects write-oriented
  names. This classifier is covered by unit tests.
- Retrieved claims must retain valid provider URLs. Local fallbacks explicitly
  carry no sources and never pretend that connected research succeeded.
- Analysis sessions are transient and deleted after each scan.
- Recent transcription and suggestion state remain in renderer memory. The MVP
  introduces no transcript persistence path.

Connect still needs a broker-enforced read-only execution scope or allowlist
before this can be described as a production-grade authority boundary. The MVP
uses a conservative analyzer policy, but that policy is not provider-side
authorization.

## Scenario and surface verification

Two Fraimz flows exercise the real desktop surface:

- `openwork-station-live-scenarios` sends recall, Berlin/Denver scheduling, and
  follow-up conversations through the Station server route and verifies that
  sources and actions are represented honestly.
- `openwork-station-mvp-surface` connects to the Station window, intentionally
  arms a bubble, pins the switchblade card, and checks the compact physical
  composition.

```sh
pnpm fraimz --flow openwork-station-live-scenarios --cdp-url http://127.0.0.1:9222
pnpm fraimz --flow openwork-station-mvp-surface --cdp-url http://127.0.0.1:9222
```

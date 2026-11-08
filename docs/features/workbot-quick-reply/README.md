# Workbot quick reply

Feature key: `workbotQuickReply` · Deployments: cloud and self-hosted · Default: off · Author: @benjaminshafii

## Behavior

When enabled, Workbot is instructed to acknowledge work requests in one or two short human sentences **before any tool call**, including discovery, reactions and browser/computer operations. It names its next intended action without claiming the action already happened, inventing an ETA or promising a two-second SLA. Detailed progress belongs in the working-status UI when that separate feature is enabled.

The web client briefly waits for its existing chat stream's `ready` event before sending, for at most 200 ms. An already-ready stream adds no wait. A failed, disconnected or unavailable stream never blocks sending beyond that bound; normal transcript refresh/reconnect still applies. Stream readiness is per chat and cleared on disconnect or unmount.

For accepted explicit long requests, the UI can show an ephemeral acknowledgment while waiting for the first real model words. That receipt is not a model-generated answer, is not persisted as transcript content and does not claim completed work, verified facts or that a browser action succeeded. The first real model words replace it. It is not a substitute for receiving or rendering the actual streamed answer.

## Compatibility and rollout

- Independent of `workbotWorkingStatus`; both default off.
- Den resolves the organization flag and sends `quickReply` to the Workbot server and web host.
- Missing fields from older Den/Workbot deployments mean off.
- With the flag off, the original first-reply and emoji-reaction instructions remain unchanged, and sending does not wait for stream readiness.
- This feature does not change Slack or the headless runner/browser runtime.
- Pure server lifecycle corrections (terminal/abandoned turns no longer projecting as active) are bug fixes and not gated by this flag.

## Verification

Prompt regressions cover on/off rules with and without working status, main and side-chat propagation, and older payload defaults. Stream tests cover readiness, chat isolation and bounded disconnection fallback. A live-model two-second response bound is neither enforced nor guaranteed by these tests or the prompt.

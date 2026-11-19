# Workbot: Your agent checks each message before sending

Feature `workbotAgentSendCheck` (cloud only, off by default). Author: `reachjalil`.
It works on top of [Your agent's brief](../workbot-agent-brief/README.md): `workbotProactive` and `workbotAgentBrief`
must both be on for a member, the deployment needs `DEN_AGENT_EVALUATION_API_KEY`, and an admin turns the check on in
Manage › Workbot.

With the brief, a check has two steps: the check reads the member's sources and reports findings, then a short
message turn writes at most a few messages. In the replay evals that pipeline misses far fewer important items than
the four fixed message types did, and interrupts more often for nothing: a message about something the brief says to
skip, or the same thing twice in a day. The send check reads each message once more before Den sends it, and holds
those.

## What changes

| | Before | With the send check on |
| --- | --- | --- |
| After the message turn | Den's hard limits, then the Workbot DM | Each message is read by a second, fast model first; Den holds one it is confident about, then the limits and the DM as before |
| What can hold a message | Hours, snooze, told-once per item, the daily limit | Also: the brief says to leave it out; it only repeats what the agent told the member today |
| A message the check can't answer for | — | Sent, as before |

The check never writes, rewrites or adds a message, and never picks who gets one.

## How it works

```
step 2 wrote {messages} ─▶ for each message: one request to the check model
                             state:     the brief (organization + member lines), the message, what was told today
                             questions: skip?   does the brief say to leave this out, with no exception applying
                                        repeat? does it only repeat something told today, with nothing new
                           ─▶ Den's rule (decideSendCheck): hold at probability ≥ the threshold (0.8 by default);
                              an update is never a repeat
                           ─▶ Den's hard limits (decideBriefDelivery) ─▶ a Workbot DM per message, as today
```

- **The model** is `typesafe-ai/jev` through Vercel AI Gateway's evaluation endpoint: it answers yes-or-no questions
  with a probability and generates no text. One attempt per message, a 4 second limit, no retries, no redirects, and
  the request asks the provider to keep nothing (`zeroDataRetention`). `ee/apps/den-api/src/workbot-proactive/send-check.ts`.
- **The rule** is plain code in `packages/automations/src/proactive-brief.ts` (`agentSendCheckRequest`,
  `decideSendCheck`, `agentToldToday`). An `update: true` message is never held as a repeat.
- **The threshold** is the policy's own (`settings.sendCheckThreshold`), 0.8 until an admin changes it: high on purpose,
  because holding a message the member needed costs more than sending one they didn't. With the switch on, Manage ›
  Workbot shows "Hold a message only when at least this sure" with 60% to 95%; the API takes any value from 0.01 to
  0.99. Higher sends more messages; lower holds more.
- **What was told today** is the agent's own messages in the member's Workbot DM since the start of their day (the DM
  read step 2 already makes), plus the first sentence of anything Den sent today that the read missed.
- **A held message** is not recorded in the ledger. If the next check finds the same thing, it is checked again.
- **Records**: a check where everything was held because of the brief is recorded `findings_held` (quiet); held as
  repeats, `already_told`. No new reason or table.

## Who can turn it on

Three things, all required:

1. The feature, for the organization or member (`/admin` › Features).
2. `DEN_AGENT_EVALUATION_API_KEY` on den-api: a Vercel AI Gateway key that can call `typesafe-ai/jev`. Without it the
   switch is shown locked with "Not set up on this deployment. Ask your deployment administrator." (DESIGN.md P4).
3. The switch **Check each message before sending** in Manage › Workbot (Messages group; also on a team's own policy).
   Off by default. `PUT /v1/org/workbot-settings/proactive` takes `sendCheck: boolean` and `sendCheckThreshold: number`;
   the view has `settings.sendCheck`, `settings.sendCheckThreshold` and `sendCheck: { ready }` while the feature is on.

## Data

The request carries the brief, one drafted message and today's agent messages for that member. The drafted message is
written from the member's email, calendar and chat, and it goes to a provider the organization did not choose as its
Workbot model, which is why the feature is cloud only and behind its own switch. Den logs counts and timings only
(`workbot_agent_send_check`: messages, held for the brief, held as repeats, unavailable, duration, input tokens),
never the message, the brief or the model's answers.

## Turning it off

The feature, the kill switch or the admin's switch each take effect at the next check: messages are sent exactly as
with the brief alone. Nothing is stored for the check, so there is nothing to migrate or clean up.

## Measuring it

The replay evals can run the brief's pipeline with the check:

```sh
AI_GATEWAY_API_KEY=… JEV_AI_GATEWAY_API_KEY=… pnpm --dir evals agent:brief-replay --pipelines new --send-check
```

The check uses its own `JEV_AI_GATEWAY_API_KEY`, never the replay model's key, which may belong to another endpoint.

Compare the report with a run without `--send-check`: unwanted interruptions should drop while missed items stay
where they were. `runs.json` lists what each check held and why. The default threshold has not been tuned on those
days yet, which is why it can be changed without a deploy.

## What to watch

- `workbot_agent_send_check` in den-api logs: a rising `unavailable` means the key or the provider is failing (the
  check is then a no-op); `held_brief` and `held_repeat` against `messages` is how often it holds.
- Members' check history in My bot: more "Stayed quiet" entries on checks that had findings.

# Workbot: Your agent writes one message per check

Feature `workbotAgentOneMessage` (cloud and self-hosted, off by default). Author: `benjaminshafii`.
It works on top of [the brief](../workbot-agent-brief/README.md) (`workbotAgentBrief`): both must be on for a member.
Off, a check works exactly as before.

With the brief, a check was two model turns. The first read the member's sources and ended with a list of findings.
The second, which has no tools, turned that list into Slack messages of about 350 characters each. The writer never
saw a source, so it could not check anything, said "unverified" a lot, labelled links "Email thread", and split one
morning into several alerts sent in the same second. This feature removes the second turn: the agent that did the
reading writes the message.

## What changes

| | Before | With the feature on |
| --- | --- | --- |
| Model turns per check | Two: read, then a tool-less writer | One: the agent that read writes |
| Messages per check | Up to the daily limit, one finding each | At most one, a short paragraph per finding, at most three |
| Length | About 350 characters, cut at 1,000 | As long as the member needs to act, cut at 3,000 |
| Links | Listed at the end with generic labels | In the sentence they support, labelled with what is behind them |
| Tone | Alerts ("triage now") | Describes what happened and what the agent would do ("I'd …") |
| Things outside the member's work (a personal account, an old side project) | Told like anything else | Notes only, unless the brief asks or waiting costs money, data or safety |
| Sources that need connecting | One "Quick check: I can't read your …" message per connection | One message naming all of them, saying the rest is still being checked |

The daily limit, hours, quiet windows, snooze, the told-once ledger and "Check each message before sending" apply to
the one message as they did to each message before.

## How it works

```
a check is due ─▶ feature on for the member?  no: the two-turn check, as today
  ─▶ sources that need connecting: one message for all not yet told
  ─▶ one turn: agentOneMessageInstructions + the check prompt with what was sent today and the recent conversation
  ─▶ the answer is the messages JSON or NO_REPLY; anything else is asked again once in the same session
  ─▶ asOneMessage: several messages become one, so a check can never send more than one
  ─▶ send check, delivery rules, ledger and limit, as today
```

- The instructions, the prompt option and `asOneMessage` are in `packages/automations/src/proactive-brief.ts`.
- The check is `wakeAgentBrief` in `ee/apps/den-api/src/workbot-proactive/wake-brief.ts`; the flag is read once per
  check in `worker.ts`.
- The combined notice is `noticeUnreadableSources` (`combined`) in `wake-shared.ts`.
- A message about several things records the first new one as sent and the others as folded, so none is told again.
- The agent's last findings report is neither read nor written on this path; what it kept for later is in its own
  `memory/open.md`.

## How to try it

1. Turn `workbotAgentBrief` and this feature on for an organization in `/admin` › Features.
2. With a member whose agent is on, wait for the next check or move it forward in My bot.
3. The check sends one message or none. My bot shows the check as before.

## Turning it off

The kill switch returns the next check to two turns and one notice per connection. Nothing kept needs cleaning up:
the ledger, the daily count and the agent's memory are shared by both paths.

## What to watch

- Log `workbot_agent_ran` (den-api) has `path: "one_message"` for these checks, with `report` (`messages`, `quiet` or
  `invalid`), `delivered` and `sent`.
- Log `workbot_agent_message_retry` counts answers that had to be asked again.
- The writer now has the check's read tools and sees what the sources say, where the old writer saw only the findings
  report. Text from a source is still cleaned before delivery (links only to the sources' own domains, no mentions).
- Cost per check: one turn instead of two, with the conversation added to the check prompt.
- `/admin` › Features counts a member as using the feature at each check where it is on for them.

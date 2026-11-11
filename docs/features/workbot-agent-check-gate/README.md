# Workbot: Your agent skips checks when nothing new arrived

Feature `workbotAgentCheckGate` (cloud only, off by default). Author: `reachjalil`.
It works on top of [Your agent's brief](../workbot-agent-brief/README.md): `workbotProactive` and `workbotAgentBrief`
must both be on for a member, and an admin turns the gate on in Manage › Workbot.

With the brief, a member's agent checks every two hours in working hours. Each check is an agent turn that reads
their email, calendar and chat with tools: in the replay evals about 25,000 input tokens and several model calls, and
most checks end with nothing to tell the member. The gate answers one question before that turn starts: did anything
arrive that could matter? If not, the turn doesn't run.

## What changes

| | Before | With the gate on |
| --- | --- | --- |
| A scheduled check | Always an agent turn | Den first looks itself at what reached the member since the agent last looked |
| Nothing arrived | The agent reads everything and reports nothing | No agent turn and no model call at all |
| Only routine mail arrived (newsletters, automated notices) | Same | With the evaluation model: no agent turn. Without it: the check runs |
| Anything that may matter, or anything Den can't tell | Same | The check runs, as before |
| The member's check history | "Stayed quiet: nothing needed you." | "Stayed quiet: nothing new." for a skipped check |

## How it works

```
a scheduled check is due
  first check of the day, or one the agent asked for (request_check)  ─▶ run
  two checks already skipped in a row                                  ─▶ run
  a source Den can't look at itself (team chat, another connection)    ─▶ run
  ─▶ Den looks: Gmail (sender, subject, first words, category) and Google Calendar (meetings that changed)
       since each was last read by the agent
  a failed look, or more than 15 arrivals                              ─▶ run
  nothing arrived                                                      ─▶ skip
  otherwise, with DEN_AGENT_EVALUATION_API_KEY: one question to the evaluation model
       "could any arrival be something the brief asks about, or need the person soon?"
       probability ≤ the threshold (0.2 by default) ─▶ skip        anything else, or no answer ─▶ run
  without the key                                                      ─▶ run
```

- **The look** is plain API reads as the member, through their Google Workspace connection, with no model:
  `readMemberGmailArrivals` (a list, then headers and labels; never a body, sent mail, drafts, spam or trash) and the
  calendar read the check already makes. `ee/apps/den-api/src/workbot-proactive/check-gate.ts`.
- **The rules** are plain code in `packages/automations/src/proactive-brief.ts` (`checkGateApplies`, `planCheckGate`,
  `decideCheckGate`). The model is asked to answer "true" when unsure, and the check is skipped only at or below the
  threshold.
- **The threshold** is the policy's own (`settings.checkGateThreshold`), 0.2 until an admin changes it. With the switch
  on, Manage › Workbot shows "Skip only when the chance new mail matters is at most" with 5% to 50%; the API takes
  any value from 0.01 to 0.99. Lower runs the agent more often; higher skips more.
- **The evaluation model** is `typesafe-ai/jev` through Vercel AI Gateway: it answers one yes-or-no question with a
  probability and generates no text. One attempt, a 4 second limit, no retries, no redirects, and the request asks the
  provider to keep nothing.
- **A skipped check marks nothing as read.** The agent's "last read" times don't move, so the next look and the next
  check that runs cover the same arrivals again. Only the rhythm moves on to the next slot.
- **Never more than two in a row.** Deadlines, follow-ups and "still waiting" are about time passing, not about new
  mail, so after two skipped checks the next one runs whatever arrived. With the default rhythm (8, 10, 12, 2, 4, 6)
  a silent day runs the agent at 8 and 2 instead of six times.

## What Den can and can't look at

Den can look at Gmail and Google Calendar. If the check would also read anything else (Slack or Teams, another
connection the member turned on, Microsoft mail or calendar), Den can't tell whether something arrived there, so the
gate never skips for that member. `workbot_agent_check_gate` logs say how often (`outcome: run:unknown_source`, with
`unknown` naming the kind of source), which is how to decide what to teach it next.

## Turning it on

1. The feature, for the organization or member (`/admin` › Features).
2. The switch **Skip checks when nothing new arrived** in Manage › Workbot (Schedule group; also on a team's own
   policy). Off by default. `PUT /v1/org/workbot-settings/proactive` takes `checkGate: boolean` and
   `checkGateThreshold: number`; the view has `settings.checkGate`, `settings.checkGateThreshold` and `checkGate: { model }`
   while the feature is on.
3. Optional: `DEN_AGENT_EVALUATION_API_KEY` on den-api, a Vercel AI Gateway key that can call `typesafe-ai/jev`.
   Without it only "nothing arrived" skips a check.

## Data

Without the key nothing leaves Den and Google. With it, the request carries the brief and, for each new email, its
sender, subject, first words and category, plus one line per changed meeting. That is the member's private mail going
to a provider the organization did not choose as its Workbot model, which is why the feature is cloud only and behind
its own switch. Den logs counts and timings only (`workbot_agent_check_gate`: the outcome, how many arrivals, skips in
a row, duration, input tokens), never a sender, a subject or the model's answer.

## Turning it off

The feature, the kill switch or the admin's switch each take effect at the next check: every check runs, as with the
brief alone. A member's count of skipped checks stays in their agent's state and is ignored.

## What to watch

- `workbot_agent_check_gate` by `outcome`: `skip:nothing_new` and `skip:routine` are the saved agent turns;
  `run:unknown_source` is members the gate can't help yet; `run:no_answer` means the key or the provider is failing.
- `workbot_agent_step_usage` for `step: check`: fewer rows per member per day is the saving.
- Missed items: a member told late about something that arrived during a skipped stretch. The two-in-a-row limit
  bounds the delay to about two rhythm slots. The default threshold has not been measured on the replay days yet,
  which is why it can be changed without a deploy.

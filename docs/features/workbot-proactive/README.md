# Workbot: Your agent

Feature `workbotProactive` (cloud and self-hosted, off by default). Author: `benjaminshafii`.
It also needs Workbot on the deployment (`DEN_WORKBOT_URL`), the headless runner (`DEN_HEADLESS_RUNNER_URL`) and, for
the default destination, the Workbot Slack app (Slack assistant) installed for the organization.

Every member gets one persistent background agent, "Your agent", running in the cloud on the standard headless runner.
With no events at all it is still useful: a morning pass, then a check about every three hours inside working hours,
reading Gmail and Google Calendar since its last look. Calendar events only wake it sooner. It sends one short message
when something needs the member, and stays quiet otherwise. It only reads: it never sends, accepts or edits anything
for them.

## Architecture

```
wake: schedule (morning + ~3h)  ─┐
      calendar event (5-min diff)┴▶ one turn in the agent's own session ─▶ NO_REPLY | {message, items}
                                                                              │
                                     delivery step in Den (plain code) ◀──────┘
                                     quiet hours · snooze · mutes · one message per item · daily limit
                                                                              │
                                     a DM from the Workbot Slack app, to the member only ◀┘
```

1. **Wake** (`den-api/src/workbot-proactive/worker.ts`). A Den loop claims agents whose `next_wake_at` is due, with a
   row lease, so replicas never run one agent twice. `next_wake_at` is the earlier of the next scheduled pass and the
   next calendar look. Only the schedule and calendar events wake an agent; the model never schedules its own.
2. **Gates** (`wake.ts`). Feature (with member overrides), Workbot deployed, the organization switch, the member's own
   on/off and snooze, a destination that can arrive (for a Workbot DM: the Slack app installed and the member's Slack
   account linked), at least one active responsibility, working days and hours in the member's calendar time zone. A
   blocked destination skips the turn and is shown in the member's settings, so no model call is wasted.
3. **Event source** (pure, `@openwork/automations/proactive`). One read-only `events.list` as the member every five
   minutes, diffed against a checkpoint: a meeting with people from outside the company inside the lead time, or a
   meeting today or tomorrow someone else added, moved or cancelled. Each event wakes the agent once. The prompt names
   the event by id, time and attendee counts only: titles, descriptions and organizer names are written by whoever
   sent the invite, so the agent reads them itself, as data, with its tools.
4. **The turn** (`turn.ts`). The agent's own durable session (`hs_agent_<hash>`), never the member's Workbot chat
   and never `memoryOf` it. Standard runner tools only, plus Connect tools with a read-scoped MCP token (`mcp:read`):
   Gmail search with `after:`, Calendar events. Not `credentials.readOnly`, which would remove the file tools, so the
   agent keeps its notes in `memory/`. Den starts each turn with a short prompt: why it woke, the last-look time per
   source, and the active responsibilities. The default answer is `NO_REPLY`; anything unparsable is silence.
5. **Delivery step** (`wake.ts`, pure rules in `decideAgentDelivery`). Quiet hours, snooze, responsibilities that are
   off or muted, the ledger (one message per item: responsibility plus the item's ref), and the daily limit. Past the
   limit, items are recorded as `capped` and never retried later.
6. **Deliver** (`deliver.ts`). Den, not the model, sends after policy, and the model never picks recipients. Always a
   DM from the Workbot Slack app's own bot: `sendWorkbotDirectMessage` in `slack-assistant/direct-message.ts` opens
   the member's DM with the app and posts there, so Slack notifies them like any DM. It is the shared helper for
   anything that notifies a member. Never a channel: the agent reads private email, so its messages go only to the
   member. Text is cleaned first: no `@channel`/`@here`/user mentions, and links only to the member's own Google
   workspace.

## Responsibilities (day one)

| Responsibility | What the member gets | Woken early by |
| --- | --- | --- |
| Morning brief | Today's meetings with other people, overlaps, what needs prep. Morning pass only | The schedule |
| Meeting prep | Before a meeting with people from outside the company: the last thread with them and what they're waiting on | A meeting with outsiders entering the lead time |
| Calendar changes | Meetings today or tomorrow that someone else added, moved or cancelled | The calendar diff |
| Waiting on you | External email unanswered for more than about 4 hours, with an offer to draft a reply in Workbot | The schedule |

Ignored: the member's own changes, declined meetings, all-day events, focus time, out of office, working location,
meetings with nobody else, anything after tomorrow.

## The template: a versioned `agent` config object

`agent` config objects are markdown agent definitions today (Library imports `AGENT.md` / `agents/*.md`: frontmatter
with `name` and `description`, then the agent's instructions), the OpenCode/Claude agent format. "Your agent" uses that
format and extends the frontmatter (`template.ts`):

```md
---
name: your-agent
description: Reads each member's Gmail and Google Calendar on a schedule and tells them only what needs them.
mode: primary
sources: gmail, google_calendar
responsibilities: morning_brief, meeting_prep, calendar_changes, waiting_on_you
schedule: morning pass, then every 3 hours in working hours
---
<the agent's instructions>

## Organization instructions
<the admin's short text>
```

The built-in default is version 1 and lives in code. An admin edit (responsibility toggles, organization instructions)
adds a `config_object_version` to the organization's one "Your agent" object (`openwork/agents/your-agent.md`). Each
member's agent is a small `agent_instance` row: the template version it last ran, the member's allowed overrides
(muted responsibilities, destination), status, snooze, `next_wake_at`, encrypted state and a lease.

## Admin settings (Manage › Workbot › Members' agents)

| Setting | Stored in | Default |
| --- | --- | --- |
| Agents for everyone | organization metadata `workbot.proactive.enabled` | off |
| Send messages to | `workbot.proactive.destination`: a DM from Workbot, or nowhere yet (never a channel) | a DM from Workbot |
| Morning brief, Meeting prep (+ how early), Calendar changes, Waiting on you | the template (meeting lead time in metadata) | all on, 15 min |
| Instructions for every agent | the template | empty |
| Working hours | `workingDays`, `startHour`, `endHour` | weekdays, 8–19 |
| Daily limit | `dailyCap` | 3 per person |
| Members start | `membersStart` | opted in |

The page previews each kind of message as plain text, as the DM from the Workbot app. The switch stays visible but
locked, with the reason, when there is nowhere to send messages, when the Slack app is not installed, or when the
headless runner is missing (DESIGN.md P4, C5).

## Health (`workbotAgentHealthView`, off)

Under the settings, a "Last 7 days" table shows per responsibility: checks (passes that asked the agent about it), the
share that stayed quiet, messages sent, and how many members muted it. It reads `agent_check`, daily counters per
organization and responsibility (migration 0162) that each completed pass adds to, and the members' mutes. Counts
only: no member names, message text or email content. `GET /v1/org/workbot-settings/proactive/health`.

## Member controls

`GET /v1/me/agent` answers "what will my agent tell me about?": each responsibility with whether the organization
turned it on and whether the member muted it, where messages go, the hours and limit. `PUT /v1/me/agent` takes plain
choices: `on`, `snooze: "tomorrow" | null`, `mute` / `unmute`. `destination.blocked` says why messages can't arrive
yet (`slack_app_not_installed`, `member_not_linked`). Both are tagged for Connect, so a member
can say "stop telling me about calendar changes" or "snooze until tomorrow" to Workbot. The agent's own `mcp:read`
token can read them but never change them. There are no buttons on messages and no Slack Home tab.

## Where notes live

The agent keeps its notes in its own session's scratch files under `memory/` (what it already told the member,
threads it is watching). Den stores only the calendar checkpoint, last looks and schedule. When the shared per-user
filesystem lands, the notes move to `/files/agents/<agent>/` and the session reads them from there.

## Slack delivery: why a DM from the Workbot app

Connect's Slack connection is Slack's own MCP server (`https://mcp.slack.com/mcp`, per-member OAuth). Slack's MCP OAuth
issues user tokens only, so `slack_send_message` posts **as the member** (Den's Slack binding checks `auth.test` and
refuses bot tokens). Slack never notifies people about their own messages, so a message posted as the member, even in
their DM with themselves, pings nobody. The default destination is therefore a DM from the Workbot Slack app's own bot
(the Slack assistant's installation and bot token, the member's linked Slack user id):

- **A member who never wrote to the app** can be DMed: `conversations.open` with the bot token needs `im:write`, and
  `chat.postMessage` needs `chat:write`; both are in the app's scopes (`slack-assistant/protocol.ts`), and the
  manifest has the Messages tab on and writable.
- **When the member replies in the message's thread**, the Slack assistant reads that thread with the member's own
  token (`conversations.replies`), so Workbot sees what it sent. A new top-level message in the DM starts a new
  conversation without it.
- **Without the Slack app, or before the member links their Slack account**, nothing runs: the wake is skipped with
  `slack_app_not_installed` or `member_not_linked`, the admin page shows the lock, and `GET /v1/me/agent` shows why.

Not live-tested against a Slack workspace; the unit tests cover the calls Den makes.

## Safety

- **Read-only through MCP.** The turn's token is `mcp:read`: Den refuses every non-GET capability and every external MCP
  tool for it. Den delivers only after the delivery step, with text it cleaned.
- **Invite text stays out of the prompt.** Calendar wakes name events by id and time; the agent reads titles and
  descriptions as data.
- **Only to the member.** Messages are DMs from the Workbot app, never channel posts: an email sender could steer
  what the agent writes, and private mail must not reach a shared channel. Posting to a channel would need per-message
  approval first.
- **No memory pollution.** The agent's reading stays in its own session. Only delivered text leaves it.
- **At most once.** A ledger row is reserved before sending, so a crash never sends twice. Silence wins on doubt: an
  unparsable answer, a runner outage or a failed model check mean no message.
- **Restraint in code.** Working hours, 3 a day by default, one message per item, mutes and snooze.

## Turning it off

The kill switch (or the organization switch) stops new wakes on the next tick; a pass already running re-checks the
feature right before delivering. Agent rows, sessions and ledger rows stay and are harmless. Turning it back on resumes
from the stored state.

## What this PR does not do yet

1. A model-in-the-loop eval: about 10 recorded calendar and inbox timelines replayed against the real runner and model,
   each 2–3 times, scored "should message" or "should stay quiet". Timelines to record: a quiet morning; a meeting
   moved by someone else; the member's own move; an external meeting in 15 minutes with an open thread; the same with
   nothing useful; an external email unanswered for 5 hours; the same answered; a newsletter; three changes in one
   hour past the daily limit; a cancelled meeting tomorrow.
2. Follow-ups ("remind me", "tell me when"): no `schedule_wake` tool yet.
3. Copying delivered text into the member's Workbot conversation.
4. A member settings page in Den web (the API and Connect capability exist).
5. Desktop notifications as a destination.

## Try it locally

```sh
pnpm dev:den:mysql && pnpm dev:workbot
# /admin › Features › Workbot: Your agent › on for your organization
# Connectors › Slack › install the Workbot Slack app, then Den › Manage › Workbot › Members' agents
```

`pnpm --filter @openwork/automations test` and `pnpm --filter @openwork-ee/den-api test` cover the schedule, event
source, prompt, reply parsing, delivery rules, the turn's session and token, and delivery without a runner, Slack or
Google. `evals/proofs/workbot-proactive-settings.proof.test.ts` drives the admin page.

## Screenshots

Off, locked until the Workbot Slack app is installed (real Den, `workbotProactiveWorld`):

![Members' agents, off and locked until the Slack app is installed](./admin-agent-off.png)

On, sending a DM from Workbot, with the template at version 3 and the meeting prep preview:

![Members' agents, on](./admin-agent.png)

# Workbot: Your agent says when it stops reading a source

Feature `workbotAgentStoppedSources` (cloud and self-hosted, off by default). Author: `reachjalil`.
It works on top of Your agent (members' agents on in Manage › Workbot), with or without
[the brief](../workbot-agent-brief/README.md).

A member's agent reads only the sources that are on for them. When a source goes off, it is left out of the next
check's prompt and token, the check runs on what is left, and it is recorded "Stayed quiet". Nothing tells the member
or an admin that the agent now reads less, so a policy change can make every agent in an organization quieter without
anyone noticing. This feature makes that visible.

## What changes

| | Before | With the feature on |
| --- | --- | --- |
| A source the agent read in the last week is no longer on for the member | It drops out of the check without a word | One Workbot DM, once, naming the source; a check in My bot, "Stopped reading Slack: no longer on for your agent." |
| The member can turn it back on (the admin left it to members) | — | The message links to My bot: "Choose what I read" |
| An admin turned it off | — | The message says the admin turned it off for agents; no link |
| No source is left to read | Checks stop with no record | The message also says "I have nothing else to check until a source is on." |

Nothing is said when:

- the member turned the source off themselves;
- the source is on but its account needs connecting (the existing "I can't read your …" message covers that);
- the agent last read the source more than 7 days ago, or never.

## How it works

```
a check is due ─▶ the member's sources, as today
  ─▶ stoppedSources: not on, read in the last 7 days, not turned off by the member
  ─▶ feature on for the member?  no: nothing is told or kept
  ─▶ already told (the agent's state, `notices["stopped:<source id>"]`)?  yes: nothing more
  ─▶ one DM for the sources the member can turn back on, one for the ones an admin turned off
  ─▶ a check record, reason `source_stopped` (outcome `failed`), naming the sources
  ─▶ the check runs on what is left, as today
```

- The rule is `stoppedSources` in `ee/apps/den-api/src/workbot-proactive/sources.ts`; the message and the record are
  `noticeStoppedSources` in `wake-shared.ts`. Both ways of waking an agent call it (`wake.ts` and `wake-brief.ts`).
- A notice is forgotten when its source is on again, so a later stop is told again.
- A message that could not be sent is tried again at the next check.
- The message does not count against the member's daily limit, like the "I can't read your …" message.

## How to try it

1. Turn the feature on for an organization in `/admin` › Features.
2. With a member whose agent read a connection at its last check, set that connection to "Members choose" (or "Not
   allowed") in Manage › Workbot › Connectors.
3. At the member's next check they get the DM, and My bot shows the "Stopped reading" check.

## Turning it off

The kill switch stops the messages and the records at the next check. Notices already kept are dropped from the
agent's state on its next check, so turning it on again can tell a member once more about a source that stopped in the
last 7 days. Check records already written stay readable.

## What to watch

- Log `workbot_agent_source_stopped` (den-api): `member_id`, `source_id`, `policy` (`off` is an admin's choice,
  `members` is the member's), `told` (whether the DM was sent). One line per source, once.
- `/admin` › Features counts a member as using the feature at each check where their agent has a stopped source,
  told already or not.
- Admins are not told in the product: the member is, and the log line is the organization-wide view.

# Workbot: Your agent says when it stops reading a source

Generally available on Cloud and self-hosted (retired rollout: `workbotAgentStoppedSources`). Owner: `reachjalil`.
Applies when [members' agents](../workbot-agent-brief/README.md) are enabled in Manage › Workbot.

A member's agent reads only the sources that are on for them. When a recently read source goes off, the agent leaves it out of the next check's prompt and token and tells the member why it stopped reading it.

## What members see

| When | What the member sees |
| --- | --- |
| A source the agent read in the last week is no longer on for the member | One Workbot DM, once, naming the source; a check in My bot, "Stopped reading Slack: no longer on for your agent." |
| The member can turn it back on (the admin left it to members) | The message links to My bot: "Choose what I read" |
| An admin turned it off | The message says the admin turned it off for agents; no link |
| No source is left to read | The message also says "I have nothing else to check until a source is on." |

Nothing is said when:

- the member turned the source off themselves;
- the source is on but its account needs connecting (the existing "I can't read your …" message covers that);
- the agent last read the source more than 7 days ago, or never.

## How it works

```
a check is due ─▶ the member's sources, as today
  ─▶ stoppedSources: not on, read in the last 7 days, not turned off by the member
  ─▶ already told (the agent's state, `notices["stopped:<source id>"]`)?  yes: nothing more
  ─▶ one DM for the sources the member can turn back on, one for the ones an admin turned off
  ─▶ a check record, reason `source_stopped` (outcome `failed`), naming the sources
  ─▶ the check runs on what is left, as today
```

- The rule is `stoppedSources` in `ee/apps/den-api/src/workbot-proactive/sources.ts`; the message and the record are
  `noticeStoppedSources` in `wake-shared.ts`. `wake-brief.ts` calls it before reading remaining sources.
- A notice is forgotten when its source is on again, so a later stop is told again.
- A message that could not be sent is tried again at the next check.
- The message does not count against the member's daily limit, like the "I can't read your …" message.

## How to try it

1. In a test organization, enable members' agents in **Manage › Workbot** and link a member to the Workbot Slack app.
2. With a member whose agent read a connection at its last check, set that connection to "Members choose" (or "Not
   allowed") in Manage › Workbot › Connectors.
3. At the member's next check they get the DM, and My bot shows the "Stopped reading" check.

## What to watch

- Log `workbot_agent_source_stopped` (den-api): `member_id`, `source_id`, `policy` (`off` is an admin's choice,
  `members` is the member's), `told` (whether the DM was sent). One line per source, once.
- Admins are not told in the product: the member is, and the log line is the organization-wide view.

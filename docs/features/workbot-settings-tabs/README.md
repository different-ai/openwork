# Workbot: settings in tabs

Feature key: `workbotSettingsTabs` · Deployments: cloud and self-hosted · Default: off · Author: @reachjalil

## What changes

With members' agents on (`workbotProactive`), Workbot's settings are one long
page: Workbot's own settings (on or off, default model, step limit, name),
then how members' agents work (messages, schedule, limits, what to tell
people, a preview), then what agents read (calendar, email, team chat and
other connections). The same page appears in two places:

- Den › Manage › Workbot.
- Den › Members › Teams › a team (or Everyone) › Workbot
  (`workbotTeamSettings`).

With the feature on, both split it into three tabs:

| Tab | What it holds |
|---|---|
| General | Workbot on or off (teams and Everyone), default model, completion check (Manage › Workbot), step limit, name, and the saved and undo lines for these |
| Members' agents | The agents switch, where messages go, the schedule and limits, what to tell people and the preview; on Manage › Workbot also the last 7 days |
| What agents read | Calendar, email, team chat and other context, with each connection's tools |

- The tabs show only where members' agents show. Without them the page is
  short and stays as it is.
- Notices about the whole page (read only, models unreachable) stay above
  the tabs.
- On a team's page, "From Everyone" / "Changed for {team}" and "Use
  Everyone's" stay on the heading of both agent tabs, because a team changes
  members' agents and what they read as one unit.
- "See the last 7 days" on Everyone's page opens Manage › Workbot on the
  Members' agents tab.

## Clearer rows on Members' agents

With Your agent's brief on as well (`workbotAgentBrief`), the Members' agents
rows are regrouped and reworded. Each row saves the same value as before.

| Before | Now |
|---|---|
| **Send messages to**: a list with "A DM from Workbot" and "Nowhere yet" | **Send messages in Slack**: a switch, under Messages |
| **Members start**: a list with "Opted in" and "Must opt in" | **On for members by default**: a switch, under the agents switch |
| **Check**: four unlabelled lists in one row | Under Schedule, one row each: **Check for updates**, **Working hours**, **Working days** |
| **Messages per person per day**: 1 to 10 | **Daily message limit**: "7 a day", under Messages |
| **Extra checks agents may ask for** | **Extra checks**, under Schedule |

The rules the rows follow:

- A yes or no choice is a switch; a choice among several values is a list.
- One setting per row, with a label that names it.
- Each row has an "i" beside its label with one or two sentences on what it
  does and what members can change (hover or keyboard focus).
- Rows are grouped by what the admin is deciding: who gets an agent, what
  messages they get, when agents check, what to tell people.

Without the brief, the older rows (message types, lead time) are unchanged.

## Help on the other tabs

- **General**: Workbot, Default model, Completion check, Step limit and Name
  each have an "i" saying what the setting does and what turning it off
  affects.
- **What agents read**: Calendar, Email, Team chat and Other context each
  have an "i" explaining "On for everyone", "Members choose" and "Not
  allowed", and how the default app is used. Each app's switch says
  "Allowed" or "Not allowed" beside it, and "6 connected" reads "6 members
  connected".

What each control saves and who can edit it are the same.

## Try it

1. Turn `workbotSettingsTabs` on for the organization in `/admin` (with
   `workbotProactive`, and `workbotTeamSettings` for the team pages).
2. Open Den › Manage › Workbot, or Members › Teams › a team › Workbot.

## Turning it off

Both places show the single page again on the next load. Nothing is stored.

## Code

- `ee/apps/den-web/app/(den)/dashboard/_components/workbot-settings-tabs.tsx`
  and `workbot-settings-tabs-model.ts`: the tabs and which part each shows.
- `workbot-settings-screen.tsx` (Manage › Workbot) and
  `team-workbot-panel.tsx` (teams and Everyone) choose the part;
  `workbot-proactive-section.tsx` renders only that part (`show`).

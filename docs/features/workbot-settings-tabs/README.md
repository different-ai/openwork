# Workbot: settings in tabs

Generally available on cloud and self-hosted. The `workbotSettingsTabs` rollout flag was retired in November 2026; this is the standard settings UI. Author: @reachjalil.

## What changes

Workbot's settings use three tabs wherever members' agents are available:

- Den › Manage › Workbot. This page is no longer in the side menu for people
  who can open Members › Teams; its address still opens the same settings.
- Den › Members › Teams › a team (or Everyone) › Workbot.

| Tab | What it holds |
|---|---|
| General | Workbot on or off (teams and Everyone), default model, completion check (Manage › Workbot), name, Calendar, and the saved and undo lines for these |
| Proactive Mode | The Proactive Mode switch, where messages go, the schedule and limits, what to tell people and the preview; on Manage › Workbot and on Everyone's page also the last 7 days |
| Connectors | The connectors agents may read, each with its setting and its tools |

- The tabs show only where members' agents show. Without them the page is
  short and stays as it is.
- Notices about the whole page (read only, models unreachable) stay above
  the tabs.
- On a team's page, "From Everyone" / "Changed for {team}" and "Use
  Everyone's" stay on the heading of both agent tabs, because a team changes
  members' agents and what they read as one unit.
- Everyone's Proactive Mode tab shows the "Last 7 days" table itself (it used
  to link to Manage › Workbot).

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
- Only a row whose label can't say what it does has an "i" beside it (hover
  or keyboard focus): On for members by default, Extra checks, the check
  gate and send check rows with their thresholds, and Example message.
- Rows are grouped by what the admin is deciding: who gets an agent, what
  messages they get, when agents check, what to tell people.

Without the brief, the older rows (message types, lead time) are unchanged.

## Help on the other tabs

- **General**: only Workbot (on or off) has an "i", saying what turning it
  off affects. Default model, Completion check, Name and Calendar have none.
- **Connectors**: no "i"; the sentence under the tabs says what the tab is
  for.
- **Tools per connection**: the "Tools agents may use: 2 read tools · Review"
  line under each connection is gone. The connection's row shows the count
  ("2 read tools") as a link, which opens a dialog with each tool's name,
  description, why it is or isn't allowed and its switch, plus "Use
  automatic choices". The choices save as before.

What each control saves and who can edit it are the same.

## Try it

Open Den › Manage › Workbot, or Members › Teams › a team › Workbot.
No rollout or organization override is needed. Workbot deployment availability,
permissions and the separate Your agent's brief rollout still apply. Historical
settings-tab overrides and operator locks are ignored; older clients receive a
fixed true compatibility value.

## Code

- `ee/apps/den-web/app/(den)/dashboard/_components/workbot-settings-tabs.tsx`
  and `workbot-settings-tabs-model.ts`: the tabs and which part each shows.
- `workbot-settings-screen.tsx` (Manage › Workbot) and
  `team-workbot-panel.tsx` (teams and Everyone) choose the part;
  `workbot-proactive-section.tsx` renders only that part (`show`).

## Tab names

- The tabs are **General**, **Proactive Mode** and **Connectors** (first
  General, Members' agents, What agents read; then General, Agents, Data
  sources). Under the tabs, one sentence says what the open tab is for. The
  heading that repeated the tab's name is gone; on a team's page it stays
  beside the "Changed for {team}" chip.
- The switch that turns members' agents on reads **Proactive Mode** for
  Everyone and for a team (was "Agents for everyone" / "Agents for this
  team").
- **Tools**: the count is the link ("10 read tools") beside the
  connection's name and opens the same dialog; the separate "Manage tools"
  button is gone.
- **Connectors**: with more than 8 connectors added, a "Find a connector"
  box filters the list by name.

## Agent instructions, example and Add connector

- **Tooltips**: the "i" opens on hover after a short pause, on keyboard
  focus, and on a click or tap. Before, it waited 600 ms on hover and a
  click closed it, so clicking an "i" showed nothing.
- **Agent instructions** (was "What to tell people"): the text shows as
  text with an **Edit** button. Edit opens the box with Reset to default,
  Cancel and Save instructions; nothing saves until Save.
- **Example message** (was "Preview"): the same single sample of the DM a
  member gets in Slack from their agent, with an "i" saying it is a sample
  and does not change with the instructions.
- **Connectors**: lists only the connections an admin added, each with its
  setting, its tools and Remove. **Add connector** opens a searchable list
  of the rest; a line under it says how many other connections are up to
  each member. Adding one saves it as "Members choose" (what it already
  was); Remove puts it back to that default.

## Calendar on General; Email and Team chat removed

- **Calendar** is one row on General: a list with On for everyone, Members
  choose and Not allowed, and a line under it naming the calendar apps in
  use ("Uses Google Workspace or Microsoft 365"). There is no app list, no
  default and no "Add app": each member's agent reads the calendar app they
  picked in My bot, else the one most members connected. On a team's page,
  changing it gives the team its own copy of the members' agents settings,
  as any control on its Proactive Mode tab does.
- **Email** and **Team chat** are gone as rows. Mail and chat are read
  through the Google Workspace, Microsoft 365 or Slack connector, under that
  connector's own setting on the Connectors tab (members choose unless an
  admin decides). An organization that had email or team chat on for
  everyone follows each connector's setting from now on.
- There is no **Step limit** row: Workbot no longer has a step limit
  setting.

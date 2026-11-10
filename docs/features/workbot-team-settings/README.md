# Workbot: settings per team

Feature key: `workbotTeamSettings` · Deployments: cloud and self-hosted · Default: off · Author: @reachjalil

## What it does

Workbot's admin settings (Den › Manage › Workbot) are organization-wide: one default model and one name for
everyone. With the feature on, admins can also give a **team** its own, on the team's page (Den › Members ›
Teams › a team › **Workbot**):

- **Default model**: the model the team's members start on in Workbot, the Slack assistant and cloud Automations
  set to the cloud default. "The deployment's default model" is a choice too, as it is for the organization.
- **Workbot name**: what Workbot is called for the team's members (1 to 40 characters). Without one they see the
  organization's app name, or "Workbot".

Teams once could also set a step limit; that is gone. A team's row saved then may still hold `maxSteps`: Den
ignores it and drops it on the team's next save.

A team stores only what it overrides. A team without its own value for a setting uses the organization's, and
follows it when the organization's changes.

### A member on several teams

Each setting is resolved on its own, the same way as the desktop default model:

1. None of the member's teams has its own value: the organization's applies.
2. The teams that have one all hold the same value: that value applies.
3. They hold different values: the organization's applies. A conflict never picks one team over another.

The admin list shows, per team, how many of its members are in such a conflict (`conflictingMemberCount`).

### Where admins set it

Den web calls the organization's values **Everyone**'s. Both pages show the same three rows, in this order:
**Workbot** (a switch, on or off; see "Workbot on or off" below), **Default model** (a picker) and **Name**.

- **Members › Teams › a team › Workbot**: each row shows Everyone's value until the team changes it, with a
  chip, "From Everyone" or "Changed for {team}". Changing a control is the override: there is no separate step and
  no "use Everyone's" choice inside the picker. The switch and the model save as soon as they change, with
  "Saved. …" and Undo; the name is a text field with Save name and Discard. "Use Everyone's", beside the chip of
  a changed row, takes the team back to Everyone's value without a confirmation, and can be undone. While
  Workbot is off for the team, a line under the row says what its members lose. A line under the rows says how
  many of the team's members are also on a team with a different Workbot setting, so they get Everyone's.
- **Members › Teams › Everyone › Workbot**: Everyone's values. The switch and the default model are changed
  here (the model is the same one as on Manage › Workbot, saved the same way); the name is the organization's
  brand name, with a link to Brand appearance. A row whose value teams changed shows "Changed for {team}" or
  "Changed for N teams".
- **Manage › Workbot**: one line under the default model, "N teams have their own Workbot settings", linking to
  Members › Teams.

The tab shows for people with View OpenWork Models settings or Manage OpenWork Models; without Manage the
controls are disabled under one "Read only" notice. With the feature off the tab and the line are gone and Den
web makes no request for them.

The rows are built from the shared per-team control parts (`team-scope.ts`, `scoped-setting.tsx`; see "Per-team
controls" in `ee/apps/den-web/AGENTS.md`).

A team's model only **selects** a model. Each member still needs their own access to it; a member who cannot use
their team's model gets the same refusal as for an organization default they cannot use.

## How it works

- One row per team in `workbot_team_setting` (`settings` JSON: `model`, `name`; an absent key means "use the
  organization's"). A team with no override has no row. Deleting a team or the organization deletes its rows.
- Admin routes, both behind the feature:
  - `GET /v1/org/workbot-settings/teams`: the organization's values and every team's. View OpenWork Models
    settings or Manage OpenWork Models.
  - `PUT /v1/org/workbot-settings/teams/{teamId}`: `{ "model": { "inherit": false, "value": "…" } }`,
    `{ "name": { "inherit": true } }`, or both. Manage OpenWork Models and a recent sign-in; the same permission
    governs the team's Workbot name. A model is checked exactly like the organization's default
    (`unknown_model`, `workbot_runner_unavailable`).
- Members never read those routes. Den resolves each member's values in one place
  (`resolveMemberWorkbotSettings`, `ee/apps/den-api/src/workbot/team-settings.ts`) for:
  - `GET /v1/workbot/session`: the model and the name Workbot shows (`organization.brandAppName`).
  - `POST /v1/workbot/run-token`, `GET /v1/workbot/model-recovery` and the caller's side of
    `GET /v1/org/workbot-readiness`.
  - The Slack assistant, cloud Automations set to the cloud default (the owner's teams), Your agent and resumed
    turns, through `organizationCloudModel` / `organizationCloudModelSelection`.
- Still the organization's value: the admin page for the organization default (`GET`/`PUT
  /v1/org/workbot-settings` and its model test), `organizationGatewayRequired` in the readiness answer, and
  anything that runs without a member.

## Trying it

1. Turn `workbotTeamSettings` on for the organization in `/admin`.
2. As an admin, open Members › Teams › a team › Workbot and change the model and the name (or
   `PUT /v1/org/workbot-settings/teams/{teamId}` with a name and a model from `GET /v1/org/workbot-settings`).
3. Sign in to Workbot as a member of that team: the header shows the team's name and new chats use its model.
   A member of no team, or of two teams that disagree, sees the organization's.

## Turning it off

The kill switch, or turning the feature off for an organization, takes effect on each member's next request:
the admin routes answer 404 `feature_disabled`, the team rows are **kept but ignored** (not even read), and
everyone gets the organization's model and name again. Chats in progress keep the model their turn started
with. Turning it back on restores the saved team values.

## What to watch

- `[workbot-team-settings] could not resolve a member's team settings` in the Den API log: a member lookup or
  team read failed and that request fell back to the organization's values. A chat is never refused for it.
- `workbot_turn_access_denied` after setting a team's model: the team's members lack access to that model.

## Verification

`ee/apps/den-api/test/workbot-team-settings.test.ts` covers resolution, conflict counts, the stored shape and
the fallbacks; `ee/apps/den-api/test/api/workbot-team-settings.api.test.ts` covers the routes, permissions and
what `GET /v1/workbot/session` returns with the feature off and on. In Den web,
`workbot-team-settings-presentation.test.ts` covers the chips, the switch's labels, the picker's choices, the
name rules and the wording, and `workbot-entry.test.ts` covers the entries while Workbot is off for the viewer.

## Workbot on or off

The same feature adds a third setting, a switch: whether a member has Workbot at all. Today Workbot is on for
every member of a deployment that runs it; with `workbotTeamSettings` on, an admin can turn it off for everyone
and on for some teams (a pilot), or off for one team.

- **For everyone**: `PUT /v1/org/workbot-settings/everyone` with `{ "enabled": false }` (Manage OpenWork Models
  and a recent sign-in; the body is a strict object so more organization-wide settings can join it). It is
  stored as organization metadata `workbot.enabled`; an absent key means on, and turning it on again removes the
  key, so organizations that never touch it are unchanged. The route answers with the same view as the per-team
  routes, where `organization.enabled` is the organization's value.
- **For a team**: `PUT /v1/org/workbot-settings/teams/{teamId}` with `{ "enabled": { "inherit": false, "value":
  true } }`, or `{ "inherit": true }` to follow the organization again. Stored as `enabled` in the team's row.
- **A member on several teams** follows the same rule as the model and the name: none of their teams sets it,
  the organization's applies; the teams that set it agree, that value applies; they differ, the organization's
  applies. Such members count in `conflictingMemberCount`.

### What it gates

For a member whose Workbot is off:

- **The Workbot app.** `GET /v1/workbot/session` answers `enabled: false` (with the Calendar, documents, the
  workspace assistant and side chats off), which the app shows as "isn't on" for the workspace. Every other
  member route under `/v1/workbot/` refuses them with the answers Den gave while Workbot was off for a whole
  workspace: `403 workbot_not_enabled` (run token, connections, model recovery, the Get set up checklist and its
  events), `403 workbot_calendar_not_enabled` (Calendar), `403 workbot_documents_not_enabled` (documents) and
  `404 feature_disabled` (connecting an account from Workbot). Content-free telemetry is still recorded, so a
  turn that was running when the switch changed completes its record.
- **Your agent.** Their agent is not woken: no check, no brief and no message. The worker asks before each wake
  and again before each message, so a switch turned off mid-check stops the message. `GET`/`PUT /v1/me/agent`
  and `GET /v1/me/agent/checks` answer `404 feature_disabled` (`feature: "workbot"`), as on a deployment
  without Workbot, and the agent's `request_check` tool answers "Extra checks aren't on for this member."
- **Den web's entry points.** `GET /v1/org/workbot-readiness` adds `enabled: false` for that caller; the field
  is absent when Workbot is on. Den web then keeps its entries visible but locked, with the reason, instead of
  sending the member to an app that would say it is off: the Workbot item in the sidebar and the command palette
  open a dialog ("Workbot is off for your team. An admin can turn it on in Members › Teams.", with a link there
  for people who can change Workbot's settings), Manage › Workbot's "Open Workbot" action is locked with the
  same reason, and My bot shows that it is off instead of failing to load. Old links to Den's `/workbot` still
  redirect to the app, which says it is off.

### What it does not gate

- The Slack assistant, Automations (desktop and cloud, including the ones made in Workbot's Calendar, which keep
  running) and the desktop app. The switch is for Workbot's own chat app and its agent only.
- The admin routes under `/v1/org/workbot-settings`. An admin whose own Workbot is off can still read and
  change every setting, including turning Workbot back on.
- Model access. The switch grants nothing; a member with Workbot on still needs their own access to a model.

### Turning the feature off

Everyone has Workbot again, on each member's next request. The organization's `workbot.enabled` and the teams'
`enabled` values are **kept but ignored**, exactly like the model and the name, and apply again when the
feature is turned back on. With the feature off the team rows are not read at all.

### Verification

`ee/apps/den-api/test/workbot-team-settings.test.ts` covers the switch's resolution, conflicts, stored shape,
write schema and the organization metadata; `ee/apps/den-api/test/api/workbot-team-settings.api.test.ts` covers
`PUT /v1/org/workbot-settings/everyone` (permissions, invalid bodies, feature off), what the session and every
other `/v1/workbot/` route answer a member with Workbot off, a team on while the organization is off, two teams
that differ, the readiness field, My agent, `request_check` and the worker's per-member check.

## Members' agents per team

The same feature adds a fifth group, `agent`: the policy for members' agents ("Your agent",
`docs/features/workbot-proactive`). Today that policy is organization-wide. With `workbotTeamSettings` and
`workbotProactive` both on, a team either follows Everyone's policy or has **its own complete one**.

### What a team's own policy covers

Everything Manage › Workbot sets for members' agents, as one unit: on or off, working days and hours, the daily
limit, whether members start opted in, the destination, what agents may read (`sources`, with the allowed and
default connections and, with `workbotAgentBrief`, the per-tool choices), the brief and its rhythm (with
`workbotAgentBrief`), and the "Your agent" template (responsibilities and instructions). A team cannot override
one field and follow Everyone for the rest: its first save copies Everyone's policy and template as they are at
that moment, and from then on the team no longer follows Everyone's changes. Members' own choices (on or off,
snooze, mutes, their sources and lines) are kept and apply inside whichever policy they are under.

- `GET /v1/org/workbot-settings/teams/{teamId}/agent`: the same view as `GET /v1/org/workbot-settings/proactive`
  plus `inherit`. While the team follows Everyone it returns Everyone's policy and template with `inherit: true`,
  so the controls can show them. View OpenWork Models settings or Manage OpenWork Models.
- `PUT /v1/org/workbot-settings/teams/{teamId}/agent`: the same body and the same checks as
  `PUT /v1/org/workbot-settings/proactive` (a sources change is checked against the organization's connections in
  the same way, so a team's policy never reads a connection the organization's checks would refuse; `brief`
  answers 400 while `workbotAgentBrief` is off). The change is merged onto the team's own policy, or onto
  Everyone's for a team that had none. Manage OpenWork Models.
- `PUT /v1/org/workbot-settings/teams/{teamId}` with `{ "agent": { "inherit": true } }` removes the team's own
  policy; it accepts nothing else for `agent`.
- `GET /v1/org/workbot-settings/teams/{teamId}/agent/sources/{connectionId}/tools`: a connection's tools under the
  team's per-tool choices (the organization's route answers for Everyone's policy only).
- `GET /v1/org/workbot-settings/teams` adds `organization.agentEnabled` and, per team,
  `agent: { inherit, enabled }`, both only while `workbotProactive` is on. `enabled` is whether agents are on
  under the policy the team has now.

The policy and the template are stored together in the team's `workbot_team_setting` row (`settings.agent`), so
they are saved, removed and deleted with the team as one. The template keeps the organization's version
semantics without a config object per team: `version` starts at 1 when the team's own policy is created and each
save that changes responsibilities or instructions adds one and gives it a new `versionId`, which is what
`agent_instance.template_version_id` records for a member who ran it.

### A member on several teams

The same rule as every other setting, applied to the whole policy:

1. None of the member's teams has its own policy: Everyone's applies.
2. The teams that have one all hold the same policy and template: it applies. Two policies are the same when
   their content is, whatever the order they were saved in; template versions are not compared.
3. They hold different ones: Everyone's applies. Such members count in `conflictingMemberCount`.

Den resolves it in one place, `resolveMemberAgentPolicy` (`ee/apps/den-api/src/workbot/team-settings.ts`), from
the same team read as the member's other Workbot settings. Everything that acts for one member uses it: each
wake of their agent (today's agent and the brief's check), My agent (`GET`/`PUT /v1/me/agent`), the agent's
`request_check` tool, and the sources "Not allowed" for chat turns (`POST /v1/workbot/run-token`). A member only
ever gets their own teams' policy or Everyone's. Still Everyone's: `GET`/`PUT /v1/org/workbot-settings/proactive`
and its tools route, the health counters, connected-member counts and feature outcomes.

### Discovery

The agents' worker gives an agent to the active members of organizations where Everyone's policy is on (as
before), and, with one more query over the team rows, of organizations that have `workbotTeamSettings` on and at
least one team whose own policy is on. So a team can pilot agents while they are off for everyone. Each member's
own policy then decides every wake, exactly as Everyone's switch does: a member whose policy is off gets no
check, no brief and no message. Daily limits, counters, health rows and told-once records stay per member and
per organization.

### In Den web

Under the rows of the Workbot tab, a **Members' agents** section, shown only while the list carries `agent`
(`workbotProactive` on, on a deployment with Workbot). It is the section Manage › Workbot shows (the switch,
where messages go, hours and limits, the brief or the message types, "What agents read" and, with
`workbotAgentBrief`, "Tools agents may use"), bound to a scope: the same components and hooks read and save
Everyone's policy or one team's (`workbot-agent-scope.ts` maps a scope to its routes and query keys; a team's keys
sit under Everyone's, so a change to Everyone's policy refreshes the teams that follow it).

- **A team's page**: the heading carries the chip, "From Everyone" or "Changed for {team}". The controls show
  Everyone's settings until one is changed; that change is saved to the team's route and gives the team its own
  copy of all of them. Each control saves the way it does on Manage › Workbot. "Use Everyone's", beside the chip
  while the team has its own, removes the copy without a confirmation and shows "Saved. This team uses Everyone's
  settings for members' agents." with Undo. Undo saves the team's settings back: what it had, written as a change
  to Everyone's current policy (`agentPolicyRestoreChange`), so every choice returns; only the template's version
  count starts again. The switch reads "Agents for this team".
- **Everyone's page**: the same section for Everyone's policy, the same value and save as Manage › Workbot, with
  "Changed for {team}" or "Changed for N teams" when teams have their own, and a link to the last 7 days on
  Manage › Workbot. That table counts every member whatever their team, so it stays there.
- The line about members on teams with different settings now counts members' agents too. "N teams have their own
  Workbot settings" on Manage › Workbot counts a team that has only its own members' agents.

Without Manage OpenWork Models the section's controls are disabled, under the tab's one "Read only" notice. With
`workbotTeamSettings` off there is no section and no request for it, and Manage › Workbot is unchanged.

### Turning the feature off

Team policies are **kept but ignored**: with `workbotTeamSettings` off the team rows are not read, discovery no
longer counts them, and every member is back on Everyone's policy at their next wake (and on their next My agent
request). The team routes answer 404 `feature_disabled`. Turning it back on restores the saved policies. With
`workbotProactive` off the team's policy is kept, hidden from the list and not counted in conflicts, and
`agent` on the team's change answers 400.

### Verification

`ee/apps/den-api/test/workbot-team-settings.test.ts` covers the stored shape, what makes two policies the same,
resolution, conflicts, the change schema and `resolveMemberAgentPolicy` with its fallbacks;
`test/workbot-proactive.test.ts` and `test/workbot-agent-brief.test.ts` cover the wake under a team's policy;
`test/api/workbot-team-settings.api.test.ts` covers the routes (following Everyone, the first save, the same
refusals as the organization's route, `inherit`, permissions, both features off), My agent for a member of a team
with its own policy and of two teams that differ, discovery through a team's row, and the worker's wake decision.
In Den web, `workbot-proactive-section.test.tsx` covers a scope's routes and query keys, the team's switch label
and the Undo change (merged onto Everyone's policy it gives the team's back);
`workbot-team-settings-presentation.test.ts` covers when the section shows, its chip, the counts and the lines
after "Use Everyone's" and its Undo.

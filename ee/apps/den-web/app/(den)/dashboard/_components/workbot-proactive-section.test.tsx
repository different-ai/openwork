import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AGENT_BRIEF,
  DEFAULT_AGENT_TEMPLATE,
  DEFAULT_WORKBOT_PROACTIVE_SETTINGS,
  mergeAgentTemplate,
  mergeWorkbotProactiveSettings,
  type AgentResponsibility,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive";
import {
  agentPolicyPath,
  agentPolicyQueryKey,
  agentPolicyRestoreChange,
  agentsSwitchLabel,
  agentToolsPath,
  agentToolsQueryKey,
  agentToolsRootQueryKey,
  type AgentPolicyScope,
} from "./workbot-agent-scope";
import { WorkbotProactivePanel } from "./workbot-proactive-section";
import { previewTime } from "./workbot-proactive-preview";
import { WorkbotProactiveHealthTable } from "./workbot-proactive-health";
import { addSourceChange, addableTo, allowAppChange, coreAppRows, makeDefaultChange, removeSourceChange, WorkbotProactiveSources } from "./workbot-proactive-sources";

const ready: WorkbotProactiveView = {
  settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, enabled: true },
  template: { ...DEFAULT_AGENT_TEMPLATE, versionId: null, version: 1 },
  slackReady: true,
  runnerReady: true,
  sourceConnections: {
    calendar: [{ id: "google-workspace", name: "Google Calendar", url: "https://google.com", connectedMembers: 4 }],
    email: [{ id: "google-workspace", name: "Gmail", url: "https://google.com", connectedMembers: 4 }],
    chat: [{ id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", connectedMembers: null }],
    other: [
      { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp" },
      { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp" },
    ],
    all: [
      { id: "google-workspace", name: "Google Workspace", url: "https://google.com", native: true, slots: ["calendar", "email"], connectedMembers: 4 },
      { id: "emc_slack", name: "Slack", url: "https://mcp.slack.com/mcp", native: false, slots: ["calendar", "email", "chat", "other"], connectedMembers: null },
      { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp", native: false, slots: ["calendar", "email", "chat", "other"], connectedMembers: null },
      { id: "emc_tracker", name: "Issue tracker", url: "https://mcp.linear.app/mcp", native: false, slots: ["calendar", "email", "chat", "other"], connectedMembers: null },
    ],
    defaults: { calendar: "google-workspace", email: "google-workspace", chat: "emc_slack" },
  },
};

function render(view: WorkbotProactiveView = ready, options: { canManage?: boolean; preview?: AgentResponsibility } = {}) {
  return renderToStaticMarkup(
    <WorkbotProactivePanel view={view} canManage={options.canManage ?? true} saving={false} onChange={() => undefined}
      connectorsHref="/dashboard/mcp-connections" initialPreview={options.preview} />,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function switchFor(html: string, label: string) {
  return new RegExp(`<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? null;
}

test("every setting is one labelled row with its current value, and nothing explains the page", () => {
  const view = text(render());
  for (const label of ["Agents for everyone", "Send messages to", "Morning brief", "Meeting prep", "Calendar changes", "Waiting on you", "Instructions for every agent", "Working hours", "Daily limit", "Members start", "Preview"]) {
    assert.ok(view.includes(label), label);
  }
  for (const value of ["A DM from Workbot", "15 min before", "Version 1", "Weekdays", "8 AM", "7 PM", "3 per person", "Opted in"]) assert.ok(view.includes(value), value);
  assert.match(switchFor(render(), "Agents for everyone") ?? "", /aria-checked="true"/);
  assert.match(switchFor(render(), "Waiting on you") ?? "", /aria-checked="true"/);
  assert.doesNotMatch(view, /Needs|first\./, "no lock when everything is ready");
});

test("the preview is a plain-text DM from the Workbot app, with no buttons, and follows the lead time", () => {
  assert.match(text(render()), /OpenWork 8:02 AM/);
  assert.match(text(render(ready, { preview: "meeting_prep" })), /Quarterly review starts in 15 min, with 2 people from northwind\.example\./);
  assert.match(text(render({ ...ready, settings: { ...ready.settings, leadMinutes: 60 } }, { preview: "meeting_prep" })), /starts in 1 hour/);
  assert.equal(previewTime("meeting_prep", 30), "1:30 PM");
  assert.match(text(render(ready, { preview: "waiting_on_you" })), /has waited 5 hours for your reply\. Want a draft\? Ask Workbot\./);
  assert.match(text(render()), /3 meetings today, first at 9:30 AM\./);
  const preview = /data-testid="workbot-proactive-preview"[\s\S]*$/.exec(render())?.[0] ?? "";
  assert.doesNotMatch(preview, /<button/, "no Mute, Snooze or Turn off buttons in the message");
});

test("without the Slack app the switch is locked with the reason and where to fix it", () => {
  const html = render({ ...ready, settings: DEFAULT_WORKBOT_PROACTIVE_SETTINGS, slackReady: false });
  assert.match(text(html), /Needs the Slack app\. Set it up in Connectors/);
  assert.match(text(html), /Needs the Slack app first\./);
  assert.match(html, /href="\/dashboard\/mcp-connections"/);
  assert.match(switchFor(html, "Agents for everyone") ?? "", /disabled=""/);
});

test("with nowhere to send messages the switch says to choose a destination first", () => {
  const html = render({ ...ready, settings: { ...DEFAULT_WORKBOT_PROACTIVE_SETTINGS, destination: null } });
  assert.match(text(html), /Choose where messages go first\./);
  assert.match(text(html), /Nowhere yet/);
});

test("without the headless runner the switch says who can fix it", () => {
  const html = render({ ...ready, settings: { ...ready.settings, enabled: false }, runnerReady: false });
  assert.match(text(html), /Needs the headless runner\. Ask your deployment administrator\./);
  assert.match(switchFor(html, "Agents for everyone") ?? "", /disabled=""/);
});

test("a turned-off responsibility hides its own options, and viewers see every value but can't change any", () => {
  const off = text(render({ ...ready, template: { ...ready.template, responsibilities: { ...ready.template.responsibilities, meeting_prep: false } } }));
  assert.doesNotMatch(off, /15 min before/);
  const html = render(ready, { canManage: false });
  for (const label of ["Agents for everyone", "Calendar changes", "Morning brief"]) assert.match(switchFor(html, label) ?? "", /disabled=""/, label);
  assert.ok(text(html).includes("15 min before"));
});

test("the health table shows checks, the share that stayed quiet, messages and mutes per responsibility", () => {
  const html = renderToStaticMarkup(
    <WorkbotProactiveHealthTable health={{ days: 7, members: 12, responsibilities: [
      { id: "calendar_changes", checks: 240, quiet: 228, sent: 12, muted: 1 },
      { id: "waiting_on_you", checks: 0, quiet: 0, sent: 0, muted: 0 },
    ] }} />,
  );
  const view = text(html);
  assert.match(view, /Responsibility Checks Stayed quiet Messages Muted by/);
  assert.match(view, /Calendar changes 240 95% 12 1 of 12/);
  assert.match(view, /Waiting on you 0 — 0 0 of 12/);
});

function sources(view: WorkbotProactiveView = ready, canManage = true) {
  return renderToStaticMarkup(<WorkbotProactiveSources view={view} canManage={canManage} saving={false} onChange={() => undefined} />);
}

function row(html: string, testId: string) {
  return text(new RegExp(`data-testid="${testId}"[\\s\\S]*?(?=data-testid="workbot-source-|$)`).exec(html)?.[0] ?? "");
}

function withSources(view: WorkbotProactiveView, change: Partial<WorkbotProactiveView["settings"]["sources"]>): WorkbotProactiveView {
  return { ...view, settings: { ...view.settings, sources: { ...view.settings.sources, ...change } } };
}

const legacy = { id: "google-workspace", name: "Google Workspace", url: "https://google.com", connectedMembers: 2 };
const personal = { id: "gws_personal", name: "Google Workspace - Personal", url: "https://google.com", connectedMembers: 0 };
const microsoft = { id: "m365_main", name: "Microsoft 365", url: "https://microsoft.com", connectedMembers: 9 };

/** Google Workspace and Microsoft 365 both serve calendar and email; Microsoft 365 is the default most members use. */
const twoApps: WorkbotProactiveView = { ...ready, sourceConnections: {
  calendar: [legacy, microsoft], email: [legacy, microsoft], chat: [microsoft], other: [],
  all: [
    { ...legacy, native: true, slots: ["calendar", "email"] },
    { ...microsoft, native: true, slots: ["calendar", "email", "chat"] },
    { id: "emc_notes", name: "Meeting notes", url: "https://mcp.granola.ai/mcp", native: false, slots: ["calendar", "email", "chat", "other"], connectedMembers: null },
  ],
  defaults: { calendar: microsoft.id, email: microsoft.id, chat: microsoft.id },
} };

test("what agents read: each category with what members use, its apps, Add source, and Other context with each connection's policy", () => {
  const html = sources();
  const view = text(html);
  assert.match(view, /What agents read/);
  assert.match(row(html, "workbot-source-calendar"), /Calendar Everyone uses Google Workspace On for everyone/);
  assert.match(row(html, "workbot-source-calendar-google-workspace"), /Google Workspace Default 4 connected/);
  assert.match(switchFor(html, "Allow Google Workspace") ?? "", /aria-checked="true"/);
  assert.match(row(html, "workbot-source-chat-emc_slack"), /Slack Default/);
  assert.doesNotMatch(row(html, "workbot-source-chat-emc_slack"), /connected/, "a shared connection: no member count");
  assert.match(html, /aria-label="Add source to Calendar"/);
  assert.match(html, /aria-label="Add source to Other context"/);
  assert.match(row(html, "workbot-source-other-emc_notes"), /Meeting notes Members choose Remove/);
  assert.match(row(html, "workbot-source-other-emc_tracker"), /Issue tracker Members choose Remove/);
  assert.match(view, /Read only\. Agents never send, edit or delete through these\./);
});

test("what agents read: with two apps allowed, members pick; the default has a badge and its switch waits for another default", () => {
  const html = sources(twoApps);
  const calendar = row(html, "workbot-source-calendar");
  assert.match(calendar, /Calendar Members use Google Workspace or Microsoft 365 On for everyone/);
  assert.match(row(html, "workbot-source-calendar-m365_main"), /Microsoft 365 Default 9 connected/);
  assert.match(row(html, "workbot-source-calendar-google-workspace"), /Google Workspace 2 connected Make default/);
  assert.doesNotMatch(row(html, "workbot-source-calendar-m365_main"), /Make default/, "the default isn't offered as default again");
  assert.match(html, /aria-label="Make Google Workspace the default for Calendar"/);
  const defaultSwitch = /data-testid="workbot-source-calendar-m365_main"[\s\S]*?<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(defaultSwitch, /aria-label="Allow Microsoft 365"/);
  assert.match(defaultSwitch, /disabled=""/, "choose another default before turning the default off");
  const otherSwitch = /data-testid="workbot-source-calendar-google-workspace"[\s\S]*?<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";
  assert.doesNotMatch(otherSwitch, /disabled=""/);
  assert.deepEqual(makeDefaultChange("calendar", legacy.id), { coreDefaults: { calendar: legacy.id } });
  assert.deepEqual(allowAppChange(twoApps, "calendar", legacy.id, false), { coreConnections: { calendar: [microsoft.id] } }, "an explicit list without Google");
  const onlyMicrosoft = withSources(twoApps, { coreConnections: { calendar: [microsoft.id] } });
  assert.match(row(sources(onlyMicrosoft), "workbot-source-calendar"), /Everyone uses Microsoft 365/);
  assert.match(switchFor(sources(onlyMicrosoft), "Allow Google Workspace") ?? "", /aria-checked="false"/, "a disallowed app keeps its row, switched off");
  assert.deepEqual(allowAppChange(onlyMicrosoft, "calendar", legacy.id, true), { coreConnections: { calendar: null } }, "every app that serves it again: back to automatic");
  const adminDefault = withSources(twoApps, { coreDefaults: { calendar: legacy.id } });
  assert.deepEqual(coreAppRows(adminDefault, "calendar").map((entry) => [entry.option.id, entry.isDefault]), [[legacy.id, true], [microsoft.id, false]], "the admin's default wins over the automatic one at once");
  assert.match(row(sources(withSources(twoApps, { coreConnections: { calendar: [] } })), "workbot-source-calendar"), /No apps allowed/);
});

test("what agents read: a category header shows a generic icon, never an app logo", () => {
  const html = sources(twoApps);
  for (const kind of ["calendar", "email", "chat"]) {
    const header = new RegExp(`data-testid="workbot-source-${kind}"[\\s\\S]*?data-testid="workbot-category-state-${kind}"`).exec(html)?.[0] ?? "";
    assert.ok(header.length > 0, kind);
    assert.doesNotMatch(header, /<img/, `${kind}: no app logo on the category`);
    assert.match(header, /<svg/, `${kind}: its generic icon`);
  }
  assert.match(/data-testid="workbot-source-calendar-m365_main"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "", /<img|<svg/, "each app row has its logo");
});

test("what agents read: a legacy and a newer Google Workspace are both listed and allowed one at a time", () => {
  const two: WorkbotProactiveView = { ...ready, sourceConnections: {
    calendar: [legacy, personal], email: [legacy, personal], chat: [], other: [],
    all: [
      { ...legacy, native: true, slots: ["calendar", "email"] },
      { ...personal, native: true, slots: ["calendar", "email"] },
    ],
    defaults: { calendar: legacy.id, email: legacy.id, chat: null },
  } };
  const html = sources(two);
  assert.match(row(html, "workbot-source-calendar-google-workspace"), /Google Workspace Default 2 connected/);
  assert.match(row(html, "workbot-source-calendar-gws_personal"), /Google Workspace - Personal 0 connected Make default/);
  assert.deepEqual(allowAppChange(two, "calendar", personal.id, false), { coreConnections: { calendar: [legacy.id] } }, "Calendar only");
  assert.deepEqual(removeSourceChange(two, "calendar", legacy.id), { coreConnections: { calendar: [personal.id] } });
  assert.match(text(sources({ ...two, sourceConnections: two.sourceConnections && { ...two.sourceConnections, calendar: [], email: [], chat: [] } })), /Team chat No apps allowed On for everyone/);
});

test("what agents read: Add source lists every connection not already there, and adds it at once", () => {
  assert.deepEqual(addableTo(ready, "calendar").map((option) => option.id), ["emc_slack", "emc_notes", "emc_tracker"]);
  assert.deepEqual(addableTo(ready, "chat").map((option) => option.id), ["emc_notes", "emc_tracker"], "Google can't serve team chat");
  assert.deepEqual(addableTo(ready, "other").map((option) => option.id), ["emc_slack"]);
  assert.deepEqual(addSourceChange(ready, "email", "emc_notes"), { coreConnections: { email: ["google-workspace", "emc_notes"] } });
  const added = withSources(ready, { coreConnections: { calendar: ["google-workspace", "emc_notes"] } });
  assert.match(row(sources(added), "workbot-source-calendar-emc_notes"), /Meeting notes Read on checks; no early meeting alerts Make default/, "only Google's calendar wakes the agent early");
  assert.deepEqual(addableTo(added, "calendar").map((option) => option.id), ["emc_slack", "emc_tracker"], "an app with a row there isn't offered again");
  assert.deepEqual(allowAppChange(added, "calendar", "emc_notes", false), { coreConnections: { calendar: null } }, "stopping the added one: back to what serves it");
  assert.deepEqual(removeSourceChange(ready, "other", "emc_notes"), { otherConnections: ["emc_tracker"], connections: { emc_notes: null } });
});

test("what agents read: locked for people who can't manage it, and without View connections", () => {
  const locked = sources(ready, false);
  const buttons = locked.match(/<button[^>]*>/g) ?? [];
  assert.ok(buttons.length > 0 && buttons.every((button) => /disabled=""/.test(button)), "every choice, switch, Make default, Remove and Add source are locked without Manage");
  const policy = withSources(ready, { email: "members", chat: "off", connections: { emc_tracker: "off" } });
  const html = sources(policy);
  assert.match(row(html, "workbot-source-email"), /Members choose/);
  assert.match(row(html, "workbot-source-chat"), /Team chat Agents don't read it Not allowed/);
  assert.doesNotMatch(html, /workbot-source-chat-emc_slack/, "no app rows while it's not allowed");
  assert.match(row(html, "workbot-source-other-emc_tracker"), /Not allowed/);
  const hidden = text(sources({ ...ready, sourceConnections: null }));
  assert.match(hidden, /Calendar Google Calendar or Outlook On for everyone/, "without View connections: what each source reads through, not the organization's connections");
  assert.match(hidden, /Sources: Needs the “.+” permission\./);
  assert.doesNotMatch(hidden, /Meeting notes|Issue tracker|Add source/);
});

// ---- Your agent's brief (workbotAgentBrief) -------------------------------------------------------------------------

const briefSettings: NonNullable<WorkbotProactiveView["brief"]> = { checkEveryHours: 2, dailyCap: 4, extraChecksPerDay: 3, text: `${DEFAULT_AGENT_BRIEF}\n\nDon't send meeting prep.`, defaultText: DEFAULT_AGENT_BRIEF, carriedOver: ["text"] };
const briefOn: WorkbotProactiveView = { ...ready, brief: briefSettings };

test("with the brief: one rhythm, the daily limit, extra checks and what to tell people replace the message types", () => {
  const html = render(briefOn);
  const view = text(html);
  for (const label of ["Agents for everyone", "Send messages to", "Check", "Messages per person per day", "Extra checks agents may ask for", "Members start", "What to tell people", "Preview"]) assert.ok(view.includes(label), label);
  for (const value of ["Every 2 hours", "8 AM", "7 PM", "Weekdays", "3 a day", "Reset to default", "From your earlier settings."]) assert.ok(view.includes(value), value);
  for (const gone of ["Morning brief", "Meeting prep", "Calendar changes", "Waiting on you", "15 min before", "Instructions for every agent", "Version 1"]) assert.ok(!view.includes(gone), gone);
  assert.match(html, /Don&#x27;t send meeting prep\.<\/textarea>/);
  assert.match(view, /Before your 2 PM with Northwind Labs: Dana asked in Slack for the updated pricing sheet/);
});

test("with the brief at its default, it says Default instead of offering a reset", () => {
  const view = text(render({ ...briefOn, brief: { ...briefSettings, text: DEFAULT_AGENT_BRIEF, carriedOver: [] } }));
  assert.ok(view.includes("Default"));
  assert.ok(!view.includes("Reset to default"));
  assert.ok(!view.includes("From your earlier settings."));
});

test("with the brief, health is one row of checks on the rhythm", () => {
  const html = renderToStaticMarkup(<WorkbotProactiveHealthTable health={{ days: 7, members: 5, responsibilities: [], rhythm: { checks: 120, quiet: 96, sent: 31 } }} />);
  assert.match(text(html), /All members 120 80% 31/);
  assert.doesNotMatch(text(html), /Muted by/);
});

// ---- Everyone's policy, or one team's (workbotTeamSettings) ---------------------------------------------------------

const everyoneScope: AgentPolicyScope = { kind: "everyone" };
const supportScope: AgentPolicyScope = { kind: "team", teamId: "team/a" };

test("Everyone's policy keeps the organization's routes and keys; a team's has its own under them", () => {
  assert.equal(agentPolicyPath(everyoneScope), "/v1/org/workbot-settings/proactive");
  assert.equal(agentToolsPath(everyoneScope, "emc notes"), "/v1/org/workbot-settings/proactive/sources/emc%20notes/tools");
  assert.deepEqual(agentPolicyQueryKey("org_1", everyoneScope), ["org-workbot-proactive", "org_1"]);
  assert.deepEqual(agentToolsQueryKey("org_1", "emc_notes", everyoneScope), ["org-workbot-agent-tools", "org_1", "emc_notes"]);

  assert.equal(agentPolicyPath(supportScope), "/v1/org/workbot-settings/teams/team%2Fa/agent");
  assert.equal(agentToolsPath(supportScope, "emc notes"), "/v1/org/workbot-settings/teams/team%2Fa/agent/sources/emc%20notes/tools");
  const teamKey = agentPolicyQueryKey("org_1", supportScope);
  const teamToolsKey = agentToolsQueryKey("org_1", "emc_notes", supportScope);
  assert.deepEqual(teamKey, ["org-workbot-proactive", "org_1", "teams", "team/a"]);
  assert.deepEqual(teamToolsKey, ["org-workbot-agent-tools", "org_1", "emc_notes", "teams", "team/a"]);
  // A change to Everyone's policy refreshes everything under its key: the teams that follow it too.
  assert.deepEqual(teamKey.slice(0, 2), agentPolicyQueryKey("org_1", everyoneScope));
  assert.deepEqual(teamToolsKey.slice(0, 3), agentToolsQueryKey("org_1", "emc_notes", everyoneScope));
  assert.deepEqual(teamToolsKey.slice(0, 2), agentToolsRootQueryKey("org_1"));
  assert.notDeepEqual(agentPolicyQueryKey("org_1", { kind: "team", teamId: "team_b" }), teamKey);
});

test("a team's panel has the same rows, and its switch is for the team", () => {
  assert.equal(agentsSwitchLabel(everyoneScope), "Agents for everyone");
  assert.equal(agentsSwitchLabel(supportScope), "Agents for this team");
  for (const view of [ready, briefOn]) {
    const html = renderToStaticMarkup(
      <WorkbotProactivePanel view={view} canManage saving={false} onChange={() => undefined} connectorsHref="/dashboard/mcp-connections" scope={supportScope} />,
    );
    assert.match(switchFor(html, "Agents for this team") ?? "", /aria-checked="true"/);
    assert.ok(!text(html).includes("Agents for everyone"));
    assert.equal(text(html).replace("Agents for this team", "Agents for everyone"), text(render(view)));
  }
});

test("Undo for Use Everyone's saves the team's policy back as a change to Everyone's", () => {
  const everyone: WorkbotProactiveView = {
    ...briefOn,
    settings: {
      ...ready.settings,
      enabled: false,
      sources: {
        calendar: "everyone",
        email: "everyone",
        chat: "everyone",
        coreConnections: { chat: ["emc_slack"] },
        coreDefaults: { calendar: "google-workspace" },
        otherConnections: ["emc_notes"],
        connections: { emc_notes: "everyone", emc_tracker: "off" },
        toolOverrides: { emc_notes: { search: "allow", remove: "deny" }, emc_tracker: { list: "allow" } },
      },
      brief: { dailyCap: 6 },
    },
    brief: { ...briefSettings, dailyCap: 6, carriedOver: ["checkEveryHours", "extraChecksPerDay", "text"] },
  };
  const team: WorkbotProactiveView = {
    ...briefOn,
    settings: {
      ...ready.settings,
      enabled: true,
      workingDays: "everyday",
      startHour: 9,
      endHour: 17,
      dailyCap: 5,
      membersStart: "opted_out",
      sources: {
        calendar: "members",
        email: "off",
        chat: "everyone",
        coreConnections: { calendar: ["google-workspace"] },
        otherConnections: ["emc_notes", "emc_tracker"],
        connections: { emc_notes: "off" },
        toolOverrides: { emc_notes: { search: "deny", read: "allow" } },
      },
      brief: { checkEveryHours: 3, text: "Only tell people about customers." },
    },
    template: { ...ready.template, responsibilities: { ...ready.template.responsibilities, meeting_prep: false }, instructions: "Ignore newsletters.", version: 4, versionId: "cov_team" },
    brief: { ...briefSettings, checkEveryHours: 3, dailyCap: 5, text: "Only tell people about customers.", carriedOver: ["dailyCap", "extraChecksPerDay"] },
  };

  const change = agentPolicyRestoreChange(team, everyone);
  // Only what differs is sent for sources: null takes away what Everyone has and the team didn't.
  assert.deepEqual(change.sources, {
    calendar: "members",
    email: "off",
    chat: "everyone",
    coreConnections: { calendar: ["google-workspace"], chat: null },
    coreDefaults: { calendar: null },
    otherConnections: ["emc_notes", "emc_tracker"],
    connections: { emc_notes: "off", emc_tracker: null },
    toolOverrides: { emc_notes: { search: "deny", remove: null, read: "allow" }, emc_tracker: null },
  });
  // The team's first save starts from Everyone's policy: the change on top of it is the team's policy again.
  const restored = mergeWorkbotProactiveSettings(everyone.settings, change);
  assert.deepEqual(restored, { ...team.settings, brief: { checkEveryHours: 3, dailyCap: 5, text: "Only tell people about customers." } });
  assert.deepEqual(mergeAgentTemplate(everyone.template, change), { responsibilities: team.template.responsibilities, instructions: "Ignore newsletters." });

  // The same policy as Everyone's still makes it the team's own, and sends nothing the server could refuse.
  const same = agentPolicyRestoreChange(everyone, everyone);
  assert.deepEqual(same.sources, { calendar: "everyone", email: "everyone", chat: "everyone" });
  assert.equal(same.enabled, false);
  // With the brief off the server refuses `brief`, so it is left out.
  assert.equal(agentPolicyRestoreChange(ready, ready).brief, undefined);
  assert.deepEqual(agentPolicyRestoreChange(everyone, everyone).brief, { dailyCap: 6 });
});

// ---- Grouped rows (workbotSettingsTabs) ---------------------------------------------------------------------------

function renderGrouped(view: WorkbotProactiveView) {
  return renderToStaticMarkup(
    <WorkbotProactivePanel view={view} canManage saving={false} onChange={() => undefined} connectorsHref="/dashboard/mcp-connections" grouped />,
  );
}

test("grouped: yes or no settings are switches, the schedule is one row per setting, and each row has help", () => {
  const html = renderGrouped(briefOn);
  const view = text(html);
  for (const label of ["Agents for everyone", "On for members by default", "Messages", "Send messages in Slack", "Daily message limit", "Schedule", "Check for updates", "Working hours", "Working days", "Extra checks", "What to tell people", "Preview"]) assert.ok(view.includes(label), label);
  for (const gone of ["Send messages to", "Nowhere yet", "Members start", "Must opt in", "Messages per person per day", "Extra checks agents may ask for"]) assert.ok(!view.includes(gone), gone);
  assert.match(switchFor(html, "Send messages in Slack") ?? "", /aria-checked="true"/);
  assert.match(switchFor(html, "On for members by default") ?? "", /aria-checked="true"/);
  for (const about of ["On for members by default", "Send messages in Slack", "Daily message limit", "Check for updates", "Working hours", "Working days", "Extra checks"]) assert.ok(html.includes(`aria-label="About ${about}"`), about);
});

test("grouped: with messages going nowhere and members opting in themselves, both switches are off", () => {
  const html = renderGrouped({ ...briefOn, settings: { ...briefOn.settings, enabled: false, destination: null, membersStart: "opted_out" } });
  assert.match(switchFor(html, "Send messages in Slack") ?? "", /aria-checked="false"/);
  assert.match(switchFor(html, "On for members by default") ?? "", /aria-checked="false"/);
  assert.ok(text(html).includes("Turn on Send messages in Slack first."));
});

test("grouped rows need the brief: without it the message types stay as they are", () => {
  assert.ok(text(renderGrouped(ready)).includes("Send messages to"));
});
